/**
 * End-to-end flows WITHOUT VS Code: mock engine -> EventRouter -> review list -> apply -> reviewDone -> undo.
 * It wires the pieces the same way extension.ts does, so these are the safety promises we show in the video.
 */
import { describe, expect, it } from 'vitest';
import { createMockEngine } from '../../src/mocks/createMockEngine';
import { applyProposals, hashText, undoRecord, type FileChange, type FileState, type WorkspaceOps } from '../../src/review/applyCore';
import { buildReviewResult } from '../../src/review/reviewBatch';
import { EventRouter, type RouterSink } from '../../src/ui/EventRouter';
import { PanelModel } from '../../src/ui/AgentPanel/panelModel';
import type { EngineEvent, FileProposal, HunkStatus } from '../../src/types/contract';
import type { StatusState } from '../../src/ui/routerModel';

const ORIG = 'one\ntwo\nthree\nfour\nfive\n';

class Ops implements WorkspaceOps {
  disk = new Map<string, string>([['src/a.txt', ORIG]]);
  writes = 0;
  async readCurrent(p: string): Promise<FileState> { const t = this.disk.get(p); return t === undefined ? { exists: false, text: '', isDirty: false } : { exists: true, text: t, isDirty: false }; }
  async readDisk(p: string): Promise<string | null> { return this.disk.get(p) ?? null; }
  async applyEdit(changes: FileChange[]): Promise<boolean> { for (const c of changes) { this.writes++; if (c.kind === 'delete') this.disk.delete(c.path); else this.disk.set(c.path, c.text); } return true; }
  async save(p: string): Promise<boolean> { return this.disk.has(p); }
  async persistRecovery(): Promise<string | undefined> { return '/recovery/x.json'; }
}

const makeProposal = (s1: HunkStatus, s2: HunkStatus): FileProposal => ({
  id: 'p1', callId: 'c', callIds: ['c'], path: 'src/a.txt', isNewFile: false, base: { contentHash: hashText(ORIG), version: 1, wasDirty: false },
  originalContent: ORIG, proposedContent: '', rationale: 'demo', createdAt: 0,
  hunks: [
    { id: 'h1', oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, oldText: '', newText: 'TWO', status: s1 },
    { id: 'h2', oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, oldText: '', newText: 'FIVE', status: s2 },
  ],
});

function rig() {
  const ops = new Ops();
  const review: FileProposal[] = [];
  const statuses: StatusState[] = [];
  const toasts: string[] = [];
  const sink: RouterSink = {
    log() {}, token() {}, setModel() {}, setStatus: (s) => statuses.push(s), toast: (_l, t) => toasts.push(t),
    addProposal: (p) => review.push(JSON.parse(JSON.stringify(p)) as FileProposal), removeProposal: (id) => { const i = review.findIndex((p) => p.id === id); if (i >= 0) review.splice(i, 1); },
    openReview() {}, clearReview: () => { review.length = 0; },
  };
  const model = new PanelModel();
  const router = new EventRouter(sink, (e: EngineEvent) => model.apply(e));
  const engine = createMockEngine({ getProposal: async () => makeProposal('pending', 'pending'), delayMs: 1 });
  const reviewDoneCalls: string[] = [];
  const realDone = engine.reviewDone.bind(engine);
  engine.reviewDone = async (r) => { reviewDoneCalls.push(r.batchId); await realDone(r); };
  const start = (prompt: string): Promise<void> => router.consume(engine.runAgent({ prompt, mentions: [] }));
  const waitFor = async (cond: () => boolean): Promise<void> => { for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); if (!cond()) throw new Error('timed out'); };
  /** What extension.ts does when the user presses "Save accepted changes". */
  const applyNow = async (id = 'apply-1') => {
    const outcome = await applyProposals(ops, review, id);
    const result = buildReviewResult(router.currentBatch(), outcome);
    if (result) { router.takeBatch(); await engine.reviewDone(result); }
    for (const r of outcome.results) if (r.applied || r.acceptedCount === 0) { const i = review.findIndex((p) => p.id === r.proposalId); if (i >= 0) review.splice(i, 1); }
    return outcome;
  };
  return { ops, review, statuses, toasts, model, router, engine, reviewDoneCalls, start, waitFor, applyNow };
}
const reviewing = (r: ReturnType<typeof rig>): boolean => r.router.currentBatch() !== undefined && r.review.length > 0;

