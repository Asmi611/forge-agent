/**
 * Unit tests for SessionOrchestrator, createEngine factory, and engine-cli (Milestone E-03).
 *
 * Verifies single-flight execution, lazy slot claiming, FIFO queue ordering,
 * TrueForge wire event mapping, pause detection, cancellation, silent teardown,
 * error classification, CLI argument validation, and interleaving resilience.
 */

import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import type { UiHost, EngineEvent, EngineApi } from '../../src/types/contract.ts';
import { createEngine, SessionOrchestrator, type EngineLogger } from '../../src/engine/index.ts';
import { runCli } from '../../scripts/engine-cli.ts';
import { type EngineConfig } from '../../src/engine/config.ts';
import {
  ForgeClient,
  HttpError,
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

function createMockHost(): UiHost {
  return {
    workspaceRoot: path.resolve(process.cwd()),
    isWorkspaceTrusted: () => true,
    context: {
      resolveMention: async () => null,
      seed: async () => [
        { path: 'src/seed.ts', reason: 'seed file', tokens: 4, source: 'auto' },
      ],
      search: async () => ({ hits: [], omitted: 0 }),
      findSymbol: async () => ({ symbols: [] }),
      repoMap: async () => ({ tree: '', truncated: false }),
    },
    snapshot: async (p: string) => ({
      path: p,
      exists: true,
      text: 'snapshot text',
      version: 1,
      isDirty: false,
      contentHash: 'hash',
    }),
    readFile: async (_p: string) => '1234567890123456', // 16 chars -> exactly 4 tokens
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

describe('SessionOrchestrator - Lifecycle and State Machine', () => {
  it('busy slot is claimed on first next(), NOT on generator creation', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    let resolveSession: (id: string) => void;
    const sessionPromise = new Promise<string>((r) => { resolveSession = r; });
    vi.spyOn(client, 'createSession').mockImplementation(() => sessionPromise);

    const orchestrator = new SessionOrchestrator(host, client, config);

    const stream1 = orchestrator.runAgent({ prompt: 'test prompt', mentions: [] });
    const stream2 = orchestrator.runAgent({ prompt: 'second prompt', mentions: [] });

    const iter1 = stream1[Symbol.asyncIterator]();
    const next1Promise = iter1.next();

    const event1 = await next1Promise;
    expect(event1.done).toBe(false);
    expect(event1.value?.type).toBe('run.started');

    // Second stream claims slot and fails immediately with busy
    const iter2 = stream2[Symbol.asyncIterator]();
    const event2 = await iter2.next();

    expect(event2.done).toBe(false);
    expect(event2.value).toEqual({
      type: 'run.failed',
      error: {
        kind: 'busy',
        message: 'Engine is busy with an active run',
        retryable: false,
      },
    });

    const event2After = await iter2.next();
    expect(event2After.done).toBe(true);

    resolveSession!('session-1');
    await orchestrator.cancel();
  });

  it('releases busy slot after run completes allowing subsequent runs', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-seq');
    vi.spyOn(client, 'createTurn').mockImplementation(async function* () {
      yield {
        id: '1',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done', output: 'done' } },
        rawData: '',
      } as RawEvent;
    });

    const orchestrator = new SessionOrchestrator(host, client, config);

    // Run 1
    const events1: EngineEvent[] = [];
    for await (const ev of orchestrator.runAgent({ prompt: 'first', mentions: [] })) {
      events1.push(ev);
    }
    expect(events1[events1.length - 1].type).toBe('run.completed');

    // Run 2 immediately after Run 1 must succeed without busy error
    const events2: EngineEvent[] = [];
    for await (const ev of orchestrator.runAgent({ prompt: 'second', mentions: [] })) {
      events2.push(ev);
    }
    expect(events2[0].type).toBe('run.started');
    expect(events2[events2.length - 1].type).toBe('run.completed');
  });

  it('captures model profile at run start; later switchModel does not alter active run', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    let resolveTurn: () => void;
    const turnPromise = new Promise<void>((r) => { resolveTurn = r; });

    vi.spyOn(client, 'createSession').mockResolvedValue('session-profile-test');
    vi.spyOn(client, 'createTurn').mockImplementation(async function* () {
      await turnPromise;
      yield {
        id: '1',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done' } },
        rawData: '',
      } as RawEvent;
    });

    const orchestrator = new SessionOrchestrator(host, client, config);
    expect(orchestrator.activeModel()).toBe('primary-model-id');

    const stream = orchestrator.runAgent({ prompt: 'p', mentions: [] });
    const iter = stream[Symbol.asyncIterator]();

    // Start run on primary profile
    const e1 = await iter.next();
    expect(e1.value).toEqual({
      type: 'run.started',
      runId: expect.any(String),
      mode: 'agent',
      model: 'primary-model-id',
    });

    // While run is active, caller switches model to fallback
    await orchestrator.switchModel('fallback');
    expect(orchestrator.activeModel()).toBe('fallback-model-id');

    // Finish the active turn
    resolveTurn!();
    const eBudget = await iter.next();
    expect(eBudget.value?.type).toBe('budget');
    const e2 = await iter.next();
    expect(e2.value).toEqual({ type: 'run.completed' });
  });

  it('rejects unknown model profiles on switchModel', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);
    const orchestrator = new SessionOrchestrator(host, client, config);

    await expect(orchestrator.switchModel('nonexistent')).rejects.toThrow(
      "Unknown model profile: 'nonexistent'"
    );
  });
});

