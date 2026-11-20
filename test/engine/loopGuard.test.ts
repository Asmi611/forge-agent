/**
 * Hermetic unit tests for pure LoopGuard (Milestone E-07a).
 *
 * Verifies loop detection, repetition counters, order-insensitive argument canonicalization,
 * configurable call limits, injectable clock elapsed time checks, and reset behavior.
 * Pure in-memory tests with zero network, filesystem, or VS Code dependencies.
 */

import { describe, it, expect } from 'vitest';
import {
  LoopGuard,
  LOOP_GUARD_STOP_MESSAGE,
  canonicalizeArgs,
} from '../../src/engine/loopGuard.ts';

describe('LoopGuard', () => {
  it('allows normal calls under the repetition threshold', () => {
    const guard = new LoopGuard();

    const r1 = guard.record('readFile', { path: 'src/main.ts' });
    expect(r1.stop).toBe(false);

    const r2 = guard.record('readFile', { path: 'src/main.ts' });
    expect(r2.stop).toBe(false);
  });

  it('triggers stop when the exact same tool and args repeats 3 times', () => {
    const guard = new LoopGuard();

    expect(guard.record('searchWorkspace', { query: 'test' }).stop).toBe(false);
    expect(guard.record('searchWorkspace', { query: 'test' }).stop).toBe(false);

    const r3 = guard.record('searchWorkspace', { query: 'test' });
    expect(r3.stop).toBe(true);
    if (r3.stop) {
      expect(r3.reason).toBe(LOOP_GUARD_STOP_MESSAGE);
      expect(r3.trigger).toBe('repeat');
    }
  });

  it('does not trigger stop when different args are used for the same tool', () => {
    const guard = new LoopGuard();

    // 2 calls for file1.ts
    expect(guard.record('readFile', { path: 'src/file1.ts' }).stop).toBe(false);
    expect(guard.record('readFile', { path: 'src/file1.ts' }).stop).toBe(false);

    // 2 calls for file2.ts
    expect(guard.record('readFile', { path: 'src/file2.ts' }).stop).toBe(false);
    expect(guard.record('readFile', { path: 'src/file2.ts' }).stop).toBe(false);

    // 2 calls for file3.ts
    expect(guard.record('readFile', { path: 'src/file3.ts' }).stop).toBe(false);
    expect(guard.record('readFile', { path: 'src/file3.ts' }).stop).toBe(false);

    // None have reached 3 repeats; guard remains unstopped
    expect(guard.totalCallCount).toBe(6);
  });

  it('treats arguments with different key order as identical (order-insensitive)', () => {
    const guard = new LoopGuard();

    const args1 = { path: 'src/index.ts', range: { startLine: 1, endLine: 50 } };
    const args2 = { range: { endLine: 50, startLine: 1 }, path: 'src/index.ts' };
    const args3 = { path: 'src/index.ts', range: { startLine: 1, endLine: 50 } };

    expect(guard.record('readFile', args1).stop).toBe(false);
    expect(guard.record('readFile', args2).stop).toBe(false);

    const r3 = guard.record('readFile', args3);
    expect(r3.stop).toBe(true);
    if (r3.stop) {
      expect(r3.reason).toBe(LOOP_GUARD_STOP_MESSAGE);
      expect(r3.trigger).toBe('repeat');
    }
  });

  it('canonicalizeArgs handles deeply nested objects, arrays, and primitives deterministically', () => {
    const objA = { z: 1, a: { beta: [1, 2], alpha: true } };
    const objB = { a: { alpha: true, beta: [1, 2] }, z: 1 };

    expect(canonicalizeArgs(objA)).toBe(canonicalizeArgs(objB));
    expect(canonicalizeArgs(null)).toBe('null');
    expect(canonicalizeArgs('text')).toBe('"text"');
    expect(canonicalizeArgs(42)).toBe('42');
  });

  it('does not confound calls between different tools sharing identical arguments', () => {
    const guard = new LoopGuard();
    const commonArgs = { target: 'component' };

    expect(guard.record('toolAlpha', commonArgs).stop).toBe(false);
    expect(guard.record('toolAlpha', commonArgs).stop).toBe(false);

    expect(guard.record('toolBeta', commonArgs).stop).toBe(false);
    expect(guard.record('toolBeta', commonArgs).stop).toBe(false);

    // Neither toolAlpha nor toolBeta has reached 3 calls
    expect(guard.totalCallCount).toBe(4);
  });

  it('stops when total tool calls exceed maxToolCalls (configurable limit)', () => {
    const guard = new LoopGuard({ maxToolCalls: 5 });

    // 5 distinct calls are permitted
    for (let i = 1; i <= 5; i++) {
      const res = guard.record('readFile', { fileId: i });
      expect(res.stop).toBe(false);
    }
    expect(guard.totalCallCount).toBe(5);

    // 6th call exceeds limit (5)
    const overflow = guard.record('readFile', { fileId: 6 });
    expect(overflow.stop).toBe(true);
    if (overflow.stop) {
      expect(overflow.reason).toBe(LOOP_GUARD_STOP_MESSAGE);
      expect(overflow.trigger).toBe('call_limit');
    }
  });

  it('defaults to 40 maxToolCalls when unconfigured', () => {
    const guard = new LoopGuard();

    for (let i = 1; i <= 40; i++) {
      const res = guard.record('probe', { index: i });
      expect(res.stop).toBe(false);
    }
    expect(guard.totalCallCount).toBe(40);

    const call41 = guard.record('probe', { index: 41 });
    expect(call41.stop).toBe(true);
    if (call41.stop) {
      expect(call41.reason).toBe(LOOP_GUARD_STOP_MESSAGE);
      expect(call41.trigger).toBe('call_limit');
    }
  });

  it('stops when elapsed time exceeds maxRunSeconds with an injectable clock', () => {
    let fakeTime = 100_000;
    const guard = new LoopGuard({
      maxRunSeconds: 10,
      clock: () => fakeTime,
    });

    // Initial call within limit
    expect(guard.record('search', { q: 'one' }).stop).toBe(false);

    // Advance fake time past 10 seconds (11,000 ms)
    fakeTime += 11_000;

    const timeoutResult = guard.record('search', { q: 'two' });
    expect(timeoutResult.stop).toBe(true);
    if (timeoutResult.stop) {
      expect(timeoutResult.reason).toBe(LOOP_GUARD_STOP_MESSAGE);
      expect(timeoutResult.trigger).toBe('time_limit');
    }
  });

  it('resets repetition counts, total call counter, and elapsed timer on reset()', () => {
    let fakeTime = 50_000;
    const guard = new LoopGuard({
      maxToolCalls: 3,
      repeatThreshold: 3,
      maxRunSeconds: 20,
      clock: () => fakeTime,
    });

    // Accumulate 2 repeats and 2 total calls
    expect(guard.record('tool', { x: 1 }).stop).toBe(false);
    expect(guard.record('tool', { x: 1 }).stop).toBe(false);
    expect(guard.totalCallCount).toBe(2);

    // Advance time close to limit
    fakeTime += 18_000;

    // Reset guard state
    guard.reset();
    expect(guard.totalCallCount).toBe(0);

    // Advance time by 5s from the reset point (now 23s from original start, but only 5s from reset)
    fakeTime += 5_000;

    // Two more calls with the same args are permitted because count was cleared
    expect(guard.record('tool', { x: 1 }).stop).toBe(false);
    expect(guard.record('tool', { x: 1 }).stop).toBe(false);
    expect(guard.totalCallCount).toBe(2);
  });

  it('verifies the exact stop message required by Card E-07 across all stop triggers', () => {
    const expectedMessage = 'The agent seems stuck (repeating the same step). Stopped safely.';

    // 1. Repeat trigger
    const repeatGuard = new LoopGuard({ repeatThreshold: 2 });
    repeatGuard.record('fn', {});
    const r1 = repeatGuard.record('fn', {});
    expect(r1.stop).toBe(true);
    if (r1.stop) expect(r1.reason).toBe(expectedMessage);

    // 2. Call limit trigger
    const callLimitGuard = new LoopGuard({ maxToolCalls: 1 });
    callLimitGuard.record('fn1', {});
    const r2 = callLimitGuard.record('fn2', {});
    expect(r2.stop).toBe(true);
    if (r2.stop) expect(r2.reason).toBe(expectedMessage);

    // 3. Time limit trigger
    let time = 1_000;
    const timeLimitGuard = new LoopGuard({ maxRunSeconds: 5, clock: () => time });
    time += 6_000;
    const r3 = timeLimitGuard.record('fn', {});
    expect(r3.stop).toBe(true);
    if (r3.stop) expect(r3.reason).toBe(expectedMessage);
  });
});
