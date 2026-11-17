import { describe, expect, it } from 'vitest';
import { createMockEngine } from '../../src/mocks/createMockEngine';
import { EventRouter, type RouterSink } from '../../src/ui/EventRouter';
import { friendlyError, statusLabel, type StatusState } from '../../src/ui/routerModel';
import type { EngineEvent, FileProposal } from '../../src/types/contract';

class FakeSink implements RouterSink {
  calls: string[] = [];
  statuses: StatusState[] = [];
  toasts: { level: string; text: string }[] = [];
  log(l: string): void { this.calls.push(`log:${l}`); }
  token(t: string): void { this.calls.push(`token:${t}`); }
  setStatus(s: StatusState): void { this.statuses.push(s); }
  setModel(m: string): void { this.calls.push(`model:${m}`); }
  toast(level: 'info' | 'warning' | 'error', text: string): void { this.toasts.push({ level, text }); }
  addProposal(p: FileProposal): void { this.calls.push(`add:${p.id}`); }
  removeProposal(id: string): void { this.calls.push(`remove:${id}`); }
  openReview(id: string | undefined): void { this.calls.push(`open:${id}`); }
  clearReview(): void { this.calls.push('clear'); }
}

const proposal = (id = 'p1'): FileProposal => ({
  id, callId: 'c', callIds: ['c'], path: 'a.txt', isNewFile: false, base: { contentHash: 'h', version: 1, wasDirty: false },
  originalContent: 'a\n', proposedContent: 'b\n', hunks: [{ id: 'h1', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, oldText: 'a', newText: 'b', status: 'pending' }], rationale: '', createdAt: 0,
});

