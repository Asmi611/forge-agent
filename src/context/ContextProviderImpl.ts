/**
 * ContextProviderImpl.ts -- the functions the engine's tools call: search, find a symbol, project map,
 * resolve @mentions, and the automatic "seed" of relevant code. No VS Code in here: it talks to a
 * FileSource and a WorkspaceIndex, so it is unit tested with in-memory files.
 *
 * Promises: every method NEVER throws (a problem gives an empty answer), a path can never leave the
 * workspace, and the seed never goes over its token budget.
 * No project-specific words appear in this folder.
 */
import type { ContextItem, ContextProvider, ResolvedMention } from '../types/contract';
import { estimateTokens } from './budget';
import type { FileSource, WorkspaceIndex } from './indexer';
import { buildOutline, parseMentions, stripMentions } from './mentions';
import { DEFAULT_RANKER_CONFIG, rank, snippetRange, type RankedFile, type RankerConfig } from './ranker';
import { renderRepoMap } from './repoMap';

export interface ProviderConfig { ranker: RankerConfig; seedBudgetTokens: number }
export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = { ranker: DEFAULT_RANKER_CONFIG, seedBudgetTokens: 3000 };

export interface ProviderOptions {
  source: FileSource;
  index: WorkspaceIndex;
  /** Resolves when the index is usable (the first build is finished). Defaults to "already ready". */
  ready?: () => Promise<void>;
  /** Read at every call, so changed settings apply at once. */
  config?: () => ProviderConfig;
}

// Hard caps (docs/01 section 3 and docs/04).
const SEARCH_MAX_HITS = 20;
const SEARCH_PREVIEW_CHARS = 160;
const SEARCH_SCAN_LIMIT = 2000;
const SYMBOL_MAX = 10;
const MENTION_FILE_MAX_LINES = 400;
const MENTION_SYMBOL_MAX_LINES = 80;
const REPO_MAP_MAX_TOKENS = 1500;
const SEED_MAP_MAX_TOKENS = 500;
const REGEX_MAX_LENGTH = 200;
const LINE_TEST_MAX_CHARS = 1000;