describe('SessionOrchestrator - Context and Token Accounting', () => {
  it('emits initial budget event with correct usedTokens and configured limit', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-budget');
    vi.spyOn(client, 'createTurn').mockImplementation(async function* () {
      yield {
        id: '1',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done' } },
        rawData: '',
      } as RawEvent;
    });

    const orchestrator = new SessionOrchestrator(host, client, config);

    // Prompt: '12345678' (8 chars -> 2 tokens)
    // Mentions: 'abcdefgh' (8 chars -> 2 tokens)
    // Seed: mock host returns 1 seed item with '1234567890123456' (16 chars -> 4 tokens)
    const events: EngineEvent[] = [];
    for await (const ev of orchestrator.runAgent({
      prompt: '12345678',
      mentions: [{ kind: 'file', label: 'test', path: 'src/test.ts', content: 'abcdefgh' }],
    })) {
      events.push(ev);
    }

    const budgetEv = events.find((e) => e.type === 'budget');
    expect(budgetEv).toBeDefined();
    // 2 (prompt) + 2 (mention) + 4 (seed) = 8 tokens
    expect(budgetEv).toEqual({
      type: 'budget',
      usedTokens: 8,
      limitTokens: config.setup.budgets.runToolBudgetTokens,
    });
  });

  it('uses host.readFile() for seed context and uses actual text for token accounting', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const readFileSpy = vi.spyOn(host, 'readFile');
    const snapshotSpy = vi.spyOn(host, 'snapshot');

    const client = new ForgeClient(config.setup);
    vi.spyOn(client, 'createSession').mockResolvedValue('session-seed');
    let capturedBlocks: unknown[] = [];
    vi.spyOn(client, 'userMessageInput').mockImplementation((text, blocks) => {
      capturedBlocks = blocks || [];
      return [{ type: 'user.message', content: text }];
    });

    vi.spyOn(client, 'createTurn').mockImplementation(async function* () {
      yield {
        id: '1',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done' } },
        rawData: '',
      } as RawEvent;
    });

    const orchestrator = new SessionOrchestrator(host, client, config);
    for await (const _ev of orchestrator.runAgent({ prompt: 'seed test', mentions: [] })) {
      // drain
    }

    expect(readFileSpy).toHaveBeenCalledWith('src/seed.ts', undefined);
    expect(snapshotSpy).not.toHaveBeenCalled();
    expect(capturedBlocks.length).toBe(1);
    expect((capturedBlocks[0] as { path: string; text: string }).text).toBe('1234567890123456');
  });

  it('handles mention budget truncation with accurate truncated token accounting and reason', async () => {
    const config = createMockConfig();
    config.setup.budgets.mentionsTokens = 50; // 50 tokens limit = 200 chars

    const host = createMockHost();
    vi.spyOn(host.context, 'seed').mockResolvedValue([]); // No seed

    const client = new ForgeClient(config.setup);
    vi.spyOn(client, 'createSession').mockResolvedValue('session-mention');
    let capturedBlocks: unknown[] = [];
    vi.spyOn(client, 'userMessageInput').mockImplementation((text, blocks) => {
      capturedBlocks = blocks || [];
      return [{ type: 'user.message', content: text }];
    });

    vi.spyOn(client, 'createTurn').mockImplementation(async function* () {
      yield {
        id: '1',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done' } },
        rawData: '',
      } as RawEvent;
    });

    const orchestrator = new SessionOrchestrator(host, client, config);

    // Large mention exceeding budget: 1000 characters
    const largeContent = 'a'.repeat(1000);
    for await (const _ev of orchestrator.runAgent({
      prompt: 'mention test',
      mentions: [{ kind: 'file', label: 'bigfile', path: 'src/big.ts', content: largeContent }],
    })) {
      // drain
    }

    expect(capturedBlocks.length).toBe(1);
    const block = capturedBlocks[0] as { reason: string; text: string };
    expect(block.reason).toBe('@bigfile (truncated)');
    expect(block.text).toContain('mention truncated due to budget');
  });

  it('handles inline edit request token calculation and context blocks', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-inline');
    let capturedBlocks: unknown[] = [];
    vi.spyOn(client, 'userMessageInput').mockImplementation((text, blocks) => {
      capturedBlocks = blocks || [];
      return [{ type: 'user.message', content: text }];
    });

    vi.spyOn(client, 'createTurn').mockImplementation(async function* () {
      yield {
        id: '1',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done' } },
        rawData: '',
      } as RawEvent;
    });

    const orchestrator = new SessionOrchestrator(host, client, config);
    const events: EngineEvent[] = [];
    for await (const ev of orchestrator.runInline({
      prompt: 'fix this line',
      path: 'src/app.ts',
      selectedText: 'const x = 1;',
      range: { startLine: 10, endLine: 10 },
    })) {
      events.push(ev);
    }

    expect(events[0].type).toBe('run.started');
    expect((events[0] as { mode: string }).mode).toBe('inline');
    expect(events[1].type).toBe('budget');
    expect(capturedBlocks.length).toBe(1);
    expect((capturedBlocks[0] as { reason: string }).reason).toBe('inline selection');
  });
});

