/**
 * MockEngine — scripted engine for S-01 bootstrap.
 *
 * Pre-scripted run that yields tokens, tool calls/results, context.report,
 * proposals (3 fixture paths), review.required and run.completed. Scenarios
 * are selected by prompt text: "mock:error", "mock:failover", "mock:cancel".
 *
 * Pure logic, vscode-free, unit-testable. No connection to TrueForge.
 */

export type Scenario =
  | 'default'
  | 'mock:error'
  | 'mock:failover'
  | 'mock:cancel';

export interface MockToolCall {
  callId: string;
  tool: string;
  args: unknown;
}

export interface MockProposal {
  path: string;
  hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; oldText: string; newText: string; status: 'pending' | 'accepted' | 'rejected' }[];
}

export interface MockRunPlan {
  scenario: Scenario;
  tokens: string[];
  toolCalls: MockToolCall[];
  contextReport?: { path: string; reason: string }[];
  proposals: MockProposal[];
  reviewBatchId: string;
  runCompleted: boolean;
}

const TOKENS =
  'The agent is exploring this repository. I will use tools to inspect the code and then propose changes.';

export interface FileProposal {
  id: string;
  callId: string;
  callIds: string[];
  path: string;
  isNewFile: boolean;
  base: { contentHash: string; version: number | null; wasDirty: boolean };
  originalContent: string;
  proposedContent: string;
  hunks: { id: string; oldStart: number; oldLines: number; newStart: number; newLines: number; oldText: string; newText: string; status: 'pending' | 'accepted' | 'rejected' }[];
  rationale: string;
  createdAt: number;
}

/**
 * Extends the contract EngineEvent with fields the mock needs.
 * Tool-side events mirror the contract; mock-specific flags are here.
 */
export interface MockEvent {
  type: 'run.started' | 'token' | 'tool.call' | 'tool.result' | 'context.report' | 'proposal.created' | 'review.required' | 'proposal.discarded' | 'retry' | 'failover' | 'run.completed' | 'run.cancelled' | 'run.failed';
  runId?: string;
  text?: string;
  callId?: string;
  tool?: string;
  args?: unknown;
  thread?: string;
  items?: { path: string; reason: string }[];
  proposal?: FileProposal;
  batchId?: string;
  proposalIds?: string[];
  ok?: boolean;
  model?: string;
  error?: { kind: string; message: string; retryable: boolean };
  from?: string;
  to?: string;
  reason?: string;
  summary?: string;
  attempt?: number;
  delayMs?: number;
}

/**
 * Build a scripted run plan from the scenario name in the prompt text.
 */
export function resolveScenario(prompt: string): Scenario {
  if (prompt.includes('mock:error')) return 'mock:error';
  if (prompt.includes('mock:failover')) return 'mock:failover';
  if (prompt.includes('mock:cancel')) return 'mock:cancel';
  return 'default';
}

/**
 * Stub that yields a fixed stream of events for the mock scenario.
 */
