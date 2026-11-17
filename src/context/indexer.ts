/**
 * indexer.ts -- a searchable index of the workspace: for every file its path words, symbol names,
 * headings/docstring first lines, body words and imports.
 *
 * The index talks to a tiny `FileSource` (list files / read a file), so it is tested with in-memory
 * files and used with the real workspace later. It builds in chunks (yielding every ~100 files) so the
 * editor never freezes, and re-reads a file only if its size or modified time changed.
 */
import { indexWords, splitIdentifier, stem } from './terms';

export interface FileEntry { path: string; size: number; mtimeMs: number }
export interface FileSource {
  list(): Promise<FileEntry[]>;
  /** undefined = unreadable / binary / missing */
  read(path: string): Promise<string | undefined>;
}

export interface IndexedSymbol { name: string; line: number; kind: string }
export type FieldName = 'path' | 'symbols' | 'headings' | 'body';

export interface IndexedFile {
  path: string;
  dir: string;
  size: number;
  mtimeMs: number;
  lines: number;
  fields: Record<FieldName, Map<string, number>>;
  lens: Record<FieldName, number>;
  symbols: IndexedSymbol[];
  imports: string[];
  firstLines: string[];
  isTest: boolean;
  isDoc: boolean;
  /** 1 = normal; lower = less likely to be what the user wants (lock files, generated files, huge files). */
  noise: number;
  pathWords: string[];
  baseStem: string;
}

export const DEFAULT_EXCLUDES = ['node_modules', 'vendor', 'dist', 'build', 'out', '.git', '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache', 'coverage', '.next', 'target'];
const CODE_EXT = new Set(['py', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'java', 'go', 'rs', 'rb', 'php', 'c', 'h', 'cpp', 'hpp', 'cs', 'kt', 'swift', 'sh', 'json', 'toml', 'yaml', 'yml', 'cfg', 'ini', 'html', 'css', 'md', 'rst', 'txt']);
const DOC_EXT = new Set(['md', 'rst', 'txt']);
const MAX_INDEX_BYTES = 400_000;
const LARGE_FILE_BYTES = 100_000;

export function isExcludedPath(path: string, excludes: readonly string[] = DEFAULT_EXCLUDES): boolean {
  return path.split('/').some((seg) => excludes.includes(seg));
}

function extOf(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return (m?.[1] ?? '').toLowerCase();
}

export function isTestPath(path: string): boolean {
  return /(^|[/_.-])(tests?|specs?)([/_.-]|$)|(^|\/)test_|_test\.[a-z]+$|\.(test|spec)\.[a-z]+$/i.test(path);
}

export function noiseFactor(path: string, size: number): number {
  const name = path.split('/').pop() ?? path;
  if (/(^|[-_.])(lock|lockfile)([-_.]|$)|\.lock$|package-lock|yarn\.lock|\.min\.|\.map$|(^|[-_.])generated([-_.]|$)|(^|\/)(changelog|changes|history|news)(\.|$)/i.test(name)) return 0.3;
  if (size > LARGE_FILE_BYTES) return 0.7;
  return 1;
}

