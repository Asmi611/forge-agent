/**
 * applyMessages.ts -- plain-language text for the result of an Apply.
 * No jargon, no stack traces: just what happened and what to do next.
 */
import type { ApplyOutcome, ProposalOutcome } from './applyCore';

export interface Summary { level: 'info' | 'warning' | 'error'; text: string; offerUndo: boolean }

export function summarize(outcome: ApplyOutcome): Summary {
  const parts: string[] = [];
  let level: Summary['level'] = 'info';
  const done = outcome.results.filter((r) => r.applied);

  if (done.length === 1 && done[0]) {
    const r = done[0];
    parts.push(`Saved ${r.acceptedCount} of ${r.totalHunks} change${r.totalHunks === 1 ? '' : 's'} in ${r.path}.`);
  } else if (done.length > 1) {
    parts.push(`Saved your accepted changes in ${done.length} files.`);
  }

  for (const r of outcome.results) {
    const f = r.failure;
    if (!f) continue;
    if (f.kind === 'stale') {
      if (level === 'info') level = 'warning';
      parts.push(`${r.path} was edited after Forge proposed the change, so it was left alone. Ask Forge to try again.`);
    } else if (f.kind === 'apply_failed') {
      if (level === 'info') level = 'warning';
      parts.push(`Forge could not change ${r.path}, so it put everything back. ${f.message}`);
    } else {
      level = 'error';
      parts.push(`Forge could not safely undo a failed change to ${r.path}. Your original text is saved at ${f.recoveryPath ?? '(unknown)'}.`);
    }
  }

  if (parts.length === 0) parts.push('Nothing was accepted, so nothing was changed.');
  return { level, text: `Forge: ${parts.join(' ')}`, offerUndo: done.length > 0 };
}

// ───────── what the Apply button should do, in plain logic (unit tested) ─────────
export interface ReviewCounts { total: number; accepted: number; pending: number; rejected: number }

export function countHunks(proposals: readonly { hunks: readonly { status: 'pending' | 'accepted' | 'rejected' }[] }[]): ReviewCounts {
  const c: ReviewCounts = { total: 0, accepted: 0, pending: 0, rejected: 0 };
  for (const p of proposals) {
    for (const h of p.hunks) {
      c.total++;
      c[h.status]++;
    }
  }
  return c;
}

export type ApplyAction = 'empty' | 'ask-undecided' | 'go';

/**
 * 'empty'         nothing is being reviewed
 * 'ask-undecided' nothing accepted yet but some changes are undecided: ask, do not guess
 * 'go'            apply what is accepted. Also used when EVERYTHING was rejected: nothing is
 *                 written, the review is finished and closed (the engine must hear about it too).
 */
export function chooseApplyAction(c: ReviewCounts): ApplyAction {
  if (c.total === 0) return 'empty';
  if (c.accepted === 0 && c.pending > 0) return 'ask-undecided';
  return 'go';
}

/** Text of the bottom-bar button. */
export function statusBarText(c: ReviewCounts): { text: string; tooltip: string } {
  const s = (n: number): string => (n === 1 ? '' : 's');
  if (c.accepted > 0) {
    return {
      text: `$(check-all) Apply ${c.accepted} of ${c.total} change${s(c.total)}`,
      tooltip: 'Click to save the accepted changes to your files. Rejected and undecided changes are not saved.',
    };
  }
  if (c.pending > 0) {
    return {
      text: `$(eye) ${c.pending} change${s(c.pending)} to review`,
      tooltip: 'Nothing is saved yet. Accept the changes you want in the diff, then click here.',
    };
  }
  return {
    text: '$(close) Close review (nothing accepted)',
    tooltip: 'You rejected every change. Click to close the review without saving anything.',
  };
}

/** After an Apply: should this proposal leave the review? Failed-but-retryable ones stay. */
export function isFinished(r: ProposalOutcome): boolean {
  return r.applied || !r.failure || r.failure.kind === 'stale';
}