export async function* runMock(
  scenario: Scenario,
  prompt: string,
  runId: string,
  _mode: 'inline' | 'agent',
): AsyncIterable<MockEvent> {
  const plan = buildPlan(scenario, prompt);
  const eventSource: MockEvent[] = [];


  // run.started
  eventSource.push({ type: 'run.started', runId, model: 'mock-model' });

  // tokens
  for (const t of plan.tokens) {
    if (t === '<abort>') break;
    eventSource.push({ type: 'token', text: t });
  }

  // tool calls / results
  for (const call of plan.toolCalls) {
    if (call.tool === 'proposeEdit') {
      // Mock MCP acknowledgement (no write)
      eventSource.push({ type: 'tool.call', callId: call.callId, tool: call.tool, args: call.args, thread: 'main' });
      eventSource.push({ type: 'tool.result', callId: call.callId, ok: true, summary: 'acknowledged, awaiting review' });
    } else if (call.tool === 'reportContext') {
      eventSource.push({ type: 'tool.call', callId: call.callId, tool: call.tool, args: call.args, thread: 'main' });
      if (plan.contextReport) {
        eventSource.push({ type: 'context.report', items: plan.contextReport });
      }
    } else if (call.tool === 'runCommand') {
      eventSource.push({ type: 'tool.call', callId: call.callId, tool: call.tool, args: call.args, thread: 'main' });
      eventSource.push({ type: 'tool.result', callId: call.callId, ok: true, summary: 'exit 0: tests passed' });
    } else {
      eventSource.push({ type: 'tool.call', callId: call.callId, tool: call.tool, args: call.args, thread: 'main' });
      eventSource.push({ type: 'tool.result', callId: call.callId, ok: true, summary: 'mock result' });
    }
  }

  // proposals (from fixture demo paths)
  for (const _p of plan.proposals) {
    eventSource.push({ type: 'proposal.created', proposal: toFileProposal(_p) });
  }

  // review required
    const proposalIds: string[] = [];
  for (let _i = 0; _i < plan.proposals.length; _i++) {
    proposalIds.push(`p${_i}`);
  }
  eventSource.push({ type: 'review.required', batchId: plan.reviewBatchId, proposalIds });

  // terminal event
  if (scenario === 'mock:error') {
    eventSource.push({ type: 'run.failed', error: { kind: 'unknown', message: 'mock failure', retryable: false } });
  } else if (scenario === 'mock:failover') {
    eventSource.push({ type: 'failover', from: 'forge-primary', to: 'forge-fallback', reason: 'model' });
    eventSource.push({ type: 'run.completed', summary: 'ran on fallback' });
  } else if (scenario === 'mock:cancel') {
    eventSource.push({ type: 'run.cancelled' });
  } else {
    eventSource.push({ type: 'run.completed', summary: 'mock run complete' });
  }

  for (const e of eventSource) {
    yield e;
  }
}

export function buildPlan(scenario: Scenario, _prompt: string): MockRunPlan {
  if (scenario === 'mock:error') {
    return {
      scenario,
      tokens: ['error', 'stream'],
      toolCalls: [{ callId: 'c-error-1', tool: 'reportContext', args: {} }],
      reviewBatchId: 'batch-error-1',
      runCompleted: false,
      proposals: [],
    };
  }
  if (scenario === 'mock:failover') {
    return {
      scenario,
      tokens: ['failed', 'falling', 'back'],
      toolCalls: [{ callId: 'c-fof-1', tool: 'reportContext', args: {} }],
      reviewBatchId: 'batch-fof-1',
      runCompleted: false,
      proposals: [],
    };
  }
  if (scenario === 'mock:cancel') {
    return {
      scenario,
      tokens: ['cancelling'],
      toolCalls: [{ callId: 'c-cancel-1', tool: 'reportContext', args: {} }],
      reviewBatchId: 'batch-cancel-1',
      runCompleted: false,
      proposals: [],
    };
  }
  // default
  return {
    scenario,
    tokens: TOKENS.split(' '),
    toolCalls: [
      { callId: 'c1', tool: 'repoMap', args: {} },
      { callId: 'c2', tool: 'reportContext', args: {} },
      { callId: 'c3', tool: 'proposeEdit', args: { path: 'src/foo.ts', edits: [], rationale: 'demo' } },
      { callId: 'c4', tool: 'proposeEdit', args: { path: 'src/bar.ts', edits: [], rationale: 'demo' } },
      { callId: 'c5', tool: 'proposeEdit', args: { path: 'docs/readme.md', edits: [], rationale: 'demo' } },
    ],
    contextReport: [{ path: 'src/foo.ts', reason: 'demo proposal' }],
    proposals: [
      { path: 'src/foo.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, oldText: '', newText: 'x', status: 'pending' }] },
      { path: 'src/bar.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, oldText: '', newText: 'y', status: 'pending' }] },
      { path: 'docs/readme.md', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, oldText: '', newText: 'z', status: 'pending' }] },
    ],
    reviewBatchId: 'batch-demo-1',
    runCompleted: true,
  };
}

export function toFileProposal(p: MockProposal): FileProposal {
  return {
    id: 'demo-' + Math.random().toString(16).slice(2),
    callId: 'call-rep-' + p.path,
    callIds: [p.path],
    path: p.path,
    isNewFile: false,
    base: { contentHash: '0'.repeat(64), version: null, wasDirty: false },
    originalContent: 'mock original',
    proposedContent: 'mock proposed',
    hunks: p.hunks.map((h, i) => ({ ...h, id: `h${i + 1}` })),
    rationale: 'demo rationale',
    createdAt: Date.now(),
  };
}