async function* events(...e: EngineEvent[]): AsyncGenerator<EngineEvent> { for (const x of e) yield x; }
async function collect(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> { const out: EngineEvent[] = []; for await (const e of it) out.push(e); return out; }
const last = <T,>(a: T[]): T | undefined => a[a.length - 1];

describe('EventRouter', () => {
  it('error run: friendly toast (no raw text), review cleared, back to idle', async () => {
    const s = new FakeSink();
    await new EventRouter(s).consume(events({ type: 'run.started', runId: 'r', mode: 'agent', model: 'm' }, { type: 'run.failed', error: { kind: 'auth', message: 'HTTP 401 stack trace at x.js:1', retryable: false } }));
    expect(s.toasts).toEqual([{ level: 'error', text: friendlyError({ kind: 'auth', message: '', retryable: false }) }]);
    expect(JSON.stringify(s.toasts)).not.toContain('401');
    expect(s.calls).toContain('clear');
    expect(last(s.statuses)).toEqual({ kind: 'idle' });
  });
  it('failover: warning toast and model name refreshed', async () => {
    const s = new FakeSink();
    await new EventRouter(s).consume(events({ type: 'failover', from: 'a', to: 'b', reason: 'auth' }, { type: 'run.completed' }));
    expect(s.toasts[0]?.level).toBe('warning');
    expect(s.calls).toContain('model:b');
  });
  it('cancel: clears the review, friendly note', async () => {
    const s = new FakeSink();
    await new EventRouter(s).consume(events({ type: 'run.cancelled' }));
    expect(s.calls).toContain('clear');
    expect(s.toasts[0]?.text).toContain('Nothing was changed');
  });
  it('no proposals: "no changes proposed"; with proposals: no such toast', async () => {
    const a = new FakeSink();
    await new EventRouter(a).consume(events({ type: 'run.completed' }));
    expect(a.toasts[0]?.text).toBe('Forge: no changes proposed.');
    const b = new FakeSink();
    await new EventRouter(b).consume(events({ type: 'proposal.created', proposal: proposal() }, { type: 'run.completed' }));
    expect(b.toasts).toEqual([]);
  });
  it('review.required opens the first diff and keeps the batch until taken once', async () => {
    const s = new FakeSink();
    const r = new EventRouter(s);
    let batchDuring: string | undefined;
    async function* gen(): AsyncGenerator<EngineEvent> {
      yield { type: 'proposal.created', proposal: proposal('p1') };
      yield { type: 'review.required', batchId: 'b1', proposalIds: ['p1', 'p2'] };
      batchDuring = r.takeBatch();
      yield { type: 'run.completed' };
    }
    await r.consume(gen());
    expect(s.calls).toContain('open:p1');
    expect(s.statuses).toContainEqual({ kind: 'reviewing', files: 2 });
    expect(batchDuring).toBe('b1');
    expect(r.takeBatch()).toBeUndefined();
  });
  it('retry shows "retrying k/3"; discard removes the proposal', async () => {
    const s = new FakeSink();
    await new EventRouter(s).consume(events({ type: 'retry', attempt: 2, delayMs: 10, kind: 'timeout' }, { type: 'proposal.discarded', proposalId: 'p9', reason: 'failover' }, { type: 'run.completed' }));
    expect(s.statuses).toContainEqual({ kind: 'retrying', attempt: 2, max: 3 });
    expect(s.calls).toContain('remove:p9');
  });
  it('a stream that throws still ends idle with a friendly toast', async () => {
    const s = new FakeSink();
    async function* bad(): AsyncGenerator<EngineEvent> { yield { type: 'token', text: 'x' }; throw new Error('boom'); }
    await new EventRouter(s).consume(bad());
    expect(last(s.statuses)).toEqual({ kind: 'idle' });
    expect(s.toasts[0]?.level).toBe('error');
  });
  it('status labels: working and retrying are clickable Stop', () => {
    expect(statusLabel({ kind: 'running' }, 'm').command).toBe('forge.stop');
    expect(statusLabel({ kind: 'retrying', attempt: 1, max: 3 }, '').text).toContain('retrying 1/3');
    expect(statusLabel({ kind: 'idle' }, '').command).toBe('forge.askAgent');
  });
});

describe('createMockEngine follows the contract', () => {
  const run = (e: ReturnType<typeof createMockEngine>, prompt: string) => collect(e.runAgent({ prompt, mentions: [] }));
  const terminals = (ev: EngineEvent[]) => ev.filter((x) => ['run.completed', 'run.cancelled', 'run.failed'].includes(x.type));

  it('normal run pauses at review.required until reviewDone, then ends with exactly one terminal event', async () => {
    const e = createMockEngine({ delayMs: 1, getProposal: async () => proposal('p1') });
    const seen: EngineEvent[] = [];
    const done = (async () => { for await (const ev of e.runAgent({ prompt: 'x', mentions: [] })) { seen.push(ev); if (ev.type === 'review.required') { await new Promise((r) => setTimeout(r, 20)); expect(terminals(seen)).toHaveLength(0); await e.reviewDone({ batchId: ev.batchId, proposals: [{ proposalId: 'p1', decisions: { h1: 'accepted' }, applied: true }] }); } } })();
    await done;
    expect(terminals(seen)).toHaveLength(1);
    expect(last(seen)).toMatchObject({ type: 'run.completed', summary: 'applied 1 file' });
    expect(seen.findIndex((x) => x.type === 'proposal.created')).toBeLessThan(seen.findIndex((x) => x.type === 'review.required'));
  });
  it('cancel while waiting for review discards proposals and ends cancelled', async () => {
    const e = createMockEngine({ delayMs: 1, getProposal: async () => proposal('p1') });
    const seen: EngineEvent[] = [];
    for await (const ev of e.runAgent({ prompt: 'x', mentions: [] })) { seen.push(ev); if (ev.type === 'review.required') void e.cancel(); }
    expect(seen.map((x) => x.type).slice(-2)).toEqual(['proposal.discarded', 'run.cancelled']);
  });
  it('mock:error -> one run.failed; mock:failover -> failover BEFORE the fallback streams, then completes', async () => {
    const e = createMockEngine({ delayMs: 1 });
    const err = await run(e, 'mock:error');
    expect(terminals(err)).toEqual([{ type: 'run.failed', error: expect.objectContaining({ kind: 'auth' }) }]);
    const fo = await run(e, 'mock:failover');
    const idx = fo.findIndex((x) => x.type === 'failover');
    expect(idx).toBeGreaterThan(-1);
    expect(fo.slice(idx + 1).some((x) => x.type === 'token')).toBe(true);
    expect(e.activeModel()).toBe('mock-fallback');
    await e.switchModel('primary');
    expect(e.activeModel()).toBe('mock-primary');
  });
  it('mock:cancel can be stopped quickly; a second run while busy fails with kind busy', async () => {
    const e = createMockEngine({ delayMs: 1 });
    const first = run(e, 'mock:cancel');
    const second = await run(e, 'again');
    expect(second).toEqual([{ type: 'run.failed', error: expect.objectContaining({ kind: 'busy' }) }]);
    await e.cancel();
    expect(last(await first)).toEqual({ type: 'run.cancelled' });
  });
});
