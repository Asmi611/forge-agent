/**
 * mentions.ts -- finding @mentions in a request ("@src/app.py", "@build_report") and building outlines.
 * Pure text code: no VS Code, no disk.
 */
import type { IndexedSymbol } from './indexer';

export interface ParsedMention {
  /** As typed, with the "@" ("@src/app.py"). */
  raw: string;
  /** Without the "@", with forward slashes ("src/app.py"). */
  name: string;
}

/** Every distinct @mention in a text, in order. Email addresses ("me@site.com") are not mentions. */
export function parseMentions(text: string): ParsedMention[] {
  const out: ParsedMention[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/(^|[\s([{,;:])@([A-Za-z0-9_][A-Za-z0-9_./\\-]*)/g)) {
    const name = (m[2] ?? '').replace(/[.,;:)\]}]+$/, '').replace(/\\/g, '/');
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    out.push({ raw: `@${name}`, name });
  }
  return out;
}

/** The request without its @mentions (so the ranker does not search for "@src/app.py" as words). */
export function stripMentions(text: string): string {
  return text.replace(/(^|[\s([{,;:])@[A-Za-z0-9_][A-Za-z0-9_./\\-]*/g, '$1').replace(/\s+/g, ' ').trim();
}

/** A short table of contents for a big file: one line per symbol, or the first lines if it has none. */
export function buildOutline(path: string, lines: readonly string[], symbols: readonly IndexedSymbol[]): string {
  const head = `Outline of ${path} (${lines.length} lines; the file is too long to show in full, ask for a line range if you need more):`;
  if (symbols.length === 0) return `${head}\n${lines.slice(0, 80).map((l, i) => `${i + 1}: ${l}`).join('\n')}`;
  return `${head}\n${symbols.slice(0, 150).map((s) => `line ${s.line}: ${s.kind} ${s.name}`).join('\n')}`;
}
