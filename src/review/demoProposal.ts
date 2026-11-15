/**
 * demoProposal.ts -- turns the demo fixture (fixtures/demo-proposal.json) into a real
 * FileProposal with line numbers, so the demo diff can be reviewed hunk by hunk.
 *
 * The fixture only has oldText/newText per hunk. We find each oldText in the original
 * file (it must match exactly once, on whole lines), sort the hunks by position and
 * compute newStart as oldStart + running delta. Pure code: no VS Code, no disk writes.
 */
import { createHash } from 'crypto';
import type { FileProposal, Hunk, HunkStatus } from '../types/contract';

export interface DemoFixture {
  originalContent: string;
  proposedContent: string;
  hunks: { id?: string; oldText: string; newText: string; status?: HunkStatus }[];
  rationale?: string;
  callId?: string;
  callIds?: string[];
  createdAt?: number;
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

export function proposalFromFixture(fx: DemoFixture, path = 'src/Counter.tsx'): FileProposal {
  const original = fx.originalContent;
  const found = fx.hunks.map((h, i) => {
    const idx = h.oldText === '' ? -1 : original.indexOf(h.oldText);
    if (idx < 0 || original.indexOf(h.oldText, idx + 1) !== -1) {
      throw new Error(`demo hunk ${h.id ?? i + 1}: oldText must match exactly once`);
    }
    const atLineStart = idx === 0 || original[idx - 1] === '\n';
    const end = idx + h.oldText.length;
    const atLineEnd = h.oldText.endsWith('\n') || end === original.length || original[end] === '\n' || original[end] === '\r';
    if (!atLineStart || !atLineEnd) throw new Error(`demo hunk ${h.id ?? i + 1}: must cover whole lines`);
    const oldStart = original.slice(0, idx).split('\n').length; // 1-based line
    return { id: h.id ?? `h${i + 1}`, oldStart, oldText: h.oldText, newText: h.newText, status: h.status ?? 'pending' };
  });
  found.sort((a, b) => a.oldStart - b.oldStart);

  let delta = 0;
  let previousEnd = 0;
  const hunks: Hunk[] = found.map((f) => {
    const oldLines = lineCount(f.oldText);
    const newLines = lineCount(f.newText);
    if (f.oldStart <= previousEnd) throw new Error(`demo hunk ${f.id} overlaps another hunk`);
    previousEnd = f.oldStart + oldLines - 1;
    const hunk: Hunk = { id: f.id, oldStart: f.oldStart, oldLines, newStart: f.oldStart + delta, newLines, oldText: f.oldText, newText: f.newText, status: f.status };
    delta += newLines - oldLines;
    return hunk;
  });

  const callIds = fx.callIds ?? [fx.callId ?? 'call-demo-1'];
  return {
    id: 'demo-1',
    callId: callIds[0] as string,
    callIds,
    path,
    isNewFile: false,
    base: { contentHash: createHash('sha256').update(original).digest('hex'), version: null, wasDirty: false },
    originalContent: original,
    proposedContent: fx.proposedContent,
    hunks,
    rationale: fx.rationale ?? 'Demo proposal',
    createdAt: fx.createdAt ?? 0,
  };
}