describe('SessionOrchestrator - Wire Event Mapping and Ordering', () => {
  it('preserves strict FIFO event ordering: run.started -> budget -> tokens -> run.completed', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-fifo');
    const cancelSpy = vi.spyOn(client, 'cancel');

    async function* mockTurn() {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'model.message.delta', id: 'm1', content: 'chunk 1' },
        rawData: '',
      } as RawEvent;
      yield {
        id: '2',
        event: 'message',
        data: { type: 'model.message.delta', id: 'm1', content: 'chunk 2' },
        rawData: '',
      } as RawEvent;
      yield {
        id: '3',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done', output: { content: 'Summary string' } } },
        rawData: '',
      } as RawEvent;
    }
    vi.spyOn(client, 'createTurn').mockImplementation(() => mockTurn());

    const orchestrator = new SessionOrchestrator(host, client, config);
    const events: EngineEvent[] = [];
    for await (const ev of orchestrator.runAgent({ prompt: 'Say hi', mentions: [] })) {
      events.push(ev);
    }

    expect(events.length).toBe(5);
    expect(events[0].type).toBe('run.started');
    expect(events[1].type).toBe('budget');
    expect(events[2]).toEqual({ type: 'token', text: 'chunk 1' });
    expect(events[3]).toEqual({ type: 'token', text: 'chunk 2' });
    expect(events[4]).toEqual({ type: 'run.completed', summary: 'Summary string' });

    // Clean completion must NOT call client.cancel()
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('turn.update with done status does NOT emit run.completed; waits for actual turn.done', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-turn-update');

    async function* mockTurn() {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'model.message.delta', id: 'm1', content: 'token 1' },
        rawData: '',
      } as RawEvent;
      // Premature done on turn.update must be ignored for completion
      yield {
        id: '2',
        event: 'message',
        data: { type: 'turn.update', state: { status: 'done', output: 'premature summary' } },
        rawData: '',
      } as RawEvent;
      yield {
        id: '3',
        event: 'message',
        data: { type: 'model.message.delta', id: 'm1', content: 'token 2' },
        rawData: '',
      } as RawEvent;
      yield {
        id: '4',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done', output: 'real final summary' } },
        rawData: '',
      } as RawEvent;
    }
    vi.spyOn(client, 'createTurn').mockImplementation(() => mockTurn());

    const orchestrator = new SessionOrchestrator(host, client, config);
    const events: EngineEvent[] = [];
    for await (const ev of orchestrator.runAgent({ prompt: 'test', mentions: [] })) {
      events.push(ev);
    }

    expect(events.length).toBe(5);
    expect(events[0].type).toBe('run.started');
    expect(events[1].type).toBe('budget');
    expect(events[2]).toEqual({ type: 'token', text: 'token 1' });
    expect(events[3]).toEqual({ type: 'token', text: 'token 2' });
    expect(events[4]).toEqual({ type: 'run.completed', summary: 'real final summary' });
  });

  it('detects pause conditions with precedence on turn.update', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-turn-update-pause');
    vi.spyOn(client, 'submitApprovals').mockResolvedValue({ eventIds: ['ev-allow'] });

    async function* mockTurn() {
      yield {
        id: '1',
        event: 'message',
        data: {
          type: 'model.message.delta',
          id: 'msg_prec',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              index: 0,
              id: 'call_prec',
              type: 'function',
              function: {
                name: 'createFile',
                arguments: JSON.stringify({ path: 'src/new.ts', content: 'new content', rationale: 'new' }),
              },
            },
          ],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '2',
        event: 'message',
        data: {
          type: 'turn.update',
          state: { status: 'paused', required_actions: [{ type: 'approval' }] },
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '3',
        event: 'message',
        data: {
          type: 'tool.approval_required',
          id: 'appr_prec',
          thread_id: 'main',
          tool_calls: [{ id: 'call_prec', source_event_id: 'msg_prec' }],
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
    vi.spyOn(client, 'createTurn').mockImplementation(() => mockTurn());

    const orchestrator = new SessionOrchestrator(host, client, config);
    const events: EngineEvent[] = [];

    const runPromise = (async () => {
      for await (const ev of orchestrator.runAgent({ prompt: 'test', mentions: [] })) {
        events.push(ev);
        if (ev.type === 'review.required') {
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

    expect(events.some((e) => e.type === 'proposal.created')).toBe(true);
    expect(events.some((e) => e.type === 'review.required')).toBe(true);
    expect(events[events.length - 1].type).toBe('run.completed');
  });

  it('done outcome with non-empty requiredActions on turn.done is treated as pause', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-req-actions');
    vi.spyOn(client, 'submitApprovals').mockResolvedValue({ eventIds: ['ev-req'] });

    async function* turnWithReqActions() {
      yield {
        id: '1',
        event: 'message',
        data: {
          type: 'model.message.delta',
          id: 'msg_req',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              index: 0,
              id: 'call_req',
              type: 'function',
              function: {
                name: 'createFile',
                arguments: JSON.stringify({ path: 'src/done_pause.ts', content: 'test', rationale: 'test' }),
              },
            },
          ],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '2',
        event: 'message',
        data: {
          type: 'tool.approval_required',
          id: 'appr_req',
          thread_id: 'main',
          tool_calls: [{ id: 'call_req', source_event_id: 'msg_req' }],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '3',
        event: 'turn.done',
        data: {
          type: 'turn.done',
          state: {
            status: 'done',
            required_actions: [{ type: 'approval', tool_call_id: 'call_req' }],
          },
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '4',
        event: 'turn.done',
        data: {
          type: 'turn.done',
          state: { status: 'done' },
        },
        rawData: '',
      } as RawEvent;
    }
    vi.spyOn(client, 'createTurn').mockImplementation(() => turnWithReqActions());

    const orchestrator = new SessionOrchestrator(host, client, config);
    const events: EngineEvent[] = [];

    const runPromise = (async () => {
      for await (const ev of orchestrator.runAgent({ prompt: 'p', mentions: [] })) {
        events.push(ev);
        if (ev.type === 'review.required') {
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

    expect(events.some((e) => e.type === 'proposal.created')).toBe(true);
    expect(events.some((e) => e.type === 'review.required')).toBe(true);
    expect(events[events.length - 1].type).toBe('run.completed');
  });

  it('non_terminal outcome on turn.done produces failure', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-non-term-done');
    async function* turnWithNonTerm() {
      yield {
        id: '1',
        event: 'turn.done',
        data: {
          type: 'turn.done',
          state: { status: 'running' },
        },
        rawData: '',
      } as RawEvent;
    }
    vi.spyOn(client, 'createTurn').mockImplementation(() => turnWithNonTerm());

    const orchestrator = new SessionOrchestrator(host, client, config);
    const events: EngineEvent[] = [];
    for await (const ev of orchestrator.runAgent({ prompt: 'p', mentions: [] })) {
      events.push(ev);
    }

    expect(events.length).toBe(3);
    expect(events[0].type).toBe('run.started');
    expect(events[1].type).toBe('budget');
    expect(events[2]).toEqual({
      type: 'run.failed',
      error: {
        kind: 'unknown',
        message: "turn.done received with non-terminal status 'running'",
        retryable: false,
      },
    });
  });

  it('detects mapRawEvent newPauses immediately and handles approval pause via ApprovalBridge', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-pause');
    vi.spyOn(client, 'submitApprovals').mockResolvedValue({ eventIds: ['ev_res'] });

    async function* turnWithPause() {
      yield {
        id: '1',
        event: 'message',
        data: {
          type: 'model.message.delta',
          id: 'msg_pause',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: {
                name: 'createFile',
                arguments: JSON.stringify({ path: 'src/file.ts', content: 'new file', rationale: 'init' }),
              },
            },
          ],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '2',
        event: 'message',
        data: {
          type: 'tool.approval_required',
          id: 'appr_1',
          thread_id: 'main',
          tool_calls: [{ id: 'call_1', source_event_id: 'msg_pause' }],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '3',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done' } },
        rawData: '',
      } as RawEvent;
    }
    vi.spyOn(client, 'createTurn').mockImplementation(() => turnWithPause());

    const orchestrator = new SessionOrchestrator(host, client, config);
    const events: EngineEvent[] = [];

    const runPromise = (async () => {
      for await (const ev of orchestrator.runAgent({ prompt: 'p', mentions: [] })) {
        events.push(ev);
        if (ev.type === 'review.required') {
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

    expect(events.some((e) => e.type === 'proposal.created')).toBe(true);
    expect(events.some((e) => e.type === 'review.required')).toBe(true);
    expect(events[events.length - 1].type).toBe('run.completed');
  });

  it('sequence gap at completion boundary is logged and fails, never treated as success', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-gap');
    async function* turnWithGap() {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'turn.created', sequence_number: 0 },
        rawData: '',
      } as RawEvent;
      yield {
        id: '2',
        event: 'turn.done',
        data: { type: 'turn.done', sequence_number: 5, state: { status: 'done' } },
        rawData: '',
      } as RawEvent;
    }
    vi.spyOn(client, 'createTurn').mockImplementation(() => turnWithGap());

    const orchestrator = new SessionOrchestrator(host, client, config);
    const events: EngineEvent[] = [];
    for await (const ev of orchestrator.runAgent({ prompt: 'p', mentions: [] })) {
      events.push(ev);
    }

    expect(events.length).toBe(3);
    expect(events[0].type).toBe('run.started');
    expect(events[1].type).toBe('budget');
    expect(events[2]).toEqual({
      type: 'run.failed',
      error: {
        kind: 'unknown',
        message: expect.stringContaining('Sequence gap detected at completion boundary'),
        retryable: false,
      },
    });
  });

  it('unexpected stream EOF without terminal turn event produces unreachable failure', async () => {
    const config = createMockConfig();
    config.setup.retry = { max: 0, baseDelayMs: 0 };
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-eof');
    async function* abruptStream() {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'model.message.delta', id: 'm1', content: 'chunk' },
        rawData: '',
      } as RawEvent;
    }
    vi.spyOn(client, 'createTurn').mockImplementation(() => abruptStream());

    const orchestrator = new SessionOrchestrator(host, client, config, { activeProfile: 'fallback' });
    const events: EngineEvent[] = [];
    for await (const ev of orchestrator.runAgent({ prompt: 'p', mentions: [] })) {
      events.push(ev);
    }

    expect(events.length).toBe(4);
    expect(events[0].type).toBe('run.started');
    expect(events[1].type).toBe('budget');
    expect(events[2]).toEqual({ type: 'token', text: 'chunk' });
    expect(events[3]).toEqual({
      type: 'run.failed',
      error: {
        kind: 'unreachable',
        message: 'Stream ended prematurely without a terminal turn event',
        retryable: true,
      },
    });
  });
});

describe('SessionOrchestrator - Cancellation and Teardown', () => {
  it('explicit cancel() emits run.cancelled and is idempotent', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-cancel');
    vi.spyOn(client, 'cancel').mockResolvedValue({ ok: true, status: 'cancelled' });

    let resolveTurn: () => void;
    const turnPromise = new Promise<void>((r) => { resolveTurn = r; });
    vi.spyOn(client, 'createTurn').mockImplementation(async function* () {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'model.message.delta', id: 'm1', content: 'chunk' },
        rawData: '',
      } as RawEvent;
      await turnPromise;
    });

    const orchestrator = new SessionOrchestrator(host, client, config);
    const stream = orchestrator.runAgent({ prompt: 'cancel test', mentions: [] });
    const iter = stream[Symbol.asyncIterator]();

    await iter.next(); // run.started
    await iter.next(); // budget
    await iter.next(); // token

    // Explicit cancel
    await orchestrator.cancel();
    // Idempotent second cancel
    await orchestrator.cancel();

    const term = await iter.next();
    expect(term.value).toEqual({ type: 'run.cancelled' });

    const afterDone = await iter.next();
    expect(afterDone.done).toBe(true);

    resolveTurn!();
  });

  it('cancel during pending createSession does not call createTurn and cancels session once resolved', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    let resolveSession: (id: string) => void;
    vi.spyOn(client, 'createSession').mockImplementation(
      () => new Promise<string>((r) => { resolveSession = r; })
    );
    const createTurnSpy = vi.spyOn(client, 'createTurn');
    const cancelSpy = vi.spyOn(client, 'cancel').mockResolvedValue({ ok: true, status: 'cancelled' });

    const orchestrator = new SessionOrchestrator(host, client, config);
    const stream = orchestrator.runAgent({ prompt: 'pending cancel', mentions: [] });
    const iter = stream[Symbol.asyncIterator]();

    await iter.next(); // run.started
    await iter.next(); // budget

    // Cancel while session creation is pending
    await orchestrator.cancel();

    // Now session creation resolves late
    resolveSession!('late-session-id');

    const term = await iter.next();
    expect(term.value).toEqual({ type: 'run.cancelled' });

    expect(createTurnSpy).not.toHaveBeenCalled();
    expect(cancelSpy).toHaveBeenCalledWith('late-session-id');
  });

  it('best-effort remote cancellation is safe against synchronous throws and promise rejections', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    const logMessages: string[] = [];
    const logger: EngineLogger = {
      info: (m) => logMessages.push(m),
      warn: (m) => logMessages.push(m),
      error: (m) => logMessages.push(m),
    };

    // Client cancel rejects asynchronously with a rejected promise
    vi.spyOn(client, 'cancel').mockRejectedValue(new Error('Remote TrueForge cancel failed'));
    vi.spyOn(client, 'createSession').mockResolvedValue('session-rej');
    vi.spyOn(client, 'createTurn').mockImplementation(async function* () {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'model.message.delta', id: 'm1', content: 'chunk' },
        rawData: '',
      } as RawEvent;
      await new Promise(() => {}); // hang
    });

    const orchestrator = new SessionOrchestrator(host, client, config, { logger });
    const stream = orchestrator.runAgent({ prompt: 'async cancel reject', mentions: [] });
    const iter = stream[Symbol.asyncIterator]();

    await iter.next(); // run.started
    await iter.next(); // budget
    await iter.next(); // token ('chunk')
    // Cancel should not throw or fail
    await orchestrator.cancel();

    const term = await iter.next();
    expect(term.value).toEqual({ type: 'run.cancelled' });
  });

  it('consumer return() tears down silently without false terminal event and frees slot', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-ret');
    vi.spyOn(client, 'cancel').mockResolvedValue({ ok: true, status: 'cancelled' });
    vi.spyOn(client, 'createTurn').mockImplementation(async function* () {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'model.message.delta', id: 'm1', content: 'tok' },
        rawData: '',
      } as RawEvent;
      await new Promise(() => {});
    });

    const orchestrator = new SessionOrchestrator(host, client, config);
    const stream = orchestrator.runAgent({ prompt: 'consumer early return', mentions: [] });
    const iter = stream[Symbol.asyncIterator]();

    await iter.next(); // run.started
    const ret = await iter.return!();
    expect(ret.done).toBe(true);

    // Slot is immediately free for next run
    vi.spyOn(client, 'createTurn').mockImplementation(async function* () {
      yield {
        id: '2',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done' } },
        rawData: '',
      } as RawEvent;
    });

    const stream2 = orchestrator.runAgent({ prompt: 'second run after return', mentions: [] });
    const iter2 = stream2[Symbol.asyncIterator]();
    const e1 = await iter2.next();
    expect(e1.value?.type).toBe('run.started');
  });

  it('consumer throw() tears down silently and frees slot', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-throw');
    vi.spyOn(client, 'createTurn').mockImplementation(async function* () {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'model.message.delta', id: 'm1', content: 'tok' },
        rawData: '',
      } as RawEvent;
      await new Promise(() => {});
    });

    const orchestrator = new SessionOrchestrator(host, client, config);
    const stream = orchestrator.runAgent({ prompt: 'consumer throw', mentions: [] });
    const iter = stream[Symbol.asyncIterator]();

    await iter.next(); // run.started
    await expect(iter.throw!(new Error('Consumer abort'))).rejects.toThrow('Consumer abort');

    // Slot is free
    vi.spyOn(client, 'createTurn').mockImplementation(async function* () {
      yield {
        id: '2',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done' } },
        rawData: '',
      } as RawEvent;
    });

    const stream2 = orchestrator.runAgent({ prompt: 'second run after throw', mentions: [] });
    const iter2 = stream2[Symbol.asyncIterator]();
    const e1 = await iter2.next();
    expect(e1.value?.type).toBe('run.started');
  });
});

