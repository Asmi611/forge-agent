import { describe, expect, it } from 'vitest';
import type { ProposalOutcome } from '../../src/review/applyCore';
import { chooseApplyAction, countHunks, isFinished, statusBarText } from '../../src/review/applyMessages';

const p = (...s: ('pending' | 'accepted' | 'rejected')[]) => ({ hunks: s.map((status) => ({ status })) });

describe('what the Apply button does', () => {
  it('counts hunks across files', () => {
    expect(countHunks([p('accepted', 'pending'), p('rejected')])).toEqual({ total: 3, accepted: 1, pending: 1, rejected: 1 });
    expect(countHunks([])).toEqual({ total: 0, accepted: 0, pending: 0, rejected: 0 });
  });

  it('nothing under review -> empty', () => {
    expect(chooseApplyAction(countHunks([]))).toBe('empty');
  });
  it('some accepted -> go (undecided ones are simply not saved)', () => {
    expect(chooseApplyAction(countHunks([p('accepted', 'pending')]))).toBe('go');
  });
  it('everything rejected -> go: nothing is written but the review is finished and closed', () => {
    expect(chooseApplyAction(countHunks([p('rejected', 'rejected')]))).toBe('go');
  });
  it('nothing accepted and some undecided -> ask instead of guessing', () => {
    expect(chooseApplyAction(countHunks([p('rejected', 'pending')]))).toBe('ask-undecided');
    expect(chooseApplyAction(countHunks([p('pending', 'pending')]))).toBe('ask-undecided');
  });
});

describe('bottom bar text', () => {
  it('says what a click will do', () => {
    expect(statusBarText(countHunks([p('accepted', 'pending')])).text).toBe('$(check-all) Apply 1 of 2 changes');
    expect(statusBarText(countHunks([p('pending', 'pending')])).text).toBe('$(eye) 2 changes to review');
    expect(statusBarText(countHunks([p('rejected', 'rejected')])).text).toBe('$(close) Close review (nothing accepted)');
    expect(statusBarText(countHunks([p('accepted')])).text).toBe('$(check-all) Apply 1 of 1 change');
  });
});

describe('which proposals leave the review after an Apply', () => {
  const base: ProposalOutcome = { proposalId: 'p', path: 'a.txt', decisions: {}, acceptedCount: 0, totalHunks: 1, applied: false };
  it('saved, all-rejected and stale ones leave; retryable failures stay', () => {
    expect(isFinished({ ...base, applied: true })).toBe(true);
    expect(isFinished(base)).toBe(true);
    expect(isFinished({ ...base, failure: { kind: 'stale', message: '' } })).toBe(true);
    expect(isFinished({ ...base, failure: { kind: 'apply_failed', message: '' } })).toBe(false);
    expect(isFinished({ ...base, failure: { kind: 'restore_failed', message: '' } })).toBe(false);
  });
});
