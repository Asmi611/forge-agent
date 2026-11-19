import { describe, expect, it } from 'vitest';
import { buildText, splitKeepEol } from '../../src/review/hunkText';
import type { FileProposal, Hunk, HunkStatus } from '../../src/types/contract';

/** Small helper: a hunk replacing `oldLines` original lines starting at `oldStart`. */
function hunk(id: string, oldStart: number, oldLines: number, newText: string, status: HunkStatus = 'pending'): Hunk {
  const newLines = newText === '' ? 0 : newText.split('\n').length;
  return { id, oldStart, oldLines, newStart: oldStart, newLines, oldText: '', newText, status };
}

function proposal(original: string, proposed: string, hunks: Hunk[]): FileProposal {
  return {
    id: 'p1', callId: 'c1', callIds: ['c1'], path: 'x.txt', isNewFile: false,
    base: { contentHash: 'h', version: 1, wasDirty: false },
    originalContent: original, proposedContent: proposed, hunks, rationale: '', createdAt: 0,
  };
}

const withStatus = (p: FileProposal, ...s: HunkStatus[]): FileProposal => ({
  ...p, hunks: p.hunks.map((h, i) => ({ ...h, status: s[i] ?? h.status })),
});

const ORIG = 'one\ntwo\nthree\nfour\nfive\n';
const TWO_HUNKS = proposal(ORIG, 'one\nTWO\nthree\nfour\nFIVE\n', [
  hunk('h1', 2, 1, 'TWO'),
  hunk('h2', 5, 1, 'FIVE'),
]);

describe('splitKeepEol', () => {
  it('keeps every terminator', () => {
    expect(splitKeepEol('a\r\nb\nc')).toEqual(['a\r\n', 'b\n', 'c']);
    expect(splitKeepEol('')).toEqual([]);
    expect(splitKeepEol('a\n')).toEqual(['a\n']);
  });
});

describe('buildText: basic rules', () => {
  it('all accepted == proposedContent (final)', () => {
    const p = withStatus(TWO_HUNKS, 'accepted', 'accepted');
    expect(buildText(p, 'final').text).toBe(p.proposedContent);
  });
  it('all rejected == originalContent (final and preview)', () => {
    const p = withStatus(TWO_HUNKS, 'rejected', 'rejected');
    expect(buildText(p, 'final').text).toBe(ORIG);
    expect(buildText(p, 'preview').text).toBe(ORIG);
  });
  it('mixed: accept 1, reject 2', () => {
    const p = withStatus(TWO_HUNKS, 'accepted', 'rejected');
    expect(buildText(p, 'final').text).toBe('one\nTWO\nthree\nfour\nfive\n');
  });
  it('final ignores pending hunks, preview applies them', () => {
    const p = TWO_HUNKS; // both pending
    expect(buildText(p, 'final').text).toBe(ORIG);
    expect(buildText(p, 'preview').text).toBe(TWO_HUNKS.proposedContent);
  });
  it('preview: rejected hunk shows the original', () => {
    const p = withStatus(TWO_HUNKS, 'pending', 'rejected');
    expect(buildText(p, 'preview').text).toBe('one\nTWO\nthree\nfour\nfive\n');
  });
});

describe('buildText: insert, delete, edges', () => {
  it('pure insertion goes BEFORE oldStart', () => {
    const p = proposal(ORIG, '', [hunk('h1', 3, 0, 'new', 'accepted')]);
    expect(buildText(p, 'final').text).toBe('one\ntwo\nnew\nthree\nfour\nfive\n');
  });
  it('pure deletion', () => {
    const p = proposal(ORIG, '', [hunk('h1', 2, 2, '', 'accepted')]);
    expect(buildText(p, 'final').text).toBe('one\nfour\nfive\n');
  });
  it('hunk on the first line and on the last line', () => {
    const p = proposal(ORIG, '', [hunk('h1', 1, 1, 'ONE', 'accepted'), hunk('h2', 5, 1, 'FIVE', 'accepted')]);
    expect(buildText(p, 'final').text).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
  });
  it('insertion at the very start and at the very end', () => {
    const p = proposal(ORIG, '', [hunk('h1', 1, 0, 'zero', 'accepted'), hunk('h2', 6, 0, 'six', 'accepted')]);
    expect(buildText(p, 'final').text).toBe('zero\none\ntwo\nthree\nfour\nfive\nsix\n');
  });
  it('empty original file', () => {
    const p = proposal('', '', [hunk('h1', 1, 0, 'x\ny', 'accepted')]);
    expect(buildText(p, 'final').text).toBe('x\ny\n');
  });
  it('newText that ends with a newline gives the same result', () => {
    const a = proposal(ORIG, '', [hunk('h1', 2, 1, 'TWO', 'accepted')]);
    const b = proposal(ORIG, '', [{ ...hunk('h1', 2, 1, 'TWO', 'accepted'), newText: 'TWO\n' }]);
    expect(buildText(b, 'final').text).toBe(buildText(a, 'final').text);
  });
});