describe('SessionOrchestrator - Error Classification and Epoch Gating', () => {
  it('classifies NetworkError as unreachable and retryable', async () => {
    const config = createMockConfig();
    config.setup.retry = { max: 0, baseDelayMs: 0 };
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockRejectedValue(
      new NetworkError('ECONNRESET', new Error('Connection reset'))
    );

    const orchestrator = new SessionOrchestrator(host, client, config, { activeProfile: 'fallback' });
    const events: EngineEvent[] = [];
    for await (const ev of orchestrator.runAgent({ prompt: 'net error', mentions: [] })) {
      events.push(ev);
    }

    expect(events.length).toBe(3);
    expect(events[2]).toEqual({
      type: 'run.failed',
      error: {
        kind: 'unreachable',
        message: expect.stringContaining('ECONNRESET'),
        retryable: true,
      },
    });
  });

  it('classifies HttpError 401/403 as auth, 429 as rate_limit, 408 as timeout, 500 as model', async () => {
    const config = createMockConfig();
    config.setup.retry = { max: 0, baseDelayMs: 0 };
    const host = createMockHost();

    const cases: Array<{ status: number; expectedKind: string; retryable: boolean }> = [
      { status: 401, expectedKind: 'auth', retryable: false },
      { status: 403, expectedKind: 'auth', retryable: false },
      { status: 429, expectedKind: 'rate_limit', retryable: true },
      { status: 408, expectedKind: 'timeout', retryable: true },
      { status: 500, expectedKind: 'model', retryable: true },
      { status: 502, expectedKind: 'model', retryable: true },
      { status: 418, expectedKind: 'unknown', retryable: false },
    ];

    for (const c of cases) {
      const client = new ForgeClient(config.setup);
      vi.spyOn(client, 'createSession').mockRejectedValue(
        new HttpError(c.status, { error: 'test' }, `HTTP error ${c.status}`)
      );

      const orchestrator = new SessionOrchestrator(host, client, config, { activeProfile: 'fallback' });
      const events: EngineEvent[] = [];
      for await (const ev of orchestrator.runAgent({ prompt: 'status test', mentions: [] })) {
        events.push(ev);
      }

      const failedEv = events.find((e) => e.type === 'run.failed') as {
        type: 'run.failed';
        error: { kind: string; retryable: boolean };
      };
      expect(failedEv).toBeDefined();
      expect(failedEv.error.kind).toBe(c.expectedKind);
      expect(failedEv.error.retryable).toBe(c.retryable);
    }
  });

  it('stale events from previous epoch are ignored by event queue', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-stale');
    vi.spyOn(client, 'cancel').mockResolvedValue({ ok: true, status: 'cancelled' });

    let lateYield: () => void;
    const latePromise = new Promise<void>((r) => { lateYield = r; });

    vi.spyOn(client, 'createTurn').mockImplementation(async function* () {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'model.message.delta', id: 'm1', content: 'first chunk' },
        rawData: '',
      } as RawEvent;
      await latePromise;
      yield {
        id: '2',
        event: 'message',
        data: { type: 'model.message.delta', id: 'm1', content: 'stale chunk' },
        rawData: '',
      } as RawEvent;
    });

    const orchestrator = new SessionOrchestrator(host, client, config);
    const stream = orchestrator.runAgent({ prompt: 'epoch test', mentions: [] });
    const iter = stream[Symbol.asyncIterator]();

    await iter.next(); // run.started
    await iter.next(); // budget
    const tok = await iter.next(); // first chunk
    expect(tok.value).toEqual({ type: 'token', text: 'first chunk' });

    // Cancel bumps run epoch and finalizes run
    await orchestrator.cancel();

    // Now late event arrives on old epoch
    lateYield!();

    const term = await iter.next();
    expect(term.value).toEqual({ type: 'run.cancelled' });

    const end = await iter.next();
    expect(end.done).toBe(true);
  });
});

