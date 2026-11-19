/**
 * reviewBatch.ts -- builds the ONE answer (ReviewResult) the engine is waiting for after a review.
 * Pure code, so the rules are unit tested:
 *  - Only proposals that belong to the waiting batch are reported. Proposals reopened by Undo (an older run) are never mixed in.
 *  - A batch proposal that was not part of this Apply (for example it was removed) counts as rejected, so the engine is never left waiting.
 *  - If this Apply had nothing to do with the waiting batch, no answer is built and the batch keeps waiting.
 *  - "Reject everything" is a normal answer (applied:false), and it IS sent.
 */
import type { ReviewResult } from '../types/contract';
import { toReviewProposals, type ApplyOutcome } from './applyCore';

export function buildReviewResult(batch: { batchId: string; proposalIds: readonly string[] } | undefined, outcome: ApplyOutcome): ReviewResult | undefined {
  if (!batch) return undefined;
  const wanted = new Set(batch.proposalIds);
  const mine = toReviewProposals(outcome).filter((p) => wanted.has(p.proposalId));
  if (mine.length === 0) return undefined;
  const answered = new Set(mine.map((p) => p.proposalId));
  const missing = batch.proposalIds.filter((id) => !answered.has(id)).map((proposalId) => ({ proposalId, decisions: {}, applied: false }));
  return { batchId: batch.batchId, proposals: [...mine, ...missing], applyId: outcome.applyId };
}
