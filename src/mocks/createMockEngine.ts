/**
 * createMockEngine.ts -- a contract-correct fake engine (EngineApi) for building the UI before the real one exists.
 * It follows the contract's stream rules: exactly ONE terminal event, `review.required` pauses the run until
 * reviewDone() or cancel(), failover is announced BEFORE the fallback streams, events arrive over time.
 * Scenarios are chosen by prompt text: "mock:error", "mock:failover", "mock:cancel" (otherwise the normal run).
 */
import type { AgentRequest, EngineApi, EngineEvent, FileProposal, InlineRequest, ReviewResult } from '../types/contract';

export interface MockEngineOptions {
  /** Called once per normal run; returns the proposal to review (or undefined for "no changes"). */
  getProposal?: () => Promise<FileProposal | undefined>;
  delayMs?: number;
}

type Scenario = 'default' | 'error' | 'failover' | 'cancel';
const scenarioOf = (prompt: string): Scenario =>
  prompt.includes('mock:error') ? 'error' : prompt.includes('mock:failover') ? 'failover' : prompt.includes('mock:cancel') ? 'cancel' : 'default';

export function createMockEngine(opts: MockEngineOptions = {}): EngineApi {
  const delay = opts.delayMs ?? 60;
  let model = 'mock-primary';
  let active = false;
  let cancelled = false;
  let runs = 0;
  let wake: (() => void) | undefined;
  let waiting: { batchId: string; resolve: (r: ReviewResult | 'cancel') => void } | undefined;

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wake = () => { clearTimeout(t); resolve(); };
  });

  async function* run(mode: 'inline' | 'agent', prompt: string): AsyncGenerator<EngineEvent> {
    if (active) { yield { type: 'run.failed', error: { kind: 'busy', message: 'a run is already active', retryable: false } }; return; }
    active = true;
    cancelled = false;
    const scenario = scenarioOf(prompt);
    const proposalIds: string[] = [];
    try {
      yield { type: 'run.started', runId: `mock-run-${++runs}`, mode, model };
      const words = scenario === 'cancel' ? Array.from({ length: 80 }, () => 'thinking ') : 'I will look at the code, then propose a change. '.split(' ').map((w) => `${w} `);
      for (const w of words.slice(0, 6)) {
        await sleep(scenario === 'cancel' ? 250 : delay);
        if (cancelled) { yield { type: 'run.cancelled' }; return; }
        yield { type: 'token', text: w };
      }
      if (scenario === 'cancel') { yield { type: 'run.cancelled' }; return; }

      if (scenario === 'error') {
        yield { type: 'retry', attempt: 1, delayMs: 1000, kind: 'auth' };
        await sleep(delay * 4);
        if (cancelled) { yield { type: 'run.cancelled' }; return; }
        yield { type: 'run.failed', error: { kind: 'auth', message: 'mock: invalid API key', retryable: false } };
        return;
      }
      if (scenario === 'failover') {
        yield { type: 'retry', attempt: 1, delayMs: 500, kind: 'rate_limit' };
        await sleep(delay * 4);
        if (cancelled) { yield { type: 'run.cancelled' }; return; }
        yield { type: 'failover', from: model, to: 'mock-fallback', reason: 'rate_limit' };
        model = 'mock-fallback';
        await sleep(delay);
        yield { type: 'token', text: 'Carrying on with the backup model. ' };
        yield { type: 'run.completed', summary: 'finished on the backup model' };
        return;
      }

      if (mode === 'agent') {
        yield { type: 'tool.call', callId: 'c1', tool: 'repoMap', args: {}, thread: 'main' };
        yield { type: 'tool.result', callId: 'c1', ok: true, summary: 'listed 12 folders' };
        yield { type: 'budget', usedTokens: 900, limitTokens: 30000 };
        yield { type: 'context.report', items: [{ path: 'src/Counter.tsx', reason: 'path: counter; symbols: Counter', tokens: 420, source: 'auto' }] };
      }
      const proposal = await opts.getProposal?.();
      if (!proposal) { yield { type: 'run.completed', summary: 'nothing to change' }; return; }
      yield { type: 'tool.call', callId: 'c2', tool: 'proposeEdit', args: { path: proposal.path }, thread: 'main' };
      yield { type: 'proposal.created', proposal };
      proposalIds.push(proposal.id);
      const batchId = `mock-batch-${runs}`;
      // Get ready to hear the answer BEFORE announcing the review, so a quick reviewDone() or Stop is never missed.
      const pending = new Promise<ReviewResult | 'cancel'>((resolve) => { waiting = { batchId, resolve }; });
      if (cancelled) waiting?.resolve('cancel');
      yield { type: 'review.required', batchId, proposalIds };

      // The run is paused until the human finishes reviewing (or presses Stop).
      const answer = await pending;
      waiting = undefined;
      if (answer === 'cancel') {
        for (const id of proposalIds) yield { type: 'proposal.discarded', proposalId: id, reason: 'cancelled' };
        yield { type: 'run.cancelled' };
        return;
      }
      const applied = answer.proposals.filter((p) => p.applied).length;
      yield { type: 'run.completed', summary: applied > 0 ? `applied ${applied} file${applied === 1 ? '' : 's'}` : 'no changes applied' };
    } finally {
      active = false;
      waiting = undefined;
    }
  }

  return {
    runInline: (req: InlineRequest) => run('inline', req.prompt),
    runAgent: (req: AgentRequest) => run('agent', req.prompt),
    async cancel(): Promise<void> { cancelled = true; wake?.(); waiting?.resolve('cancel'); },
    async reviewDone(result: ReviewResult): Promise<void> { if (waiting && waiting.batchId === result.batchId) waiting.resolve(result); },
    async switchModel(profile: string): Promise<void> { model = profile === 'fallback' ? 'mock-fallback' : 'mock-primary'; },
    activeModel: () => model,
  };
}