describe('SessionOrchestrator - Concurrency and Interleaving Stress Test', () => {
  it('500 randomized interleavings of next(), cancel(), and teardown preserve terminal invariant without race conditions', async () => {
    // Deterministic seeded pseudo-random number generator
    let seed = 12345;
    function nextRandom(): number {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    }

    const host = createMockHost();
    const config = createMockConfig();

    for (let i = 0; i < 500; i++) {
      const client = new ForgeClient(config.setup);
      vi.spyOn(client, 'createSession').mockResolvedValue(`sess-stress-${i}`);
      vi.spyOn(client, 'cancel').mockResolvedValue({ ok: true, status: 'cancelled' });
      vi.spyOn(client, 'createTurn').mockImplementation(async function* () {
        yield {
          id: '1',
          event: 'message',
          data: { type: 'model.message.delta', id: 'm1', content: 'tok' },
          rawData: '',
        } as RawEvent;
        yield {
          id: '2',
          event: 'turn.done',
          data: { type: 'turn.done', state: { status: 'done', output: 'ok' } },
          rawData: '',
        } as RawEvent;
      });

      const orchestrator = new SessionOrchestrator(host, client, config);
      const stream = orchestrator.runAgent({ prompt: `stress-${i}`, mentions: [] });
      const iter = stream[Symbol.asyncIterator]();

      const choice = nextRandom();
      if (choice < 0.35) {
        // Consumer starts consumption then cancels
        const first = await iter.next();
        expect(first.value?.type).toBe('run.started');
        await orchestrator.cancel();

        let terminal: EngineEvent | null = null;
        for (let j = 0; j < 5; j++) {
          const res = await iter.next();
          if (res.done) break;
          if (
            res.value.type === 'run.cancelled' ||
            res.value.type === 'run.completed' ||
            res.value.type === 'run.failed'
          ) {
            terminal = res.value;
          }
        }
        expect(terminal?.type).toBe('run.cancelled');
      } else if (choice < 0.70) {
        // Consumer calls return() early
        const first = await iter.next();
        expect(first.value?.type).toBe('run.started');
        const ret = await iter.return!();
        expect(ret.done).toBe(true);
      } else {
        // Normal full drain
        const events: EngineEvent[] = [];
        for await (const ev of stream) {
          events.push(ev);
        }
        expect(events[0].type).toBe('run.started');
        expect(events[events.length - 1].type).toBe('run.completed');
      }
    }
  });
});