describe('end to end', () => {
  it('accept one change, reject the other: only the accepted one is saved, the run finishes, Undo restores the exact original', async () => {
    const r = rig();
    const run = r.start('add something');
    await r.waitFor(() => reviewing(r));
    expect(r.ops.writes).toBe(0); // nothing is written while reviewing
    r.review[0]!.hunks[0]!.status = 'accepted';
    r.review[0]!.hunks[1]!.status = 'rejected';
    const out = await r.applyNow();
    await run;
    expect(r.ops.disk.get('src/a.txt')).toBe('one\nTWO\nthree\nfour\nfive\n');
    expect(r.reviewDoneCalls).toHaveLength(1);
    expect(r.model.view([], false).messages.at(-1)?.text).toMatch(/applied 1 file/);
    expect(r.statuses.at(-1)).toEqual({ kind: 'idle' });
    const undone = await undoRecord(r.ops, out.record!, async () => true);
    expect(undone.ok).toBe(true);
    expect(hashText(r.ops.disk.get('src/a.txt')!)).toBe(hashText(ORIG));
  });

  it('reject everything: nothing is written, the run still finishes, the engine is told once', async () => {
    const r = rig();
    const run = r.start('add something');
    await r.waitFor(() => reviewing(r));
    r.review[0]!.hunks.forEach((h) => { h.status = 'rejected'; });
    await r.applyNow();
    await run;
    expect(r.ops.writes).toBe(0);
    expect(r.ops.disk.get('src/a.txt')).toBe(ORIG);
    expect(r.reviewDoneCalls).toHaveLength(1);
    expect(r.model.view([], false).messages.at(-1)?.text).toMatch(/no changes applied/);
  });

  it('Stop during review: nothing is written, proposals are cleared, the screen goes back to Ready', async () => {
    const r = rig();
    const run = r.start('add something');
    await r.waitFor(() => reviewing(r));
    await r.engine.cancel();
    await run;
    expect(r.ops.writes).toBe(0);
    expect(r.review).toHaveLength(0);
    expect(r.statuses.at(-1)).toEqual({ kind: 'idle' });
    const v = r.model.view([], false);
    expect(v.running).toBe(false);
    expect(v.statusText).toBe('Ready');
    expect(v.messages.at(-1)?.text).toMatch(/Nothing was changed/);
  });

  it('Stop while the AI is still thinking: clean stop, nothing written', async () => {
    const r = rig();
    const run = r.start('mock:cancel please');
    await new Promise((res) => setTimeout(res, 30));
    await r.engine.cancel();
    await run;
    expect(r.ops.writes).toBe(0);
    expect(r.model.view([], false).running).toBe(false);
  });

  it('the file was edited after Forge proposed: it is left alone and the engine is told why', async () => {
    const r = rig();
    const run = r.start('add something');
    await r.waitFor(() => reviewing(r));
    r.ops.disk.set('src/a.txt', 'one\nMY OWN EDIT\nthree\nfour\nfive\n');
    r.review[0]!.hunks.forEach((h) => { h.status = 'accepted'; });
    const out = await r.applyNow();
    await run;
    expect(out.results[0]).toMatchObject({ applied: false });
    expect(out.results[0]?.failure?.kind).toBe('stale');
    expect(r.ops.disk.get('src/a.txt')).toBe('one\nMY OWN EDIT\nthree\nfour\nfive\n');
    expect(r.reviewDoneCalls).toHaveLength(1);
  });

  it('an error run: friendly sentence, no raw text, nothing written, back to Ready', async () => {
    const r = rig();
    await r.start('mock:error');
    expect(r.ops.writes).toBe(0);
    const v = r.model.view([], false);
    expect(v.messages.at(-1)).toMatchObject({ tone: 'error' });
    expect(JSON.stringify(v)).not.toMatch(/invalid API key/);
    expect(v.statusText).toBe('Ready');
  });

  it('applying twice in a row does not answer the engine twice', async () => {
    const r = rig();
    const run = r.start('add something');
    await r.waitFor(() => reviewing(r));
    r.review[0]!.hunks[0]!.status = 'accepted';
    r.review[0]!.hunks[1]!.status = 'rejected';
    const saved = JSON.parse(JSON.stringify(r.review)) as FileProposal[];
    await r.applyNow('apply-1');
    await run;
    r.review.push(...saved); // e.g. proposals reopened after Undo
    await r.applyNow('apply-2');
    expect(r.reviewDoneCalls).toHaveLength(1);
  });

  it('a second request while one is waiting for review is refused politely and changes nothing', async () => {
    const r = rig();
    const run = r.start('add something');
    await r.waitFor(() => reviewing(r));
    const second = await r.engine.runAgent({ prompt: 'again', mentions: [] }); // the engine itself says busy
    const evs: EngineEvent[] = []; for await (const e of second) evs.push(e);
    expect(evs.at(-1)).toMatchObject({ type: 'run.failed', error: { kind: 'busy' } });
    expect(r.review).toHaveLength(1); // the first review is untouched
    await r.engine.cancel(); await run;
  });
});
