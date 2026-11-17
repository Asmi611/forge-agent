/**
 * ranker.ts -- "which files matter for this request, and why?"  Lexical, deterministic, model-free.
 *
 *  1. BM25F over four fields (path words, symbol names, headings/docstring first lines, body), weights from RankerConfig.
 *  2. Structure signals: test affinity, doc affinity, import neighbours (one hop from the top files).
 *  3. Slot reservation: if the request is about tests / docs, at least one test / doc file is kept.
 *  4. Diversity: at most N files from one folder in the top results.
 *  5. Noise penalties (lock files, generated files, huge files) are already folded into each file's `noise`.
 * Every result carries a reason built from what actually matched. Weights are INPUTS, never constants.
 * No project-specific words appear in this folder.
 */
import { WorkspaceIndex, type FieldName, type IndexedFile } from './indexer';
import { analyzeQuery, indexWords, type Intent } from './terms';

export interface RankerConfig {
  weights: Record<FieldName, number>;
  k1: number;
  b: number;
  limit: number;
  /** At most this many files from one folder among the first `diversityWindow` results. */
  maxPerDir: number;
  diversityWindow: number;
  /** Extra score, as a fraction of the related source file's score. */
  testAffinity: number;
  docAffinity: number;
  importNeighbour: number;
  /** How many top source files the structure signals start from. */
  topSources: number;
  /** Test files are rarely what the user wants first: their own score is multiplied by this unless the request mentions tests. */
  testPenalty: number;
  /** Same idea for documentation files: their own score is multiplied by this unless the request mentions docs. */
  docPenalty: number;
}

export const DEFAULT_RANKER_CONFIG: RankerConfig = {
  weights: { path: 3, symbols: 3, headings: 2, body: 1 },
  k1: 1.2,
  b: 0.75,
  limit: 10,
  maxPerDir: 3,
  diversityWindow: 8,
  testAffinity: 0.5,
  docAffinity: 0.3,
  importNeighbour: 0.25,
  topSources: 3,
  testPenalty: 0.7,
  docPenalty: 0.8,
};

export interface RankedFile { path: string; score: number; reason: string }

const FIELD_NAMES: FieldName[] = ['path', 'symbols', 'headings', 'body'];
const FIELD_LABEL: Record<FieldName, string> = { path: 'path', symbols: 'symbols', headings: 'headings', body: 'text' };
const GENERIC_PATH_WORDS = new Set(['test', 'tests', 'spec', 'specs', 'src', 'lib', 'index', 'main', 'init', 'util', 'utils', 'doc', 'docs', 'readme']);

interface Candidate {
  file: IndexedFile;
  base: number;
  boost: number;
  /** A test file never outranks the source it tests (unless the request is about tests). */
  cap?: number;
  matched: Record<FieldName, Set<string>>;
  signals: string[];
}

const fileName = (p: string): string => p.split('/').pop() ?? p;

function scoreFile(f: IndexedFile, terms: { term: string; weight: number }[], index: WorkspaceIndex, cfg: RankerConfig): Candidate | undefined {
  const stats = index.stats();
  const N = stats.fileCount;
  const matched: Record<FieldName, Set<string>> = { path: new Set(), symbols: new Set(), headings: new Set(), body: new Set() };
  let score = 0;
  for (const { term, weight } of terms) {
    const df = stats.docFreq.get(term) ?? 0;
    if (df === 0) continue;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    let tfw = 0;
    for (const name of FIELD_NAMES) {
      const tf = f.fields[name].get(term) ?? 0;
      if (tf === 0) continue;
      const norm = 1 - cfg.b + cfg.b * (f.lens[name] / stats.avgLen[name]);
      tfw += (cfg.weights[name] * tf) / norm;
      matched[name].add(term);
    }
    if (tfw > 0) score += weight * idf * (tfw / (cfg.k1 + tfw));
  }
  if (score <= 0) return undefined;
  return { file: f, base: score * f.noise, boost: 0, matched, signals: [] };
}

function relatedByName(a: IndexedFile, b: IndexedFile): boolean {
  const aw = a.pathWords.filter((w) => !GENERIC_PATH_WORDS.has(w));
  return aw.some((w) => b.pathWords.includes(w));
}