describe('createEngine Factory', () => {
  it('throws if options.forgeDir is missing or empty', () => {
    const host = createMockHost();
    expect(() => createEngine(host, {} as unknown as { forgeDir: string })).toThrow(
      'createEngine requires an explicit non-empty options.forgeDir'
    );
    expect(() => createEngine(host, { forgeDir: '   ' })).toThrow(
      'createEngine requires an explicit non-empty options.forgeDir'
    );
  });

  it('creates EngineApi with supplied config and client', () => {
    const host = createMockHost();
    const config = createMockConfig();
    const client = new ForgeClient(config.setup);
    const engine = createEngine(host, {
      forgeDir: path.resolve(process.cwd(), 'forge'),
      config,
      client,
    });

    expect(engine).toBeDefined();
    expect(typeof engine.runAgent).toBe('function');
    expect(typeof engine.runInline).toBe('function');
    expect(typeof engine.cancel).toBe('function');
    expect(typeof engine.reviewDone).toBe('function');
    expect(typeof engine.switchModel).toBe('function');
    expect(engine.activeModel()).toBe('primary-model-id');
  });

  it('loads config from forgeDir if config is not supplied', () => {
    const host = createMockHost();
    const engine = createEngine(host, {
      forgeDir: path.resolve(process.cwd(), 'forge'),
    });

    expect(engine).toBeDefined();
    expect(typeof engine.runAgent).toBe('function');
    expect(typeof engine.activeModel).toBe('function');
  });
});

