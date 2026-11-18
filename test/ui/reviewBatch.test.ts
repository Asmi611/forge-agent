import { describe, expect, it } from 'vitest';
import { buildReviewResult } from '../../src/review/reviewBatch';
import type { ApplyOutcome, ProposalOutcome } from '../../src/review/applyCore';

const po = (id: string, applied: boolean, dec: Record<string, 'accepted' | 'rejected' | 'pending'>): ProposalOutcome => ({ proposalId: id, path: `${id}.ts`, decisions: dec, acceptedCount: applied ? 1 : 0, totalHunks: 1, applied });
const outcome = (...r: ProposalOutcome[]): ApplyOutcome => ({ applyId: 'a1', results: r });
const batch = { batchId: 'b1', proposalIds: ['p1', 'p2'] };

describe('buildReviewResult', () => {
  it('answers with the decisions of the waiting batch', () => {
    const r = buildReviewResult(batch, outcome(po('p1', true, { h1: 'accepted' }), po('p2', false, { h1: 'rejected' })));
    expect(r).toMatchObject({ batchId: 'b1', applyId: 'a1' });
    expect(r?.proposals.map((p) => [p.proposalId, p.applied])).toEqual([['p1', true], ['p2', false]]);
  });
  it('"reject everything" is still an answer (the run must continue)', () => {
    const r = buildReviewResult(batch, outcome(po('p1', false, { h1: 'rejected' }), po('p2', false, { h1: 'rejected' })));
    expect(r?.proposals.every((p) => !p.applied)).toBe(true);
  });
  it('proposals from an older run (reopened by Undo) are not mixed in', () => {
    const r = buildReviewResult(batch, outcome(po('p1', true, { h1: 'accepted' }), po('p2', true, {}), po('old', true, { h1: 'accepted' })));
    expect(r?.proposals.map((p) => p.proposalId)).toEqual(['p1', 'p2']);
  });
  it('an Apply that only touches old proposals does NOT answer the waiting batch', () => {
    expect(buildReviewResult(batch, outcome(po('old', true, { h1: 'accepted' })))).toBeUndefined();
  });
  it('a batch proposal missing from the Apply counts as rejected, never left waiting', () => {
    const r = buildReviewResult(batch, outcome(po('p1', true, { h1: 'accepted' })));
    expect(r?.proposals).toContainEqual({ proposalId: 'p2', decisions: {}, applied: false });
  });
  it('no waiting batch means no answer (Undo-reopened proposals never call reviewDone)', () => {
    expect(buildReviewResult(undefined, outcome(po('p1', true, { h1: 'accepted' })))).toBeUndefined();
  });
  it('keeps failures so the engine can tell the user', () => {
    const f = { ...po('p1', false, { h1: 'accepted' }), failure: { kind: 'stale' as const, message: 'edited' } };
    expect(buildReviewResult(batch, outcome(f))?.proposals[0]?.failure?.kind).toBe('stale');
  });
});
