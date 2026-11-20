/**
 * Unit tests for ApprovalBridge and approval coordination (Milestone E-06).
 *
 * Verifies:
 * - Single proposal accept (submitApprovals with allow, no createTurn)
 * - Reject all (submitApprovals with deny and truthful reason)
 * - Partial accept (allow sent, rejected hunk IDs tracked in DecisionStore)
 * - Stale file rejection (deny with stale message)
 * - Apply failure rejection (deny with apply_failed message)
 * - Two proposals in one batch (fan-out and single submitApprovals batch)
 * - Grouped proposals (decision fan-out to all folded callIds)
 * - Mixed pauses (pre-denied edit-match failure held and submitted together with reviewed calls in ONE resume)
 * - Edit-match failure retry counting (per-run, per-path, max 2 retries, reset on success, empty on new run)
 * - Shared DecisionStore verification with E-05 handlers (handleProposeEdit / handleCreateFile truthful sentences)
 * - anyHunkApplied boolean tracking
 * - Cancellation while awaiting review (proposals discarded reason: 'cancelled', no submitApprovals, run.cancelled)
 * - Stream reconnection: Case 1 (stream remains open) vs Case 2 (stream ends at pause, reconnected via subscribeTurn)
 * - submitApprovals network/HTTP failure (fails with run.failed, never hangs)
 * - 2-hour timeout (vi.advanceTimersByTime fails cleanly)
 * - Stale/unknown batchId in reviewDone ignored
 * - reviewDone after cancel ignored
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import type { UiHost, EngineEvent } from '../../src/types/contract.ts';
import { SessionOrchestrator } from '../../src/engine/SessionOrchestrator.ts';
import { ApprovalBridge, REVIEW_WAIT_TIMEOUT_MS } from '../../src/engine/approvalBridge.ts';
import { type EngineConfig } from '../../src/engine/config.ts';
import {
  ForgeClient,
  NetworkError,
  type RawEvent,
} from '../../src/engine/ForgeClient.ts';

function createMockConfig(): EngineConfig {
  return {
    setup: {
      baseUrl: 'http://127.0.0.1:8790',
      isLoopback: true,
      rejectedNonLoopback: false,
      agents: {
        primary: 'primary-agent',
        fallback: 'fallback-agent',
      },
      mcp: {
        name: 'test-mcp',
        port: 8795,
        path: '/mcp',
        perWorkspace: false,
      },
      budgets: {
        seedTokens: 1000,
        mentionsTokens: 500,
        runToolBudgetTokens: 10000,
        maxToolCalls: 10,
        maxRunSeconds: 60,
      },
      retry: {
        max: 3,
        baseDelayMs: 100,
      },
    },
    models: {
      profiles: {
        primary: {
          agent: 'primary-agent',
          provider: 'test-provider',
          modelId: 'primary-model-id',
          kind: 'primary',
          modelContextTokens: 32000,
        },
        fallback: {
          agent: 'fallback-agent',
          provider: 'test-provider',
          modelId: 'fallback-model-id',
          kind: 'fallback',
          modelContextTokens: 32000,
        },
      },
    },
  };
}

function createMockHost(files?: Record<string, string>): UiHost {
  const fileStore = new Map<string, string>(
    Object.entries(files ?? {
      'src/file.ts': 'line 1\nline 2\nline 3\n',
    })
  );

  return {
    workspaceRoot: path.resolve(process.cwd()),
    isWorkspaceTrusted: () => true,
    context: {
      resolveMention: async () => null,
      seed: async () => [{ path: 'src/file.ts', reason: 'seed', tokens: 4, source: 'auto' }],
      search: async () => ({ hits: [], omitted: 0 }),
      findSymbol: async () => ({ symbols: [] }),
      repoMap: async () => ({ tree: '', truncated: false }),
    },
    snapshot: async (p: string) => {
      const text = fileStore.get(p) ?? '';
      return {
        path: p,
        exists: fileStore.has(p),
        text,
        version: 1,
        isDirty: false,
        contentHash: `hash-${text.length}`,
      };
    },
    readFile: async (p: string) => fileStore.get(p) ?? '',
    runCommand: async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      killed: false,
    }),
    confirmCommand: async () => true,
  };
}

describe('ApprovalBridge and Turn Resumption (Milestone E-06)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('single proposal accept: submitApprovals called with allow (no createTurn for resume)', async () => {
    const config = createMockConfig();
    const host = createMockHost({ 'src/file.ts': 'hello world\n' });
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-e06-single');
    const submitSpy = vi.spyOn(client, 'submitApprovals').mockResolvedValue({ eventIds: ['ev-allow'] });
    const createTurnSpy = vi.spyOn(client, 'createTurn');

    async function* turnEvents() {
      yield {
        id: '1',
        event: 'message',
        data: {
          type: 'turn.created',
          turn_id: 'turn-single-1',
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '2',
        event: 'message',
        data: {
          type: 'model.message.delta',
          id: 'msg_1',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              index: 0,
              id: 'call_edit_1',
              type: 'function',
              function: {
                name: 'proposeEdit',
                arguments: JSON.stringify({
                  path: 'src/file.ts',
                  edits: [{ oldText: 'hello world', newText: 'hello forge' }],
                  rationale: 'say forge',
                }),
              },
            },
          ],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '3',
        event: 'message',
        data: {
          type: 'tool.approval_required',
          id: 'appr_1',
          thread_id: 'main',
          tool_calls: [{ id: 'call_edit_1', source_event_id: 'msg_1' }],
        },
        rawData: '',
      } as RawEvent;
      // SSE continues after approval submission
      yield {
        id: '4',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done', output: 'Applied edits successfully' } },
        rawData: '',
      } as RawEvent;
    }

    createTurnSpy.mockImplementation(() => turnEvents());

    const orchestrator = new SessionOrchestrator(host, client, config);
    const events: EngineEvent[] = [];

    const runPromise = (async () => {
      for await (const ev of orchestrator.runAgent({ prompt: 'edit file', mentions: [] })) {
        events.push(ev);
        if (ev.type === 'review.required') {
          expect(orchestrator.anyHunkApplied).toBe(false);
          await orchestrator.reviewDone({
            batchId: ev.batchId,
            proposals: [
              {
                proposalId: ev.proposalIds[0],
                decisions: { '0': 'accepted' },
                applied: true,
              },
            ],
          });
        }
      }
    })();

    await runPromise;

    // createTurn must be called exactly once at run start, NEVER for resume
    expect(createTurnSpy).toHaveBeenCalledTimes(1);

    // submitApprovals must be called with allow
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy).toHaveBeenCalledWith(
      'session-e06-single',
      'turn-single-1',
      [
        {
          type: 'user.tool_approval',
          thread_id: 'main',
          tool_call_id: 'call_edit_1',
          approval: { status: 'allow' },
        },
      ],
      expect.any(AbortSignal)
    );

    expect(orchestrator.anyHunkApplied).toBe(true);
    expect(events.some((e) => e.type === 'proposal.created')).toBe(true);
    expect(events.some((e) => e.type === 'review.required')).toBe(true);
    expect(events[events.length - 1]).toEqual({
      type: 'run.completed',
      summary: 'Applied edits successfully',
    });
  });

  it('reject all: submitApprovals called with deny and truthful rejection reason', async () => {
    const config = createMockConfig();
    const host = createMockHost({ 'src/file.ts': 'hello world\n' });
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-e06-reject');
    const submitSpy = vi.spyOn(client, 'submitApprovals').mockResolvedValue({ eventIds: ['ev-deny'] });

    async function* turnEvents() {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'turn.created', turn_id: 'turn-reject-1' },
        rawData: '',
      } as RawEvent;
      yield {
        id: '2',
        event: 'message',
        data: {
          type: 'model.message.delta',
          id: 'msg_2',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              index: 0,
              id: 'call_edit_2',
              type: 'function',
              function: {
                name: 'proposeEdit',
                arguments: JSON.stringify({
                  path: 'src/file.ts',
                  edits: [{ oldText: 'hello world', newText: 'goodbye world' }],
                  rationale: 'reject me',
                }),
              },
            },
          ],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '3',
        event: 'message',
        data: {
          type: 'tool.approval_required',
          id: 'appr_2',
          thread_id: 'main',
          tool_calls: [{ id: 'call_edit_2', source_event_id: 'msg_2' }],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '4',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done', output: 'Changes were rejected' } },
        rawData: '',
      } as RawEvent;
    }

    vi.spyOn(client, 'createTurn').mockImplementation(() => turnEvents());

    const orchestrator = new SessionOrchestrator(host, client, config);
    const events: EngineEvent[] = [];

    const runPromise = (async () => {
      for await (const ev of orchestrator.runAgent({ prompt: 'edit', mentions: [] })) {
        events.push(ev);
        if (ev.type === 'review.required') {
          await orchestrator.reviewDone({
            batchId: ev.batchId,
            proposals: [
              {
                proposalId: ev.proposalIds[0],
                decisions: { '0': 'rejected' },
                applied: false,
              },
            ],
          });
        }
      }
    })();

    await runPromise;

    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy).toHaveBeenCalledWith(
      'session-e06-reject',
      'turn-reject-1',
      [
        {
          type: 'user.tool_approval',
          thread_id: 'main',
          tool_call_id: 'call_edit_2',
          approval: {
            status: 'deny',
            reason: 'User rejected all changes to src/file.ts',
          },
        },
      ],
      expect.any(AbortSignal)
    );

    expect(orchestrator.anyHunkApplied).toBe(false);
  });

  it('partial accept: allow sent, rejected hunk IDs tracked in DecisionStore', async () => {
    const config = createMockConfig();
    const host = createMockHost({ 'src/file.ts': 'line 1\nline 2\nline 3\n' });
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-e06-partial');
    const submitSpy = vi.spyOn(client, 'submitApprovals').mockResolvedValue({ eventIds: ['ev-partial'] });

    async function* turnEvents() {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'turn.created', turn_id: 'turn-partial-1' },
        rawData: '',
      } as RawEvent;
      yield {
        id: '2',
        event: 'message',
        data: {
          type: 'model.message.delta',
          id: 'msg_3',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              index: 0,
              id: 'call_edit_3',
              type: 'function',
              function: {
                name: 'proposeEdit',
                arguments: JSON.stringify({
                  path: 'src/file.ts',
                  edits: [
                    { oldText: 'line 1', newText: 'line 1 modified' },
                    { oldText: 'line 3', newText: 'line 3 modified' },
                  ],
                  rationale: 'partial edit',
                }),
              },
            },
          ],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '3',
        event: 'message',
        data: {
          type: 'tool.approval_required',
          id: 'appr_3',
          thread_id: 'main',
          tool_calls: [{ id: 'call_edit_3', source_event_id: 'msg_3' }],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '4',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done' } },
        rawData: '',
      } as RawEvent;
    }

    vi.spyOn(client, 'createTurn').mockImplementation(() => turnEvents());

    const orchestrator = new SessionOrchestrator(host, client, config);
    let capturedProposalId = '';

    const handlers = orchestrator.getProposalHandlers();
    let activeResultText = '';

    const runPromise = (async () => {
      for await (const ev of orchestrator.runAgent({ prompt: 'edit', mentions: [] })) {
        if (ev.type === 'proposal.created') {
          capturedProposalId = ev.proposal.id;
        }
        if (ev.type === 'review.required') {
          // Accept hunk 0, reject hunk 1
          await orchestrator.reviewDone({
            batchId: ev.batchId,
            proposals: [
              {
                proposalId: capturedProposalId,
                decisions: { '0': 'accepted', '1': 'rejected' },
                applied: true,
              },
            ],
          });
          // Verify DecisionStore contains rejected hunk details during active run
          const activeResult = await handlers.proposeEdit(
            {
              path: 'src/file.ts',
              edits: [
                { oldText: 'line 1', newText: 'line 1 modified' },
                { oldText: 'line 3', newText: 'line 3 modified' },
              ],
              rationale: 'partial edit',
            },
            { host, callOptions: { toolCallId: 'call_edit_3' } } as any
          );
          activeResultText = activeResult.content[0].text;
        }
      }
    })();

    await runPromise;

    expect(submitSpy).toHaveBeenCalledWith(
      'session-e06-partial',
      'turn-partial-1',
      [
        {
          type: 'user.tool_approval',
          thread_id: 'main',
          tool_call_id: 'call_edit_3',
          approval: { status: 'allow' },
        },
      ],
      expect.any(AbortSignal)
    );

    expect(orchestrator.anyHunkApplied).toBe(true);
    expect(activeResultText).toContain('Applied 1 of 2 hunks to src/file.ts (rejected: 1)');

    // Verify after run completion that proposeEdit returns 'no active run'
    const postRunResult = await handlers.proposeEdit(
      {
        path: 'src/file.ts',
        edits: [
          { oldText: 'line 1', newText: 'line 1 modified' },
          { oldText: 'line 3', newText: 'line 3 modified' },
        ],
        rationale: 'partial edit',
      },
      { host, callOptions: { toolCallId: 'call_edit_3' } } as any
    );
    expect(postRunResult.content[0].text).toBe('no active run');
    expect(postRunResult.isError).toBe(true);
  });

  it('stale failure: submitApprovals called with deny and stale message', async () => {
    const config = createMockConfig();
    const host = createMockHost({ 'src/file.ts': 'base content\n' });
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-e06-stale');
    const submitSpy = vi.spyOn(client, 'submitApprovals').mockResolvedValue({ eventIds: ['ev-stale'] });

    async function* turnEvents() {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'turn.created', turn_id: 'turn-stale-1' },
        rawData: '',
      } as RawEvent;
      yield {
        id: '2',
        event: 'message',
        data: {
          type: 'model.message.delta',
          id: 'msg_stale',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              index: 0,
              id: 'call_stale_1',
              type: 'function',
              function: {
                name: 'proposeEdit',
                arguments: JSON.stringify({
                  path: 'src/file.ts',
                  edits: [{ oldText: 'base content', newText: 'new content' }],
                  rationale: 'stale test',
                }),
              },
            },
          ],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '3',
        event: 'message',
        data: {
          type: 'tool.approval_required',
          id: 'appr_stale',
          thread_id: 'main',
          tool_calls: [{ id: 'call_stale_1', source_event_id: 'msg_stale' }],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '4',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done' } },
        rawData: '',
      } as RawEvent;
    }

    vi.spyOn(client, 'createTurn').mockImplementation(() => turnEvents());

    const orchestrator = new SessionOrchestrator(host, client, config);

    const runPromise = (async () => {
      for await (const ev of orchestrator.runAgent({ prompt: 'stale test', mentions: [] })) {
        if (ev.type === 'review.required') {
          await orchestrator.reviewDone({
            batchId: ev.batchId,
            proposals: [
              {
                proposalId: ev.proposalIds[0],
                decisions: { '0': 'accepted' },
                applied: false,
                failure: {
                  kind: 'stale',
                  message: 'File changed since proposal; re-read and re-propose',
                },
              },
            ],
          });
        }
      }
    })();

    await runPromise;

    expect(submitSpy).toHaveBeenCalledWith(
      'session-e06-stale',
      'turn-stale-1',
      [
        {
          type: 'user.tool_approval',
          thread_id: 'main',
          tool_call_id: 'call_stale_1',
          approval: {
            status: 'deny',
            reason: 'Technical failure (file changed on disk, not a user rejection): File changed since proposal; re-read and re-propose. Re-read the file and propose again only if needed.',
          },
        },
      ],
      expect.any(AbortSignal)
    );
  });

  it('apply failure: submitApprovals called with deny and apply_failed message', async () => {
    const config = createMockConfig();
    const host = createMockHost({ 'src/file.ts': 'base content\n' });
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-e06-apply-fail');
    const submitSpy = vi.spyOn(client, 'submitApprovals').mockResolvedValue({ eventIds: ['ev-apply-fail'] });

    async function* turnEvents() {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'turn.created', turn_id: 'turn-apply-fail-1' },
        rawData: '',
      } as RawEvent;
      yield {
        id: '2',
        event: 'message',
        data: {
          type: 'model.message.delta',
          id: 'msg_af',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              index: 0,
              id: 'call_af_1',
              type: 'function',
              function: {
                name: 'proposeEdit',
                arguments: JSON.stringify({
                  path: 'src/file.ts',
                  edits: [{ oldText: 'base content', newText: 'new content' }],
                  rationale: 'apply fail test',
                }),
              },
            },
          ],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '3',
        event: 'message',
        data: {
          type: 'tool.approval_required',
          id: 'appr_af',
          thread_id: 'main',
          tool_calls: [{ id: 'call_af_1', source_event_id: 'msg_af' }],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '4',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done' } },
        rawData: '',
      } as RawEvent;
    }

    vi.spyOn(client, 'createTurn').mockImplementation(() => turnEvents());

    const orchestrator = new SessionOrchestrator(host, client, config);

    const runPromise = (async () => {
      for await (const ev of orchestrator.runAgent({ prompt: 'apply fail test', mentions: [] })) {
        if (ev.type === 'review.required') {
          await orchestrator.reviewDone({
            batchId: ev.batchId,
            proposals: [
              {
                proposalId: ev.proposalIds[0],
                decisions: { '0': 'accepted' },
                applied: false,
                failure: { kind: 'apply_failed', message: 'Custom write failure' },
              },
            ],
          });
        }
      }
    })();

    await runPromise;

    expect(submitSpy).toHaveBeenCalledWith(
      'session-e06-apply-fail',
      'turn-apply-fail-1',
      [
        {
          type: 'user.tool_approval',
          thread_id: 'main',
          tool_call_id: 'call_af_1',
          approval: {
            status: 'deny',
            reason: 'Technical failure applying changes (not a user rejection): Custom write failure. Re-read the file and propose again only if needed.',
          },
        },
      ],
      expect.any(AbortSignal)
    );
  });

  it('two proposals in one batch: single batchId, decisions fanned out and submitted together', async () => {
    const config = createMockConfig();
    const host = createMockHost({
      'src/a.ts': 'hello A\n',
      'src/b.ts': 'hello B\n',
    });
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-e06-two');
    const submitSpy = vi.spyOn(client, 'submitApprovals').mockResolvedValue({ eventIds: ['ev_a', 'ev_b'] });

    async function* turnEvents() {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'turn.created', turn_id: 'turn-two-1' },
        rawData: '',
      } as RawEvent;
      yield {
        id: '2',
        event: 'message',
        data: {
          type: 'model.message.delta',
          id: 'msg_parallel',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              index: 0,
              id: 'call_a',
              type: 'function',
              function: {
                name: 'proposeEdit',
                arguments: JSON.stringify({
                  path: 'src/a.ts',
                  edits: [{ oldText: 'hello A', newText: 'bye A' }],
                  rationale: 'edit a',
                }),
              },
            },
            {
              index: 1,
              id: 'call_b',
              type: 'function',
              function: {
                name: 'createFile',
                arguments: JSON.stringify({
                  path: 'src/c.ts',
                  content: 'new c file',
                  rationale: 'create c',
                }),
              },
            },
          ],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '3',
        event: 'message',
        data: {
          type: 'tool.approval_required',
          id: 'appr_parallel',
          thread_id: 'main',
          tool_calls: [
            { id: 'call_a', source_event_id: 'msg_parallel' },
            { id: 'call_b', source_event_id: 'msg_parallel' },
          ],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '4',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done' } },
        rawData: '',
      } as RawEvent;
    }

    vi.spyOn(client, 'createTurn').mockImplementation(() => turnEvents());

    const orchestrator = new SessionOrchestrator(host, client, config);

    const runPromise = (async () => {
      for await (const ev of orchestrator.runAgent({ prompt: 'two tools', mentions: [] })) {
        if (ev.type === 'review.required') {
          expect(ev.proposalIds.length).toBe(2);
          // Accept first, reject second
          await orchestrator.reviewDone({
            batchId: ev.batchId,
            proposals: [
              {
                proposalId: ev.proposalIds[0],
                decisions: { '0': 'accepted' },
                applied: true,
              },
              {
                proposalId: ev.proposalIds[1],
                decisions: { '0': 'rejected' },
                applied: false,
              },
            ],
          });
        }
      }
    })();

    await runPromise;

    expect(submitSpy).toHaveBeenCalledTimes(1);
    const submittedApprovals = submitSpy.mock.calls[0][2];
    expect(submittedApprovals.length).toBe(2);
    expect(submittedApprovals).toEqual([
      {
        type: 'user.tool_approval',
        thread_id: 'main',
        tool_call_id: 'call_a',
        approval: { status: 'allow' },
      },
      {
        type: 'user.tool_approval',
        thread_id: 'main',
        tool_call_id: 'call_b',
        approval: { status: 'deny', reason: 'User rejected creation of src/c.ts' },
      },
    ]);
  });

  it('mixed pauses: pre-denied edit failure held and sent together with reviewed calls in ONE submitApprovals', async () => {
    const config = createMockConfig();
    const host = createMockHost({
      'src/valid.ts': 'valid text\n',
    });
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-e06-mixed');
    const submitSpy = vi.spyOn(client, 'submitApprovals').mockResolvedValue({ eventIds: ['ev_valid', 'ev_fail'] });

    async function* turnEvents() {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'turn.created', turn_id: 'turn-mixed-1' },
        rawData: '',
      } as RawEvent;
      yield {
        id: '2',
        event: 'message',
        data: {
          type: 'model.message.delta',
          id: 'msg_mixed',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              index: 0,
              id: 'call_fail',
              type: 'function',
              function: {
                name: 'proposeEdit',
                arguments: JSON.stringify({
                  path: 'src/valid.ts',
                  edits: [{ oldText: 'nonexistent match target', newText: 'replaced' }],
                  rationale: 'fail edit',
                }),
              },
            },
            {
              index: 1,
              id: 'call_ok',
              type: 'function',
              function: {
                name: 'createFile',
                arguments: JSON.stringify({
                  path: 'src/newfile.ts',
                  content: 'file content',
                  rationale: 'new file',
                }),
              },
            },
          ],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '3',
        event: 'message',
        data: {
          type: 'tool.approval_required',
          id: 'appr_mixed',
          thread_id: 'main',
          tool_calls: [
            { id: 'call_fail', source_event_id: 'msg_mixed' },
            { id: 'call_ok', source_event_id: 'msg_mixed' },
          ],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '4',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done' } },
        rawData: '',
      } as RawEvent;
    }

    vi.spyOn(client, 'createTurn').mockImplementation(() => turnEvents());

    const orchestrator = new SessionOrchestrator(host, client, config);

    const runPromise = (async () => {
      for await (const ev of orchestrator.runAgent({ prompt: 'mixed', mentions: [] })) {
        if (ev.type === 'review.required') {
          // Only call_ok requires human review; call_fail was pre-denied
          expect(ev.proposalIds.length).toBe(1);
          await orchestrator.reviewDone({
            batchId: ev.batchId,
            proposals: [
              {
                proposalId: ev.proposalIds[0],
                decisions: { '0': 'accepted' },
                applied: true,
              },
            ],
          });
        }
      }
    })();

    await runPromise;

    // Both pre-denied and reviewed approvals MUST be submitted together in ONE call
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const approvals = submitSpy.mock.calls[0][2] as any[];
    expect(approvals.length).toBe(2);

    const allowItem = approvals.find((a: any) => a.tool_call_id === 'call_ok');
    const denyItem = approvals.find((a: any) => a.tool_call_id === 'call_fail');

    expect(allowItem?.approval?.status).toBe('allow');
    expect(denyItem?.approval?.status).toBe('deny');
    expect(denyItem?.approval?.reason).toContain('matched 0 times in src/valid.ts');
  });

  it('edit-match failure retry counting: max 2 retries per path per run then proposal.discarded(error)', async () => {
    const host = createMockHost({ 'src/test.ts': 'original content\n' });
    const bridge = new ApprovalBridge(host);
    const signal = new AbortController().signal;

    expect(bridge.getRetryCount('src/test.ts')).toBe(0);

    const events: EngineEvent[] = [];
    const emitEvent = (ev: EngineEvent) => events.push(ev);

    // Attempt 1: match failure -> retryCount becomes 1
    const pause1 = [
      {
        callId: 'call_fail_1',
        threadId: 'main',
        sourceEventId: 'ev_1',
        toolName: 'proposeEdit',
        args: {
          path: 'src/test.ts',
          edits: [{ oldText: 'no match', newText: 'replacement' }],
        },
      },
    ];

    const res1 = await bridge.handlePause(pause1, 's1', 't1', signal, emitEvent);
    expect(bridge.getRetryCount('src/test.ts')).toBe(1);
    expect(res1.approvals[0].approval.status).toBe('deny');
    expect(events.filter((e) => e.type === 'proposal.discarded').length).toBe(0);

    // Attempt 2: match failure -> retryCount becomes 2 -> proposal.discarded(error) emitted
    const pause2 = [
      {
        callId: 'call_fail_2',
        threadId: 'main',
        sourceEventId: 'ev_2',
        toolName: 'proposeEdit',
        args: {
          path: 'src/test.ts',
          edits: [{ oldText: 'still no match', newText: 'replacement' }],
        },
      },
    ];

    const res2 = await bridge.handlePause(pause2, 's1', 't1', signal, emitEvent);
    expect(bridge.getRetryCount('src/test.ts')).toBe(2);
    expect(res2.approvals[0].approval.status).toBe('deny');

    const discardedEvents = events.filter((e) => e.type === 'proposal.discarded');
    expect(discardedEvents.length).toBe(1);
    expect(discardedEvents[0]).toEqual({
      type: 'proposal.discarded',
      proposalId: 'discard-call_fail_2',
      reason: 'error',
    });

    // Attempt 3: successful edit resets retryCount for src/test.ts back to 0
    const pause3 = [
      {
        callId: 'call_ok_3',
        threadId: 'main',
        sourceEventId: 'ev_3',
        toolName: 'proposeEdit',
        args: {
          path: 'src/test.ts',
          edits: [{ oldText: 'original content', newText: 'replacement' }],
        },
      },
    ];

    const emitEvent3 = (ev: EngineEvent) => {
      events.push(ev);
      if (ev.type === 'review.required') {
        bridge.reviewDone({
          batchId: ev.batchId,
          proposals: [{ proposalId: ev.proposalIds[0], decisions: { '0': 'accepted' }, applied: true }],
        });
      }
    };

    await bridge.handlePause(pause3, 's1', 't1', signal, emitEvent3);
    expect(bridge.getRetryCount('src/test.ts')).toBe(0);

    // A fresh bridge for a new run starts with retryCount 0
    const freshBridge = new ApprovalBridge(host);
    expect(freshBridge.getRetryCount('src/test.ts')).toBe(0);
  });

  it('shared DecisionStore verification: E-05 handlers return truthful sentences after review decision recorded', async () => {
    const config = createMockConfig();
    const host = createMockHost({ 'src/sample.ts': 'alpha\nbeta\n' });
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-shared-store');
    vi.spyOn(client, 'submitApprovals').mockResolvedValue({ eventIds: ['ev_shared'] });

    async function* turnEvents() {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'turn.created', turn_id: 'turn-shared-1' },
        rawData: '',
      } as RawEvent;
      yield {
        id: '2',
        event: 'message',
        data: {
          type: 'model.message.delta',
          id: 'msg_shared',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              index: 0,
              id: 'call_shared_1',
              type: 'function',
              function: {
                name: 'proposeEdit',
                arguments: JSON.stringify({
                  path: 'src/sample.ts',
                  edits: [{ oldText: 'alpha', newText: 'gamma' }],
                  rationale: 'update alpha',
                }),
              },
            },
          ],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '3',
        event: 'message',
        data: {
          type: 'tool.approval_required',
          id: 'appr_shared',
          thread_id: 'main',
          tool_calls: [{ id: 'call_shared_1', source_event_id: 'msg_shared' }],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '4',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done' } },
        rawData: '',
      } as RawEvent;
    }

    vi.spyOn(client, 'createTurn').mockImplementation(() => turnEvents());

    const orchestrator = new SessionOrchestrator(host, client, config);

    const handlers = orchestrator.getProposalHandlers();
    let activeResultText = '';

    const runPromise = (async () => {
      for await (const ev of orchestrator.runAgent({ prompt: 'test', mentions: [] })) {
        if (ev.type === 'review.required') {
          // Review done records decision in DecisionStore BEFORE submitApprovals
          await orchestrator.reviewDone({
            batchId: ev.batchId,
            proposals: [
              {
                proposalId: ev.proposalIds[0],
                decisions: { '0': 'accepted' },
                applied: true,
              },
            ],
          });
          // During the active run, call handlers.proposeEdit and verify truthful sentence matches docs/01 §4.1
          const activeResult = await handlers.proposeEdit(
            {
              path: 'src/sample.ts',
              edits: [{ oldText: 'alpha', newText: 'gamma' }],
              rationale: 'update alpha',
            },
            { host, callOptions: { toolCallId: 'call_shared_1' } } as any
          );
          activeResultText = activeResult.content[0].text;
        }
      }
    })();

    await runPromise;

    expect(activeResultText).toBe(
      'Applied 1 of 1 hunks to src/sample.ts. The file on disk now contains only the accepted hunks. Re-read before editing again.'
    );

    // After run completion, verify proposeEdit returns 'no active run'
    const postRunResult = await handlers.proposeEdit(
      {
        path: 'src/sample.ts',
        edits: [{ oldText: 'alpha', newText: 'gamma' }],
        rationale: 'update alpha',
      },
      { host, callOptions: { toolCallId: 'call_shared_1' } } as any
    );

    expect(postRunResult.content[0].text).toBe('no active run');
    expect(postRunResult.isError).toBe(true);
  });

  it('cancel while awaiting review: proposals discarded with reason cancelled, no submitApprovals, run.cancelled emitted', async () => {
    const config = createMockConfig();
    const host = createMockHost({ 'src/cancel.ts': 'content\n' });
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-cancel');
    const submitSpy = vi.spyOn(client, 'submitApprovals');

    async function* turnEvents() {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'turn.created', turn_id: 'turn-cancel-1' },
        rawData: '',
      } as RawEvent;
      yield {
        id: '2',
        event: 'message',
        data: {
          type: 'model.message.delta',
          id: 'msg_cancel',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              index: 0,
              id: 'call_cancel_1',
              type: 'function',
              function: {
                name: 'proposeEdit',
                arguments: JSON.stringify({
                  path: 'src/cancel.ts',
                  edits: [{ oldText: 'content', newText: 'cancelled content' }],
                  rationale: 'cancel me',
                }),
              },
            },
          ],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '3',
        event: 'message',
        data: {
          type: 'tool.approval_required',
          id: 'appr_cancel',
          thread_id: 'main',
          tool_calls: [{ id: 'call_cancel_1', source_event_id: 'msg_cancel' }],
        },
        rawData: '',
      } as RawEvent;
    }

    vi.spyOn(client, 'createTurn').mockImplementation(() => turnEvents());

    const orchestrator = new SessionOrchestrator(host, client, config);
    const events: EngineEvent[] = [];

    const runPromise = (async () => {
      for await (const ev of orchestrator.runAgent({ prompt: 'cancel test', mentions: [] })) {
        events.push(ev);
        if (ev.type === 'review.required') {
          // Cancel during human review wait
          await orchestrator.cancel();
        }
      }
    })();

    await runPromise;

    // submitApprovals must NEVER be called on cancel
    expect(submitSpy).not.toHaveBeenCalled();

    // proposal.discarded with reason 'cancelled' must be emitted
    const discarded = events.find((e) => e.type === 'proposal.discarded');
    expect(discarded).toEqual({
      type: 'proposal.discarded',
      proposalId: expect.any(String),
      reason: 'cancelled',
    });

    // Exactly one run.cancelled terminal event
    expect(events[events.length - 1]).toEqual({ type: 'run.cancelled' });
  });

  it('stream reconnection: Case 2 (stream ends at pause) reconnects via subscribeTurn to finish turn', async () => {
    const config = createMockConfig();
    const host = createMockHost({ 'src/reconnect.ts': 'text\n' });
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-reconnect');
    vi.spyOn(client, 'submitApprovals').mockResolvedValue({ eventIds: ['ev_rec'] });

    // Initial stream ends right after tool.approval_required (like 03-allow-turn1.jsonl)
    async function* initialTurnEvents() {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'turn.created', turn_id: 'turn-rec-1' },
        rawData: '',
      } as RawEvent;
      yield {
        id: '2',
        event: 'message',
        data: {
          type: 'model.message.delta',
          id: 'msg_rec',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              index: 0,
              id: 'call_rec',
              type: 'function',
              function: {
                name: 'createFile',
                arguments: JSON.stringify({ path: 'src/created.ts', content: 'created', rationale: 'rec' }),
              },
            },
          ],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '3',
        event: 'message',
        data: {
          type: 'tool.approval_required',
          id: 'appr_rec',
          thread_id: 'main',
          tool_calls: [{ id: 'call_rec', source_event_id: 'msg_rec' }],
        },
        rawData: '',
      } as RawEvent;
      // Stream terminates at pause!
    }

    // subscribeTurn resumes from afterEventId (like 03-allow-resume-sse.jsonl)
    async function* resumedTurnEvents() {
      yield {
        id: '4',
        event: 'message',
        data: {
          type: 'turn.update',
          state: { status: 'running' },
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '5',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done', output: 'Reconnected and finished' } },
        rawData: '',
      } as RawEvent;
    }

    vi.spyOn(client, 'createTurn').mockImplementation(() => initialTurnEvents());
    const subscribeSpy = vi.spyOn(client, 'subscribeTurn').mockImplementation(() => resumedTurnEvents());

    const orchestrator = new SessionOrchestrator(host, client, config);
    const events: EngineEvent[] = [];

    const runPromise = (async () => {
      for await (const ev of orchestrator.runAgent({ prompt: 'reconnect', mentions: [] })) {
        events.push(ev);
        if (ev.type === 'review.required') {
          await orchestrator.reviewDone({
            batchId: ev.batchId,
            proposals: [{ proposalId: ev.proposalIds[0], decisions: { '0': 'accepted' }, applied: true }],
          });
        }
      }
    })();

    await runPromise;

    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(subscribeSpy).toHaveBeenCalledWith(
      'session-reconnect',
      'turn-rec-1',
      {
        afterEventId: 'appr_rec',
        signal: expect.any(AbortSignal),
      }
    );

    expect(events[events.length - 1]).toEqual({
      type: 'run.completed',
      summary: 'Reconnected and finished',
    });
  });

  it('submitApprovals network failure: fails cleanly with run.failed, never hangs', async () => {
    const config = createMockConfig();
    const host = createMockHost({ 'src/fail.ts': 'fail content\n' });
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-submit-fail');
    vi.spyOn(client, 'submitApprovals').mockRejectedValue(
      new NetworkError('ECONNRESET', new Error('Connection reset by peer'))
    );

    async function* turnEvents() {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'turn.created', turn_id: 'turn-sf-1' },
        rawData: '',
      } as RawEvent;
      yield {
        id: '2',
        event: 'message',
        data: {
          type: 'model.message.delta',
          id: 'msg_sf',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              index: 0,
              id: 'call_sf',
              type: 'function',
              function: {
                name: 'createFile',
                arguments: JSON.stringify({ path: 'src/sf.ts', content: 'test', rationale: 'sf' }),
              },
            },
          ],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '3',
        event: 'message',
        data: {
          type: 'tool.approval_required',
          id: 'appr_sf',
          thread_id: 'main',
          tool_calls: [{ id: 'call_sf', source_event_id: 'msg_sf' }],
        },
        rawData: '',
      } as RawEvent;
    }

    vi.spyOn(client, 'createTurn').mockImplementation(() => turnEvents());

    const orchestrator = new SessionOrchestrator(host, client, config);
    const events: EngineEvent[] = [];

    const runPromise = (async () => {
      for await (const ev of orchestrator.runAgent({ prompt: 'sf', mentions: [] })) {
        events.push(ev);
        if (ev.type === 'review.required') {
          await orchestrator.reviewDone({
            batchId: ev.batchId,
            proposals: [{ proposalId: ev.proposalIds[0], decisions: { '0': 'accepted' }, applied: true }],
          });
        }
      }
    })();

    await runPromise;

    expect(events[events.length - 1]).toEqual({
      type: 'run.failed',
      error: {
        kind: 'unreachable',
        message: 'Changes already applied to workspace; failover replay disabled to prevent duplicate application.',
        retryable: false,
      },
    });
  });

  it('2-hour timeout: fake timer advances 2 hours -> fails with timeout error', async () => {
    vi.useFakeTimers();

    const host = createMockHost({ 'src/timeout.ts': 'content\n' });
    const bridge = new ApprovalBridge(host);
    const signal = new AbortController().signal;

    const pause = [
      {
        callId: 'call_to',
        threadId: 'main',
        sourceEventId: 'ev_to',
        toolName: 'createFile',
        args: { path: 'src/to.ts', content: 'c', rationale: 'r' },
      },
    ];

    const handlePromise = bridge.handlePause(pause, 's_to', 't_to', signal, () => {});

    // Advance timer past the 2-hour timeout threshold
    vi.advanceTimersByTime(REVIEW_WAIT_TIMEOUT_MS + 1000);

    await expect(handlePromise).rejects.toThrow('Review wait timed out after 2 hours');
  });

  it('stale or unknown batchId in reviewDone: safely ignored', async () => {
    const host = createMockHost({ 'src/test.ts': 'content\n' });
    const bridge = new ApprovalBridge(host);
    const signal = new AbortController().signal;

    let reviewReqBatchId = '';
    let reviewReqProposalId = '';
    const pausePromise = bridge.handlePause(
      [
        {
          callId: 'call_ign',
          threadId: 'main',
          sourceEventId: 'ev_ign',
          toolName: 'createFile',
          args: { path: 'src/ign.ts', content: 'test', rationale: 'ign' },
        },
      ],
      's_ign',
      't_ign',
      signal,
      (ev) => {
        if (ev.type === 'review.required') {
          reviewReqBatchId = ev.batchId;
          reviewReqProposalId = ev.proposalIds[0];
        }
      }
    );

    // Call reviewDone with wrong batchId -> must be ignored
    bridge.reviewDone({
      batchId: 'wrong-batch-id',
      proposals: [{ proposalId: 'any', decisions: { '0': 'accepted' }, applied: true }],
    });

    // Call reviewDone with valid batchId -> succeeds
    bridge.reviewDone({
      batchId: reviewReqBatchId,
      proposals: [{ proposalId: reviewReqProposalId, decisions: { '0': 'accepted' }, applied: true }],
    });

    const res = await pausePromise;
    expect(res.approvals.length).toBe(1);
    expect(res.approvals[0].approval.status).toBe('allow');
  });

  it('reviewDone after cancel: safely ignored', async () => {
    const host = createMockHost({ 'src/test.ts': 'content\n' });
    const bridge = new ApprovalBridge(host);
    const controller = new AbortController();

    const pausePromise = bridge.handlePause(
      [
        {
          callId: 'call_after_cancel',
          threadId: 'main',
          sourceEventId: 'ev_cancel',
          toolName: 'createFile',
          args: { path: 'src/after.ts', content: 'test', rationale: 'after' },
        },
      ],
      's_cancel',
      't_cancel',
      controller.signal,
      () => {}
    );

    // Cancel bridge
    bridge.cancel();

    // Calling reviewDone after cancel must not throw and must be ignored
    expect(() => {
      bridge.reviewDone({
        batchId: 'batch-test',
        proposals: [{ proposalId: 'p1', decisions: { '0': 'accepted' }, applied: true }],
      });
    }).not.toThrow();

    await expect(pausePromise).rejects.toThrow('Run cancelled during review wait');
  });

  it('multiple sequential pauses in one run (pause -> review -> resume -> pause -> review -> resume -> done)', async () => {
    const config = createMockConfig();
    const host = createMockHost({ 'src/test.ts': 'original\n' });
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-seq-pauses');
    const submitSpy = vi.spyOn(client, 'submitApprovals')
      .mockResolvedValueOnce({ eventIds: ['ev_res_1'] })
      .mockResolvedValueOnce({ eventIds: ['ev_res_2'] });

    async function* turnEvents() {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'turn.created', turn_id: 'turn-seq-1' },
        rawData: '',
      } as RawEvent;
      // Step 1: First gated call
      yield {
        id: '2',
        event: 'message',
        data: {
          type: 'model.message.delta',
          id: 'msg_seq_1',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              index: 0,
              id: 'call_seq_1',
              type: 'function',
              function: {
                name: 'createFile',
                arguments: JSON.stringify({ path: 'src/f1.ts', content: 'f1 content', rationale: 'first' }),
              },
            },
          ],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '3',
        event: 'message',
        data: {
          type: 'tool.approval_required',
          id: 'appr_seq_1',
          thread_id: 'main',
          tool_calls: [{ id: 'call_seq_1', source_event_id: 'msg_seq_1' }],
        },
        rawData: '',
      } as RawEvent;
      // Resumed after first review
      yield {
        id: '4',
        event: 'message',
        data: { type: 'turn.update', state: { status: 'running' } },
        rawData: '',
      } as RawEvent;
      yield {
        id: '5',
        event: 'message',
        data: {
          type: 'tool.response',
          id: 'resp_seq_1',
          tool_call_id: 'call_seq_1',
          content: 'Created src/f1.ts',
        },
        rawData: '',
      } as RawEvent;
      // Step 2: Second gated call
      yield {
        id: '6',
        event: 'message',
        data: {
          type: 'model.message.delta',
          id: 'msg_seq_2',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              index: 0,
              id: 'call_seq_2',
              type: 'function',
              function: {
                name: 'createFile',
                arguments: JSON.stringify({ path: 'src/f2.ts', content: 'f2 content', rationale: 'second' }),
              },
            },
          ],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '7',
        event: 'message',
        data: {
          type: 'tool.approval_required',
          id: 'appr_seq_2',
          thread_id: 'main',
          tool_calls: [{ id: 'call_seq_2', source_event_id: 'msg_seq_2' }],
        },
        rawData: '',
      } as RawEvent;
      // Resumed after second review
      yield {
        id: '8',
        event: 'message',
        data: { type: 'turn.update', state: { status: 'running' } },
        rawData: '',
      } as RawEvent;
      yield {
        id: '9',
        event: 'message',
        data: {
          type: 'tool.response',
          id: 'resp_seq_2',
          tool_call_id: 'call_seq_2',
          content: 'Created src/f2.ts',
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '10',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done', output: 'Both files created' } },
        rawData: '',
      } as RawEvent;
    }

    vi.spyOn(client, 'createTurn').mockImplementation(() => turnEvents());

    const orchestrator = new SessionOrchestrator(host, client, config);
    const events: EngineEvent[] = [];

    const runPromise = (async () => {
      for await (const ev of orchestrator.runAgent({ prompt: 'create two files in sequence', mentions: [] })) {
        events.push(ev);
        if (ev.type === 'review.required') {
          await orchestrator.reviewDone({
            batchId: ev.batchId,
            proposals: [{ proposalId: ev.proposalIds[0], decisions: { '0': 'accepted' }, applied: true }],
          });
        }
      }
    })();

    await runPromise;

    expect(submitSpy).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'review.required').length).toBe(2);
    expect(events[events.length - 1]).toEqual({
      type: 'run.completed',
      summary: 'Both files created',
    });
  });

  it('gated proposeEdit plus non-gated readFile in same model message (spike Q5)', async () => {
    const config = createMockConfig();
    const host = createMockHost({ 'src/file.ts': 'line 1\nline 2\n' });
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-q5-mixed');
    const submitSpy = vi.spyOn(client, 'submitApprovals').mockResolvedValue({ eventIds: ['ev_edit'] });

    async function* turnEvents() {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'turn.created', turn_id: 'turn-q5-1' },
        rawData: '',
      } as RawEvent;
      // Single model message delta containing 1 non-gated call (readFile) and 1 gated call (proposeEdit)
      yield {
        id: '2',
        event: 'message',
        data: {
          type: 'model.message.delta',
          id: 'msg_q5',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              index: 0,
              id: 'call_read',
              type: 'function',
              function: {
                name: 'readFile',
                arguments: JSON.stringify({ path: 'src/file.ts' }),
              },
            },
            {
              index: 1,
              id: 'call_edit',
              type: 'function',
              function: {
                name: 'proposeEdit',
                arguments: JSON.stringify({
                  path: 'src/file.ts',
                  edits: [{ oldText: 'line 1', newText: 'line 1 edited' }],
                  rationale: 'edit after read',
                }),
              },
            },
          ],
        },
        rawData: '',
      } as RawEvent;
      // Non-gated tool responds immediately without approval
      yield {
        id: '3',
        event: 'message',
        data: {
          type: 'tool.response',
          id: 'resp_read',
          tool_call_id: 'call_read',
          content: 'line 1\nline 2\n',
        },
        rawData: '',
      } as RawEvent;
      // Only the gated call requires approval
      yield {
        id: '4',
        event: 'message',
        data: {
          type: 'tool.approval_required',
          id: 'appr_q5',
          thread_id: 'main',
          tool_calls: [{ id: 'call_edit', source_event_id: 'msg_q5' }],
        },
        rawData: '',
      } as RawEvent;
      // After approval submitted
      yield {
        id: '5',
        event: 'message',
        data: { type: 'turn.update', state: { status: 'running' } },
        rawData: '',
      } as RawEvent;
      yield {
        id: '6',
        event: 'message',
        data: {
          type: 'tool.response',
          id: 'resp_edit',
          tool_call_id: 'call_edit',
          content: 'Applied 1 of 1 hunks',
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '7',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done', output: 'Read and edited' } },
        rawData: '',
      } as RawEvent;
    }

    vi.spyOn(client, 'createTurn').mockImplementation(() => turnEvents());

    const orchestrator = new SessionOrchestrator(host, client, config);
    const events: EngineEvent[] = [];

    const runPromise = (async () => {
      for await (const ev of orchestrator.runAgent({ prompt: 'read and edit', mentions: [] })) {
        events.push(ev);
        if (ev.type === 'review.required') {
          // Verify only the gated call was proposed for review
          expect(ev.proposalIds.length).toBe(1);
          await orchestrator.reviewDone({
            batchId: ev.batchId,
            proposals: [{ proposalId: ev.proposalIds[0], decisions: { '0': 'accepted' }, applied: true }],
          });
        }
      }
    })();

    await runPromise;

    // Both tool calls were announced
    const toolCalls = events.filter((e) => e.type === 'tool.call');
    expect(toolCalls.length).toBe(2);
    expect(toolCalls.some((c: any) => c.tool === 'readFile')).toBe(true);
    expect(toolCalls.some((c: any) => c.tool === 'proposeEdit')).toBe(true);

    // Non-gated tool result was delivered
    const toolResults = events.filter((e) => e.type === 'tool.result');
    expect(toolResults.some((r: any) => r.callId === 'call_read')).toBe(true);

    // Only gated call was submitted for approval
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy).toHaveBeenCalledWith(
      'session-q5-mixed',
      'turn-q5-1',
      [
        {
          type: 'user.tool_approval',
          thread_id: 'main',
          tool_call_id: 'call_edit',
          approval: { status: 'allow' },
        },
      ],
      expect.any(AbortSignal)
    );

    expect(events[events.length - 1]).toEqual({
      type: 'run.completed',
      summary: 'Read and edited',
    });
  });
});