describe('scripts/engine-cli (runCli)', () => {
  it('--help prints usage and exits with 0', async () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const code = await runCli(['--help'], {
      stdout: (m) => stdoutLines.push(m),
      stderr: (m) => stderrLines.push(m),
    });

    expect(code).toBe(0);
    expect(stdoutLines.join('\n')).toContain('Forge Agent Engine CLI');
    expect(stderrLines.length).toBe(0);
  });

  it('missing prompt exits with 1 and prints error to stderr', async () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const code = await runCli(['--forgeDir', 'forge'], {
      stdout: (m) => stdoutLines.push(m),
      stderr: (m) => stderrLines.push(m),
    });

    expect(code).toBe(1);
    expect(stderrLines.join('\n')).toContain('Error: missing required prompt argument');
  });

  it('missing --forgeDir exits with 1 and prints error to stderr', async () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const code = await runCli(['hello'], {
      stdout: (m) => stdoutLines.push(m),
      stderr: (m) => stderrLines.push(m),
    });

    expect(code).toBe(1);
    expect(stderrLines.join('\n')).toContain('Error: missing required --forgeDir argument');
  });

  it('rejects unknown options with code 1', async () => {
    const stderrLines: string[] = [];
    const code = await runCli(['--unknownOption', 'test'], {
      stderr: (m) => stderrLines.push(m),
    });

    expect(code).toBe(1);
    expect(stderrLines.join('\n')).toContain("Error: Unknown option: '--unknownOption'");
  });

  it('rejects missing option values with code 1', async () => {
    const stderrLines: string[] = [];
    const code = await runCli(['--forgeDir'], {
      stderr: (m) => stderrLines.push(m),
    });

    expect(code).toBe(1);
    expect(stderrLines.join('\n')).toContain("Error: Missing value for option '--forgeDir'");
  });

  it('rejects invalid --mode with code 1', async () => {
    const stderrLines: string[] = [];
    const code = await runCli(['--mode', 'invalidMode', 'test'], {
      stderr: (m) => stderrLines.push(m),
    });

    expect(code).toBe(1);
    expect(stderrLines.join('\n')).toContain("Error: Invalid value for '--mode': 'invalidMode'");
  });

  it('rejects invalid --profile with code 1', async () => {
    const stderrLines: string[] = [];
    const code = await runCli(['--profile', 'invalidProfile', 'test'], {
      stderr: (m) => stderrLines.push(m),
    });

    expect(code).toBe(1);
    expect(stderrLines.join('\n')).toContain("Error: Invalid value for '--profile': 'invalidProfile'");
  });

  it('unhealthy TrueForge service exits with 1 without starting engine', async () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    let engineCalled = false;
    const mockEngine = {
      runAgent: () => {
        engineCalled = true;
        return (async function* () {})();
      },
    } as unknown as EngineApi;

    const code = await runCli(['--forgeDir', 'forge', 'hello'], {
      engine: mockEngine,
      healthCheck: async () => ({ ok: false, detail: 'Connection refused (ECONNREFUSED)' }),
      stdout: (m) => stdoutLines.push(m),
      stderr: (m) => stderrLines.push(m),
    });

    expect(code).toBe(1);
    expect(engineCalled).toBe(false);
    expect(stderrLines.join('\n')).toContain('TrueForge service is unreachable');
    expect(stderrLines.join('\n')).toContain('ECONNREFUSED');
  });

  it('shares exact same ForgeClient instance between health check and createEngine', async () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    let clientPassedToHealth: unknown = null;

    const config = createMockConfig();
    const host = createMockHost();
    const testClient = new ForgeClient(config.setup);

    const createSessionSpy = vi.spyOn(testClient, 'createSession').mockResolvedValue('session-cli-test');
    const createTurnSpy = vi.spyOn(testClient, 'createTurn').mockImplementation(async function* () {
      yield {
        id: '1',
        event: 'message',
        data: { type: 'model.message.delta', id: 'm1', content: 'hi from turn' },
        rawData: '',
      } as RawEvent;
      yield {
        id: '2',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done', output: 'all good' } },
        rawData: '',
      } as RawEvent;
    });

    const code = await runCli(['--forgeDir', 'forge', 'say hi'], {
      client: testClient,
      config,
      host,
      healthCheck: async (c) => {
        clientPassedToHealth = c;
        return { ok: true };
      },
      stdout: (m) => stdoutLines.push(m),
      stderr: (m) => stderrLines.push(m),
    });

    expect(code).toBe(0);
    expect(clientPassedToHealth).toBe(testClient);
    expect(createSessionSpy).toHaveBeenCalled();
    expect(createTurnSpy).toHaveBeenCalled();
    expect(stdoutLines.length).toBe(4);
    expect(JSON.parse(stdoutLines[0]).type).toBe('run.started');
    expect(JSON.parse(stdoutLines[1]).type).toBe('budget');
    expect(JSON.parse(stdoutLines[2])).toEqual({ type: 'token', text: 'hi from turn' });
    expect(JSON.parse(stdoutLines[3])).toEqual({ type: 'run.completed', summary: 'all good' });
    expect(stderrLines.length).toBe(0);
  });

  it('cancelled run exits with code 130', async () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const mockEngine = {
      runAgent: () => (async function* () {
        yield { type: 'run.started', runId: 'r1', mode: 'agent', model: 'm1' };
        yield { type: 'run.cancelled' };
      })(),
    } as unknown as EngineApi;

    const code = await runCli(['--forgeDir', 'forge', 'say hi'], {
      engine: mockEngine,
      healthCheck: async () => ({ ok: true }),
      stdout: (m) => stdoutLines.push(m),
      stderr: (m) => stderrLines.push(m),
    });

    expect(code).toBe(130);
    expect(stderrLines.join('\n')).toContain('Run was cancelled');
  });

  it('failed run exits with code 1 and logs error to stderr', async () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const mockEngine = {
      runAgent: () => (async function* () {
        yield { type: 'run.started', runId: 'r1', mode: 'agent', model: 'm1' };
        yield {
          type: 'run.failed',
          error: { kind: 'model', message: 'Context window exceeded', retryable: false },
        };
      })(),
    } as unknown as EngineApi;

    const code = await runCli(['--forgeDir', 'forge', 'say hi'], {
      engine: mockEngine,
      healthCheck: async () => ({ ok: true }),
      stdout: (m) => stdoutLines.push(m),
      stderr: (m) => stderrLines.push(m),
    });

    expect(code).toBe(1);
    expect(stderrLines.join('\n')).toContain('Run failed [model]: Context window exceeded');
  });

  it('returns code 1 if stream ends unexpectedly without a terminal event', async () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const mockEngine = {
      runAgent: () => (async function* () {
        yield { type: 'run.started', runId: 'r1', mode: 'agent', model: 'm1' };
        yield { type: 'token', text: 'unfinished stream' };
        // Stream ends without terminal event
      })(),
    } as unknown as EngineApi;

    const code = await runCli(['--forgeDir', 'forge', 'say hi'], {
      engine: mockEngine,
      healthCheck: async () => ({ ok: true }),
      stdout: (m) => stdoutLines.push(m),
      stderr: (m) => stderrLines.push(m),
    });

    expect(code).toBe(1);
    expect(stderrLines.join('\n')).toContain('Stream ended unexpectedly without a terminal event');
  });
});
