/**
 * applyMessages.ts -- plain-language text for the result of an Apply.
 * No jargon, no stack traces: just what happened and what to do next.
 */
import type { ApplyOutcome } from './applyCore';

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