/** Workspace-relative, forward slashes, no "..", no absolute path, no drive letter. */
export function isInsidePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) return false;
  return path.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A small glob ("**\/*.py", "src/**", "main.py", "tests") as a regular expression over workspace paths. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!/[*?{]/.test(g)) return new RegExp(`(^|/)${escapeRe(g.replace(/\/$/, ''))}(/.*)?$`); // a plain name or folder
  if (!g.includes('/')) g = `**/${g}`;
  let re = '';
  let braces = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') { braces++; re += '(?:'; }
    else if (c === '}' && braces > 0) { braces--; re += ')'; }
    else if (c === ',' && braces > 0) re += '|';
    else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

/** "/pattern/flags" means a regular expression; anything else is plain text, matched without caring about capitals. */
function lineMatcher(query: string): ((line: string) => boolean) | undefined {
  const slashed = /^\/(.+)\/([a-z]*)$/.exec(query);
  if (slashed && (slashed[1] ?? '').length <= REGEX_MAX_LENGTH) {
    try {
      const re = new RegExp(slashed[1] as string, 'i');
      return (line) => re.test(line.length > LINE_TEST_MAX_CHARS ? line.slice(0, LINE_TEST_MAX_CHARS) : line);
    } catch {
      // not a valid pattern: fall through and search for it as plain text
    }
  }
  const needle = query.toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}

const lineSplit = (text: string): string[] => {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/** Implements the contract's ContextProvider on top of the workspace index. */
export class ContextProviderImpl implements ContextProvider {
  constructor(private readonly options: ProviderOptions) {}

  private get config(): ProviderConfig {
    try {
      return this.options.config?.() ?? DEFAULT_PROVIDER_CONFIG;
    } catch {
      return DEFAULT_PROVIDER_CONFIG;
    }
  }

  private async ready(): Promise<void> {
    await this.options.ready?.();
  }

  private async read(path: string): Promise<string | undefined> {
    if (!isInsidePath(path)) return undefined;
    try {
      return await this.options.source.read(path);
    } catch {
      return undefined;
    }
  }

  /** The ranked files for a request, with scores and reasons (also used by the "Show Context Ranking" command). */
  async rankFiles(prompt: string, limit?: number): Promise<RankedFile[]> {
    try {
      await this.ready();
      return rank(stripMentions(prompt), this.options.index, this.config.ranker, limit);
    } catch {
      return [];
    }
  }

  // ───────── search ─────────
  async search(q: { query: string; glob?: string; maxResults?: number }): Promise<{ hits: { path: string; line: number; preview: string }[]; omitted: number }> {
    const empty = { hits: [], omitted: 0 };
    try {
      await this.ready();
      const query = (q.query ?? '').trim();
      if (query === '') return empty;
      const max = Math.min(Math.max(Math.floor(q.maxResults ?? SEARCH_MAX_HITS), 1), SEARCH_MAX_HITS);
      const matches = lineMatcher(query);
      if (!matches) return empty;
      let globRe: RegExp | undefined;
      if (q.glob && q.glob.trim() !== '') {
        try { globRe = globToRegExp(q.glob); } catch { return empty; }
      }

      // Best-ranked files first, then the rest in alphabetical order, so the 20 hits shown are the most useful.
      const all = [...this.options.index.files.keys()].sort();
      const ranked = query.startsWith('/') ? [] : rank(query, this.options.index, this.config.ranker, Math.min(all.length, 500)).map((r) => r.path);
      const order = [...new Set([...ranked, ...all])].filter((p) => !globRe || globRe.test(p));

      const hits: { path: string; line: number; preview: string }[] = [];
      let total = 0;
      const BATCH = 16;
      for (let i = 0; i < order.length && total < SEARCH_SCAN_LIMIT; i += BATCH) {
        const texts = await Promise.all(order.slice(i, i + BATCH).map((p) => this.read(p)));
        texts.forEach((text, k) => {
          if (text === undefined) return;
          const path = order[i + k] as string;
          lineSplit(text).forEach((line, n) => {
            if (!matches(line)) return;
            total++;
            if (hits.length < max) hits.push({ path, line: n + 1, preview: line.trim().slice(0, SEARCH_PREVIEW_CHARS) });
          });
        });
      }
      return { hits, omitted: Math.max(0, total - hits.length) };
    } catch {
      return empty;
    }
  }

  // ───────── symbols ─────────
  async findSymbol(q: { name: string }): Promise<{ symbols: { name: string; path: string; line: number; kind: string }[] }> {
    try {
      await this.ready();
      const needle = (q.name ?? '').trim().toLowerCase();
      if (needle === '') return { symbols: [] };
      const found: { name: string; path: string; line: number; kind: string; tier: number }[] = [];
      for (const f of this.options.index.files.values()) {
        for (const s of f.symbols) {
          const n = s.name.toLowerCase();
          const tier = n === needle ? 0 : n.startsWith(needle) ? 1 : n.includes(needle) ? 2 : 3;
          if (tier < 3) found.push({ name: s.name, path: f.path, line: s.line, kind: s.kind, tier });
        }
      }
      found.sort((a, b) => a.tier - b.tier || Number(isTestLike(a.path)) - Number(isTestLike(b.path)) || a.path.localeCompare(b.path) || a.line - b.line);
      return { symbols: found.slice(0, SYMBOL_MAX).map(({ tier: _tier, ...s }) => s) };
    } catch {
      return { symbols: [] };
    }
  }

  // ───────── project map ─────────
  async repoMap(q: { dir?: string; depth?: number }): Promise<{ tree: string; truncated: boolean }> {
    try {
      await this.ready();
      return renderRepoMap(this.options.index, q.dir, q.depth, REPO_MAP_MAX_TOKENS);
    } catch {
      return { tree: '', truncated: false };
    }
  }

  // ───────── @mentions ─────────
  async resolveMention(raw: string): Promise<ResolvedMention | null> {
    try {
      await this.ready();
      const name = (raw ?? '').trim().replace(/^@/, '').replace(/\\/g, '/');
      if (name === '') return null;
      const looksLikePath = name.includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(name);
      const asFile = (): Promise<ResolvedMention | null> => this.mentionFile(name);
      const asSymbol = (): Promise<ResolvedMention | null> => this.mentionSymbol(name);
      return looksLikePath ? (await asFile()) ?? (await asSymbol()) : (await asSymbol()) ?? (await asFile());
    } catch {
      return null;
    }
  }

  private async mentionFile(path: string): Promise<ResolvedMention | null> {
    if (!isInsidePath(path)) return null; // a path may never leave the workspace
    const text = await this.read(path);
    if (text === undefined) return null;
    const lines = lineSplit(text);
    if (lines.length <= MENTION_FILE_MAX_LINES) return { kind: 'file', label: path, path, content: text };
    const symbols = this.options.index.files.get(path)?.symbols ?? [];
    return { kind: 'file', label: path, path, content: buildOutline(path, lines, symbols) };
  }

  private async mentionSymbol(name: string): Promise<ResolvedMention | null> {
    const exact = (await this.findSymbol({ name })).symbols.filter((s) => s.name.toLowerCase() === name.toLowerCase());
    const best = exact.find((s) => s.name === name) ?? exact[0];
    if (!best) return null;
    const text = await this.read(best.path);
    if (text === undefined) return null;
    const lines = lineSplit(text);
    const symbols = this.options.index.files.get(best.path)?.symbols ?? [];
    const next = symbols.find((s) => s.line > best.line)?.line ?? lines.length + 1;
    const end = Math.min(next - 1, best.line + MENTION_SYMBOL_MAX_LINES - 1, lines.length);
    return { kind: 'symbol', label: best.name, path: best.path, content: lines.slice(best.line - 1, end).join('\n') };
  }

  // ───────── the automatic seed ─────────
  /** Relevant code chosen before the agent starts: a tiny project map, then the best-ranked snippets that fit the budget. */
  async seed(prompt: string, budgetTokens: number): Promise<ContextItem[]> {
    try {
      await this.ready();
      const budget = Math.max(0, Math.floor(budgetTokens));
      const items: ContextItem[] = [];
      let used = 0;

      const mapBudget = Math.min(SEED_MAP_MAX_TOKENS, Math.floor(budget / 5));
      if (mapBudget >= 60) {
        const map = renderRepoMap(this.options.index, '', 2, mapBudget);
        const tokens = estimateTokens(map.tree);
        if (map.tree !== '' && tokens <= mapBudget) {
          items.push({ path: '.', reason: 'a tiny map of the project folders', tokens, source: 'auto' });
          used += tokens;
        }
      }

      const mentioned = new Set(parseMentions(prompt).map((m) => m.name));
      const ranked = await this.rankFiles(prompt);
      for (const r of ranked) {
        if (mentioned.has(r.path)) continue; // the user already gave us this file
        const file = this.options.index.files.get(r.path);
        if (!file) continue;
        const text = await this.read(r.path);
        if (text === undefined) continue;
        const lines = lineSplit(text);
                const range = snippetRange(file, stripMentions(prompt));
        const startLine = range.startLine;
        let endLine = range.endLine;
        endLine = Math.min(endLine, lines.length);
        const remaining = budget - used;
        let chosen = lines.slice(startLine - 1, endLine);
        // Too big for what is left: show fewer lines instead of dropping the file.
        let chars = 0;
        const fitting: string[] = [];
        for (const line of chosen) {
          chars += line.length + 1;
          if (estimateTokens('x'.repeat(chars)) > remaining) break;
          fitting.push(line);
        }
        if (fitting.length < chosen.length) chosen = fitting;
        if (chosen.length === 0 || chosen.length < Math.min(3, endLine - startLine + 1)) continue; // not even 3 lines fit: skip this file
        endLine = startLine + chosen.length - 1;
        const tokens = estimateTokens(chosen.join('\n'));
        if (tokens <= 0 || used + tokens > budget) continue;
        items.push({ path: r.path, reason: r.reason, tokens, source: 'auto', range: { startLine, endLine } });
        used += tokens;
      }
      return items;
    } catch {
      return [];
    }
  }
}

function isTestLike(path: string): boolean {
  return /(^|\/)(tests?|spec)(\/|$)|(^|\/)test_|_test\.|\.(test|spec)\./i.test(path);
}