// ───────── extracting things from text ─────────
const SYMBOL_PATTERNS: { re: RegExp; kind: string }[] = [
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function' },
  { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class' },
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
  { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { re: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, kind: 'type' },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'variable' },
  { re: /^\s*(?:public|private|protected|static|func|fn)\s+(?:static\s+)?(?:\w+\s+)?([A-Za-z_]\w*)\s*\(/, kind: 'function' },
];

export function extractSymbols(lines: readonly string[]): IndexedSymbol[] {
  const out: IndexedSymbol[] = [];
  lines.forEach((line, i) => {
    for (const { re, kind } of SYMBOL_PATTERNS) {
      const m = re.exec(line);
      if (m?.[1]) { out.push({ name: m[1], line: i + 1, kind }); break; }
    }
  });
  return out;
}

/** Headings (markdown/reStructuredText) and the first line of docstrings / doc comments. */
export function extractHeadings(lines: readonly string[], ext: string): string[] {
  const out: string[] = [];
  lines.forEach((line, i) => {
    const md = /^#{1,6}\s+(.+)$/.exec(line);
    if (md?.[1] && (ext === 'md' || ext === 'txt' || ext === 'rst')) out.push(md[1]);
    const next = lines[i + 1];
    if (ext === 'rst' && next !== undefined && /^([=\-~^"#*+])\1{2,}\s*$/.test(next) && line.trim() !== '' && !/^([=\-~^"#*+])\1{2,}\s*$/.test(line)) out.push(line.trim());
    const doc = /^\s*(?:"""|''')\s*(.+?)(?:"""|''')?\s*$/.exec(line);
    if (doc?.[1] && (ext === 'py')) out.push(doc[1]);
    const jsdoc = /^\s*\/\*\*\s*(.+?)\s*(?:\*\/)?\s*$/.exec(line);
    if (jsdoc?.[1] && !jsdoc[1].startsWith('*')) out.push(jsdoc[1]);
    const jsdocLine = /^\s*\*\s+([A-Za-z].+)$/.exec(line);
    if (jsdocLine?.[1] && !jsdocLine[1].startsWith('@') && ext !== 'md' && ext !== 'rst' && ext !== 'txt') out.push(jsdocLine[1]);
  });
  return out.slice(0, 200);
}

export function extractImports(text: string, ext: string): string[] {
  const out = new Set<string>();
  if (ext === 'py') {
    for (const m of text.matchAll(/^\s*from\s+(\.*[\w.]*)\s+import\s+([\w*, ()]+)/gm)) {
      const base = m[1] ?? '';
      if (base !== '' && !/^\.+$/.test(base)) out.add(base);
      else for (const name of (m[2] ?? '').split(/[,\s()]+/)) if (/^[A-Za-z_]\w*$/.test(name)) out.add(`${base}${name}`);
    }
    for (const m of text.matchAll(/^\s*import\s+([\w.]+)/gm)) if (m[1]) out.add(m[1]);
  } else if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) if (m[1]) out.add(m[1]);
    for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) if (m[1]) out.add(m[1]);
  }
  return [...out];
}

function countWords(words: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of words) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}

export function indexFile(entry: FileEntry, text: string): IndexedFile {
  const ext = extOf(entry.path);
  const body = text.length > MAX_INDEX_BYTES ? text.slice(0, MAX_INDEX_BYTES) : text;
  const lines = body.split(/\r?\n/);
  const symbols = extractSymbols(lines);
  const headings = extractHeadings(lines, ext);
  const pathParts = entry.path.split('/');
  const baseName = (pathParts[pathParts.length - 1] ?? '').replace(/\.[A-Za-z0-9]+$/, '');
  const pathWordList = indexWords(entry.path.replace(/\.[A-Za-z0-9]+$/, ''));
  const symbolWords = symbols.flatMap((s) => indexWords(s.name));
  const headingWords = headings.flatMap((h) => indexWords(h));
  const bodyWords = indexWords(body);
  return {
    path: entry.path,
    dir: pathParts.slice(0, -1).join('/'),
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    lines: lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length, // a final newline is not another line
    fields: { path: countWords(pathWordList), symbols: countWords(symbolWords), headings: countWords(headingWords), body: countWords(bodyWords) },
    lens: { path: pathWordList.length, symbols: symbolWords.length, headings: headingWords.length, body: bodyWords.length },
    symbols,
    imports: extractImports(body, ext),
    firstLines: lines.slice(0, 60),
    isTest: isTestPath(entry.path),
    isDoc: DOC_EXT.has(ext),
    noise: noiseFactor(entry.path, entry.size),
    pathWords: [...new Set(pathWordList)],
    baseStem: stem(splitIdentifier(baseName).join('')),
  };
}

// ───────── the index ─────────
export interface BuildOptions {
  /** Yield to the event loop every this many files (default 100). */
  yieldEvery?: number;
  /** Called at every yield (used by tests and by progress logging). */
  onYield?: () => void;
  excludes?: readonly string[];
}

export interface IndexStats { fileCount: number; docFreq: Map<string, number>; avgLen: Record<FieldName, number> }

const FIELD_NAMES: FieldName[] = ['path', 'symbols', 'headings', 'body'];

export class WorkspaceIndex {
  readonly files = new Map<string, IndexedFile>();
  private statsCache: IndexStats | undefined;
  private graphCache: { imports: Map<string, string[]>; importedBy: Map<string, string[]> } | undefined;
  /** How many files were actually read in the last build (the rest came from the cache). */
  lastReadCount = 0;
  lastBuildMs = 0;

  /** (Re)build from a source. Unchanged files (same size and modified time) are kept as they are. */
  async build(source: FileSource, options: BuildOptions = {}): Promise<void> {
    const started = Date.now();
    const yieldEvery = options.yieldEvery ?? 100;
    const entries = (await source.list()).filter((e) => CODE_EXT.has(extOf(e.path)) && !isExcludedPath(e.path, options.excludes));
    const keep = new Set(entries.map((e) => e.path));
    for (const p of [...this.files.keys()]) if (!keep.has(p)) this.files.delete(p);
    this.lastReadCount = 0;
    let n = 0;
    for (const entry of entries) {
      const old = this.files.get(entry.path);
      if (!old || old.size !== entry.size || old.mtimeMs !== entry.mtimeMs) {
        const text = await source.read(entry.path);
        if (text === undefined) this.files.delete(entry.path);
        else { this.files.set(entry.path, indexFile(entry, text)); this.lastReadCount++; }
      }
      if (++n % yieldEvery === 0) {
        options.onYield?.();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    this.invalidate();
    this.lastBuildMs = Date.now() - started;
  }

  /** Incremental update after a save or file-watcher event. */
  update(entry: FileEntry, text: string): void {
    if (!CODE_EXT.has(extOf(entry.path)) || isExcludedPath(entry.path)) return;
    this.files.set(entry.path, indexFile(entry, text));
    this.invalidate();
  }

  remove(path: string): void {
    if (this.files.delete(path)) this.invalidate();
  }

  private invalidate(): void {
    this.statsCache = undefined;
    this.graphCache = undefined;
  }

  stats(): IndexStats {
    if (this.statsCache) return this.statsCache;
    const docFreq = new Map<string, number>();
    const sums: Record<FieldName, number> = { path: 0, symbols: 0, headings: 0, body: 0 };
    for (const f of this.files.values()) {
      const seen = new Set<string>();
      for (const name of FIELD_NAMES) {
        sums[name] += f.lens[name];
        for (const term of f.fields[name].keys()) seen.add(term);
      }
      for (const term of seen) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
    const n = Math.max(1, this.files.size);
    this.statsCache = { fileCount: this.files.size, docFreq, avgLen: { path: Math.max(1, sums.path / n), symbols: Math.max(1, sums.symbols / n), headings: Math.max(1, sums.headings / n), body: Math.max(1, sums.body / n) } };
    return this.statsCache;
  }

  /** Files each file imports / is imported by (one hop), resolved to workspace paths. */
  graph(): { imports: Map<string, string[]>; importedBy: Map<string, string[]> } {
    if (this.graphCache) return this.graphCache;
    const byKey = new Map<string, string[]>(); // module-like key -> paths
    const addKey = (key: string, path: string): void => {
      const list = byKey.get(key) ?? [];
      if (!list.includes(path)) list.push(path);
      byKey.set(key, list);
    };
    for (const path of this.files.keys()) {
      let stemPath = path.replace(/\.[A-Za-z0-9]+$/, '');
      stemPath = stemPath.replace(/\/(__init__|index)$/, '');
      const segs = stemPath.split('/');
      for (let i = 0; i < segs.length; i++) addKey(segs.slice(i).join('/'), path);
    }
    const imports = new Map<string, string[]>();
    const importedBy = new Map<string, string[]>();
    for (const f of this.files.values()) {
      const targets: string[] = [];
      for (const spec of f.imports) {
        const key = importKey(spec, f.dir);
        if (key === undefined) continue;
        for (const t of byKey.get(key)?.slice(0, 3) ?? []) if (t !== f.path && !targets.includes(t)) targets.push(t);
      }
      imports.set(f.path, targets);
      for (const t of targets) importedBy.set(t, [...(importedBy.get(t) ?? []), f.path]);
    }
    this.graphCache = { imports, importedBy };
    return this.graphCache;
  }
}

/** Turn an import written in code into a path-like key ("pkg.mod" -> "pkg/mod", "./x" -> "<dir>/x"). */
export function importKey(spec: string, fromDir: string): string | undefined {
  const norm = (parts: string[]): string | undefined => {
    const out: string[] = [];
    for (const p of parts) {
      if (p === '' || p === '.') continue;
      if (p === '..') { if (out.length === 0) return undefined; out.pop(); } else out.push(p);
    }
    return out.join('/');
  };
  if (spec.startsWith('./') || spec.startsWith('../')) return norm([...fromDir.split('/'), ...spec.split('/')]);
  const dots = /^(\.+)(.*)$/.exec(spec);
  if (dots && !spec.includes('/')) {
    const up = (dots[1] ?? '').length - 1;
    const base = fromDir.split('/').filter((s) => s !== '');
    const rest = (dots[2] ?? '').split('.').filter((s) => s !== '');
    return norm([...base.slice(0, Math.max(0, base.length - up)), ...rest]);
  }
  if (spec.includes('/')) return norm(spec.split('/')); // bare path-like specifier
  return norm(spec.split('.'));
}
