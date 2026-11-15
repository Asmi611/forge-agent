/**
 * hunkText.ts -- rebuild a file's text from a FileProposal and the status of each hunk.
 *
 * Pure code: no VS Code, no disk. Everything in the review pipeline (diff preview,
 * CodeLens positions, ApplyManager) is built on this one function.
 *
 * Contract rules (src/types/contract.ts):
 *  - lines are 1-based; oldStart/oldLines = the ORIGINAL lines a hunk replaces;
 *  - a pure insertion has oldLines = 0 and its new lines go BEFORE oldStart;
 *  - hunks are sorted and do not overlap.
 *
 * Line endings: the original text is split into lines that KEEP their own terminator
 * ("\n" or "\r\n" or none for an unterminated last line). Untouched lines are copied
 * as-is, so a file with mixed CRLF/LF endings round-trips byte for byte.
 */
import type { FileProposal, Hunk } from '../types/contract';

export type BuildMode = 'preview' | 'final';

export interface BuiltText {
  text: string;
  /** hunkId -> 0-based line in the OUTPUT text where that hunk starts (for CodeLens). */
  hunkLine: Record<string, number>;
}

/** Split into lines, each KEEPING its own terminator. "a\r\nb\nc" -> ["a\r\n","b\n","c"]. */
export function splitKeepEol(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function eolOf(line: string): '\r\n' | '\n' | '' {
  if (line.endsWith('\r\n')) return '\r\n';
  if (line.endsWith('\n')) return '\n';
  return '';
}

/** The new lines of a hunk, WITHOUT terminators. newText may or may not end with a newline. */
function newLinesOf(h: Hunk): string[] {
  if (h.newLines === 0) return [];
  if (h.newText === '') return [''];
  const asGiven = h.newText.split(/\r?\n/);
  const trimmed = h.newText.replace(/\r?\n$/, '').split(/\r?\n/);
  if (asGiven.length === h.newLines) return asGiven;
  return trimmed; // the usual case: newText ends with a newline
}

/** EOL for new lines: the neighbouring line's, else any line's in the file, else "\n". */
function pickEol(orig: string[], start: number, end: number): string {
  for (const line of [orig[start], orig[start - 1], orig[end - 1]]) {
    const e = line === undefined ? '' : eolOf(line);
    if (e !== '') return e;
  }
  for (const line of orig) {
    const e = eolOf(line);
    if (e !== '') return e;
  }
  return '\n';
}

export function buildText(p: FileProposal, mode: BuildMode): BuiltText {
  const orig = splitKeepEol(p.originalContent);
  const hunks = [...p.hunks].sort((a, b) => a.oldStart - b.oldStart);
  const out: string[] = [];
  const hunkLine: Record<string, number> = {};
  let cursor = 0; // index of the next original line not yet copied

  for (const h of hunks) {
    const start = h.oldStart - 1; // pure insertions also start here: new lines go BEFORE this line
    const end = start + h.oldLines;
    if (start < cursor || start > orig.length || end > orig.length || h.oldLines < 0) {
      throw new RangeError(`hunk ${h.id} is out of range or overlaps another hunk`);
    }
    while (cursor < start) out.push(orig[cursor++] as string);
    hunkLine[h.id] = out.length;

    const apply = mode === 'preview' ? h.status !== 'rejected' : h.status === 'accepted';
    if (!apply) {
      for (let i = start; i < end; i++) out.push(orig[i] as string);
    } else {
      const lines = newLinesOf(h);
      const eol = pickEol(orig, start, end);
      let lastTerminated = true;
      if (end >= orig.length) {
        // The hunk touches the end of the file: keep "no newline at end" if the file had none.
        if (h.oldLines > 0) lastTerminated = eolOf(orig[end - 1] as string) !== '';
        else if (out.length > 0 && eolOf(out[out.length - 1] as string) === '' && lines.length > 0) {
          out[out.length - 1] += eol; // the old last line now has a line after it
          lastTerminated = false;
        }
      }
      lines.forEach((l, i) => out.push(l + (i === lines.length - 1 && !lastTerminated ? '' : eol)));
    }
    cursor = end;
  }
  while (cursor < orig.length) out.push(orig[cursor++] as string);
  return { text: out.join(''), hunkLine };
}