export function rank(prompt: string, index: WorkspaceIndex, cfg: RankerConfig = DEFAULT_RANKER_CONFIG, limit: number = cfg.limit): RankedFile[] {
  const query = analyzeQuery(prompt);
  if (query.terms.length === 0 || index.files.size === 0) return [];

  // 1) BM25F
  const candidates = new Map<string, Candidate>();
  for (const f of index.files.values()) {
    const c = scoreFile(f, query.terms, index, cfg);
    if (!c) continue;
    if (f.isTest && !query.intents.has('test')) c.base *= cfg.testPenalty;
    else if (f.isDoc && !query.intents.has('doc')) c.base *= cfg.docPenalty;
    candidates.set(f.path, c);
  }
  const byBase = (a: Candidate, b: Candidate): number => b.base - a.base || a.file.path.localeCompare(b.file.path);
  const initial = [...candidates.values()].sort(byBase);

  // 2) structure signals from the top source files
  const graph = index.graph();
  const sources = initial.filter((c) => !c.file.isTest && !c.file.isDoc).slice(0, cfg.topSources);
  const boostOf = (target: IndexedFile): Candidate => {
    let c = candidates.get(target.path);
    if (!c) {
      c = { file: target, base: 0, boost: 0, matched: { path: new Set(), symbols: new Set(), headings: new Set(), body: new Set() }, signals: [] };
      candidates.set(target.path, c);
    }
    return c;
  };
  const apply = (target: IndexedFile, amount: number, signal: string, cap?: number): void => {
    if (amount <= 0) return;
    const c = boostOf(target);
    if (cap !== undefined) c.cap = c.cap === undefined ? cap : Math.min(c.cap, cap);
    if (amount > c.boost) c.boost = amount;
    if (!c.signals.includes(signal)) c.signals.push(signal);
  };
  const intentFactor = (i: Intent): number => (query.intents.has(i) ? 1.5 : 1);
  for (const s of sources) {
    const sName = fileName(s.file.path);
    for (const f of index.files.values()) {
      if (f.path === s.file.path) continue;
      if (f.isTest && (relatedByName(s.file, f) || (graph.imports.get(f.path) ?? []).includes(s.file.path))) {
        apply(f, cfg.testAffinity * intentFactor('test') * s.base, `test of ${sName}`, query.intents.has('test') ? undefined : s.base * 0.95);
      } else if (f.isDoc && !f.isTest && s.file.baseStem.length >= 3 && (f.fields.body.has(s.file.baseStem) || f.fields.headings.has(s.file.baseStem) || relatedByName(s.file, f))) {
        apply(f, cfg.docAffinity * intentFactor('doc') * s.base, `docs mention ${s.file.baseStem}`);
      }
    }
    for (const t of graph.imports.get(s.file.path) ?? []) { const f = index.files.get(t); if (f) apply(f, cfg.importNeighbour * s.base, `imported by ${sName}`); }
    for (const t of graph.importedBy.get(s.file.path) ?? []) { const f = index.files.get(t); if (f) apply(f, cfg.importNeighbour * s.base, `imports ${sName}`); }
  }

  const total = (c: Candidate): number => (c.cap === undefined ? c.base + c.boost : Math.min(c.base + c.boost, c.cap));
  const ordered = [...candidates.values()].filter((c) => total(c) > 0).sort((a, b) => total(b) - total(a) || a.file.path.localeCompare(b.file.path));

  // 3) diversity: the first `diversityWindow` results may not have more than `maxPerDir` files from one folder
  const selected: Candidate[] = [];
  const deferred: Candidate[] = [];
  const perDir = new Map<string, number>();
  for (const c of ordered) {
    if (selected.length >= limit) break;
    if (selected.length < cfg.diversityWindow) {
      const n = perDir.get(c.file.dir) ?? 0;
      if (n >= cfg.maxPerDir) { deferred.push(c); continue; }
      perDir.set(c.file.dir, n + 1);
    }
    selected.push(c);
    if (selected.length === cfg.diversityWindow) { /* the window is full: later results are not limited */ }
  }
  for (const c of deferred) if (selected.length < limit) selected.push(c);

  // 4) slot reservation for tests / docs when the request asks for them
  const reserve = (wanted: boolean, pick: (c: Candidate) => boolean, label: string): void => {
    if (!wanted || selected.some(pick)) return;
    const best = ordered.find((c) => pick(c) && !selected.includes(c));
    if (!best) return;
    best.signals.push(label);
    if (selected.length >= limit) selected[selected.length - 1] = best;
    else selected.push(best);
  };
  reserve(query.intents.has('test'), (c) => c.file.isTest, 'reserved: best test candidate');
  reserve(query.intents.has('doc'), (c) => c.file.isDoc && !c.file.isTest, 'reserved: best doc candidate');

  return selected.map((c) => ({ path: c.file.path, score: Math.round(total(c) * 10000) / 10000, reason: reasonFor(c) }));
}

function reasonFor(c: Candidate): string {
  const parts: string[] = [];
  for (const name of FIELD_NAMES) {
    const terms = [...c.matched[name]].sort();
    if (terms.length === 0) continue;
    if (name === 'symbols') {
      const names = c.file.symbols.filter((s) => indexWords(s.name).some((w) => terms.includes(w))).map((s) => s.name).slice(0, 3);
      parts.push(`symbols: ${names.length > 0 ? names.join(', ') : terms.join(', ')}`);
    } else {
      parts.push(`${FIELD_LABEL[name]}: ${terms.slice(0, 5).join(', ')}`);
    }
  }
  parts.push(...c.signals);
  return parts.length > 0 ? parts.join('; ') : 'related file';
}

/** Which lines to show for a ranked file: the best-matching symbol's range (max 80 lines), else the first 60 lines. */
export function snippetRange(file: IndexedFile, prompt: string): { startLine: number; endLine: number } {
  const terms = new Set(analyzeQuery(prompt).terms.map((t) => t.term));
  let best: { line: number; hits: number; next: number } | undefined;
  file.symbols.forEach((s, i) => {
    const hits = indexWords(s.name).filter((w) => terms.has(w)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { line: s.line, hits, next: file.symbols[i + 1]?.line ?? file.lines + 1 };
  });
  if (best) return { startLine: best.line, endLine: Math.min(best.next - 1, best.line + 79, file.lines) };
  return { startLine: 1, endLine: Math.min(60, Math.max(1, file.lines)) };
}