describe('buildText: line endings', () => {
  it('CRLF file stays CRLF', () => {
    const o = 'a\r\nb\r\nc\r\n';
    const p = proposal(o, '', [hunk('h1', 2, 1, 'B', 'accepted')]);
    expect(buildText(p, 'final').text).toBe('a\r\nB\r\nc\r\n');
  });
  it('MIXED CRLF/LF: untouched lines are byte-identical', () => {
    const o = 'a\r\nb\nc\r\nd\n';
    const p = proposal(o, '', [hunk('h1', 2, 1, 'B', 'accepted'), hunk('h2', 3, 1, 'C', 'accepted')]);
    expect(buildText(p, 'final').text).toBe('a\r\nB\nC\r\nd\n');
    const none = withStatus(p, 'rejected', 'rejected');
    expect(Buffer.compare(Buffer.from(buildText(none, 'final').text), Buffer.from(o))).toBe(0);
  });
  it('no trailing newline: replace last line', () => {
    const p = proposal('a\nb', '', [hunk('h1', 2, 1, 'B', 'accepted')]);
    expect(buildText(p, 'final').text).toBe('a\nB');
  });
  it('no trailing newline: append after the last line', () => {
    const p = proposal('a\nb', '', [hunk('h1', 3, 0, 'c', 'accepted')]);
    expect(buildText(p, 'final').text).toBe('a\nb\nc');
  });
  it('no trailing newline: delete the last line', () => {
    const p = proposal('a\nb', '', [hunk('h1', 2, 1, '', 'accepted')]);
    expect(buildText(p, 'final').text).toBe('a\n');
  });
});

describe('buildText: hunkLine (CodeLens positions)', () => {
  it('points at the first line of each hunk in the output', () => {
    const p = proposal(ORIG, '', [hunk('h1', 2, 1, 'a\nb\nc'), hunk('h2', 5, 1, 'FIVE')]);
    expect(buildText(p, 'preview').hunkLine).toEqual({ h1: 1, h2: 6 }); // h1 grew by 2 lines
    const rejected = withStatus(p, 'rejected', 'pending');
    expect(buildText(rejected, 'preview').hunkLine).toEqual({ h1: 1, h2: 4 }); // h1 back to 1 line
  });
});

describe('buildText: bad input', () => {
  it('throws on overlapping hunks instead of producing wrong text', () => {
    const p = proposal(ORIG, '', [hunk('h1', 2, 2, 'x', 'accepted'), hunk('h2', 3, 1, 'y', 'accepted')]);
    expect(() => buildText(p, 'final')).toThrow(RangeError);
  });
  it('throws on a hunk past the end of the file', () => {
    const p = proposal(ORIG, '', [hunk('h1', 9, 1, 'x', 'accepted')]);
    expect(() => buildText(p, 'final')).toThrow(RangeError);
  });
});

// ---------- property test: 200 random cases, every accept/reject combination ----------
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

describe('buildText: property test', () => {
  it('matches a manual construction for 200 random proposals x every accept/reject combination', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const n = Math.floor(r() * 12); // 0..11 original lines
      const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
      const original = lines.map((l) => `${l}\n`).join('');
      // random, sorted, non-overlapping edits
      const edits: { start: number; old: number; repl: string[] }[] = [];
      let pos = 0; // 0-based index of the next free original line
      while (pos <= n && edits.length < 4) {
        pos += Math.floor(r() * 3);
        if (pos > n) break;
        const old = Math.min(Math.floor(r() * 3), n - pos);
        const repl = Array.from({ length: Math.floor(r() * 3) }, (_, j) => `N${seed}_${edits.length}_${j}`);
        if (old === 0 && repl.length === 0) { pos += 1; continue; }
        edits.push({ start: pos, old, repl });
        pos += old + 1;
      }
      const hunks = edits.map((e, i) => hunk(`h${i + 1}`, e.start + 1, e.old, e.repl.join('\n')));
      const base = proposal(original, '', hunks);
      for (let mask = 0; mask < 1 << edits.length; mask++) {
        const statuses = edits.map((_, i): HunkStatus => (mask & (1 << i) ? 'accepted' : 'rejected'));
        const expected: string[] = [];
        let cur = 0;
        edits.forEach((e, i) => {
          for (; cur < e.start; cur++) expected.push(lines[cur] as string);
          if (statuses[i] === 'accepted') expected.push(...e.repl);
          else for (let k = 0; k < e.old; k++) expected.push(lines[e.start + k] as string);
          cur = e.start + e.old;
        });
        for (; cur < n; cur++) expected.push(lines[cur] as string);
        const want = expected.map((l) => `${l}\n`).join('');
        expect(buildText(withStatus(base, ...statuses), 'final').text, `seed ${seed} mask ${mask}`).toBe(want);
      }
    }
  });
});
