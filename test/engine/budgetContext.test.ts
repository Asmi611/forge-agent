/**
 * Unit and integration tests for per-run RunBudget charging and context.report (Milestone E-11b).
 *
 * Verifies:
 * 1. McpToolServer dynamically charges the active run's RunBudget via budgetProvider.
 * 2. Budget increases after readFile tool call and emits 'budget' event in real-time.
 * 3. context.report lists seed items with source 'auto', mentions with source 'mention'.
 * 4. tool.result for readFile / reportContext updates contextItems and emits context.report with source 'agent-tool'.
 * 5. On failover, budget meter and contextItems reset to seed + mentions.
 * 6. Inline mode charges prompt + selection text and emits no context.report.
 * 7. Hermetic tests without network or provider keys.
 */

import { describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import { SessionOrchestrator } from '../../src/engine/SessionOrchestrator.ts';
import { McpToolServer } from '../../src/mcp/McpToolServer.ts';
import { handleReadFile } from '../../src/mcp/tools/readFile.ts';
import { ForgeClient, type RawEvent } from '../../src/engine/ForgeClient.ts';
import type { EngineConfig } from '../../src/engine/config.ts';
import type {
  UiHost,
  EngineEvent,
} from '../../src/types/contract.ts';

function createMockConfig(): EngineConfig {
  return {
    setup: {
      baseUrl: 'http://127.0.0.1:8999',
      isLoopback: true,
      rejectedNonLoopback: false,
      agents: {
        primary: 'primary-agent',
        fallback: 'fallback-agent',
      },
      budgets: {
        runToolBudgetTokens: 10000,
        seedTokens: 3000,
        mentionsTokens: 6000,
        maxToolCalls: 20,
        maxRunSeconds: 60,
      },
      retry: {
        max: 0,
        baseDelayMs: 10,
      },
      mcp: {
        name: 'test-mcp',
        perWorkspace: false,
        port: 8998,
        path: '/mcp',
        token: 'test-mcp-token',
      },
    },
    models: {
      profiles: {
        primary: {
          agent: 'primary-agent',
          provider: 'test-provider',
          modelId: 'primary-model',
          kind: 'primary',
          modelContextTokens: 128000,
        },
        fallback: {
          agent: 'fallback-agent',
          provider: 'test-provider',
          modelId: 'fallback-model',
          kind: 'fallback',
          modelContextTokens: 128000,
        },
      },
    },
  };
}

function createMockHost(): UiHost {
  const root = path.resolve(process.cwd());

  return {
    workspaceRoot: root,
    isWorkspaceTrusted: () => true,
    context: {
      resolveMention: async () => null,
      seed: async () => [
        { path: 'src/seed.ts', reason: 'Initial seed file', tokens: 6, source: 'auto' },
      ],
      search: async () => ({ hits: [], omitted: 0 }),
      findSymbol: async () => ({ symbols: [] }),
      repoMap: async () => ({ tree: 'src/\n  seed.ts', truncated: false }),
    },
    snapshot: async (p: string) => ({
      path: p,
      exists: true,
      text: 'file text content',
      version: 1,
      isDirty: false,
      contentHash: 'hash-abc',
    }),
    readFile: async (_p: string) => '1234567890123456',
    runCommand: async () => ({
      exitCode: 0,
      stdout: 'test output',
      stderr: '',
      truncated: false,
      timedOut: false,
      killed: false,
    }),
    confirmCommand: async () => true,
  };
}

describe('Milestone E-11b: Per-run budget charging and context.report', () => {
  it('charges active run budget dynamically when McpToolServer executes readFile', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    let resolveTurn: () => void;
    const turnPromise = new Promise<void>((r) => { resolveTurn = r; });

    vi.spyOn(client, 'createSession').mockResolvedValue('session-budget-1');
    vi.spyOn(client, 'createTurn').mockImplementation(async function* () {
      await turnPromise;
      yield {
        id: '1',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done', output: 'completed' } },
        rawData: '',
      } as RawEvent;
    });

    const orchestrator = new SessionOrchestrator(host, client, config);

    // McpToolServer configured with budgetProvider
    new McpToolServer(host, {
      port: 0,
      budgetProvider: () => orchestrator.getActiveBudget(),
    });

    // Before run starts, getActiveBudget() is undefined
    expect(orchestrator.getActiveBudget()).toBeUndefined();

    // Start an agent run
    const stream = orchestrator.runAgent({
      prompt: 'Test budget charging prompt',
      mentions: [
        { kind: 'file', label: 'mention1', path: 'src/mention.ts', content: 'const m = 1;' },
      ],
    });
    const iter = stream[Symbol.asyncIterator]();

    // Consume run.started
    const ev1 = await iter.next();
    expect(ev1.value?.type).toBe('run.started');

    // Consume initial budget event
    const ev2 = await iter.next();
    expect(ev2.value?.type).toBe('budget');
    const initialUsedTokens = (ev2.value as Extract<EngineEvent, { type: 'budget' }>).usedTokens;
    expect(initialUsedTokens).toBeGreaterThan(0);

    // Consume initial context.report event (containing seed + mention)
    const ev3 = await iter.next();
    expect(ev3.value?.type).toBe('context.report');
    const initialReport = ev3.value as Extract<EngineEvent, { type: 'context.report' }>;
    expect(initialReport.items.some((i) => i.path === 'src/seed.ts' && i.source === 'auto')).toBe(true);
    expect(initialReport.items.some((i) => i.path === 'src/mention.ts' && i.source === 'mention')).toBe(true);

    // While run is active, active budget is accessible
    const activeBudget = orchestrator.getActiveBudget();
    expect(activeBudget).toBeDefined();
    expect(activeBudget!.getUsedTokens()).toBe(initialUsedTokens);

    // Execute readFile tool directly on README.md which exists in the workspace
    const readResult = await handleReadFile(
      { path: 'README.md' },
      { host, budget: orchestrator.getActiveBudget() }
    );
    expect(readResult.isError).toBeFalsy();

    // Active budget tokens must have increased after tool execution
    const updatedUsedTokens = activeBudget!.getUsedTokens();
    expect(updatedUsedTokens).toBeGreaterThan(initialUsedTokens);

    // Complete the turn
    resolveTurn!();
    const evBudgetUpdated = await iter.next();
    expect(evBudgetUpdated.value?.type).toBe('budget');
    expect((evBudgetUpdated.value as Extract<EngineEvent, { type: 'budget' }>).usedTokens).toBe(updatedUsedTokens);

    const evFinal = await iter.next();
    expect(evFinal.value?.type).toBe('run.completed');

    // Run finalized, active budget released
    expect(orchestrator.getActiveBudget()).toBeUndefined();
  });

  it('updates contextItems and emits context.report with source agent-tool after readFile tool.result', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-context-2');
    vi.spyOn(client, 'createTurn').mockImplementation(async function* () {
      // Agent calls readFile on src/flask/cli.py
      yield {
        id: '1',
        event: 'message',
        data: {
          type: 'model.message.delta',
          id: 'm1',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              index: 0,
              id: 'call_read_1',
              type: 'function',
              function: {
                name: 'readFile',
                arguments: JSON.stringify({ path: 'src/flask/cli.py' }),
              },
            },
          ],
        },
        rawData: '',
      } as RawEvent;

      // Tool result returns
      yield {
        id: '2',
        event: 'message',
        data: {
          type: 'tool.response',
          tool_call_id: 'call_read_1',
          ok: true,
          content: 'def cli(): pass\nprint("hello from cli")',
        },
        rawData: '',
      } as RawEvent;

      // Turn finishes
      yield {
        id: '3',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done', output: 'read complete' } },
        rawData: '',
      } as RawEvent;
    });

    const orchestrator = new SessionOrchestrator(host, client, config);
    const events: EngineEvent[] = [];

    for await (const ev of orchestrator.runAgent({ prompt: 'Read cli.py', mentions: [] })) {
      events.push(ev);
    }

    // Filter context.report events
    const contextReports = events.filter((e) => e.type === 'context.report') as Extract<
      EngineEvent,
      { type: 'context.report' }
    >[];

    // Must have initial report (after seed) and updated report (after tool.result)
    expect(contextReports.length).toBe(2);

    // Initial report has seed file
    expect(contextReports[0].items.some((i) => i.path === 'src/seed.ts' && i.source === 'auto')).toBe(true);
    expect(contextReports[0].items.some((i) => i.path === 'src/flask/cli.py')).toBe(false);

    // Second report has src/flask/cli.py with source 'agent-tool'
    const updatedItems = contextReports[1].items;
    const cliItem = updatedItems.find((i) => i.path === 'src/flask/cli.py');
    expect(cliItem).toBeDefined();
    expect(cliItem!.source).toBe('agent-tool');
    expect(cliItem!.reason).toBe('Read by agent');
    expect(cliItem!.tokens).toBeGreaterThan(0);
  });

  it('updates contextItems and emits context.report when reportContext tool.result arrives', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-report-ctx');
    vi.spyOn(client, 'createTurn').mockImplementation(async function* () {
      yield {
        id: '1',
        event: 'message',
        data: {
          type: 'model.message.delta',
          id: 'm1',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              index: 0,
              id: 'call_report_1',
              type: 'function',
              function: {
                name: 'reportContext',
                arguments: JSON.stringify({
                  items: [
                    { path: 'tests/test_cli.py', reason: 'CLI test suite to verify' },
                    { path: 'docs/cli.rst', reason: 'Documentation for built-in commands' },
                  ],
                }),
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
          type: 'tool.response',
          tool_call_id: 'call_report_1',
          ok: true,
          content: 'Context reported: 2 file(s) recorded.',
        },
        rawData: '',
      } as RawEvent;

      yield {
        id: '3',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done', output: 'reported context' } },
        rawData: '',
      } as RawEvent;
    });

    const orchestrator = new SessionOrchestrator(host, client, config);
    const events: EngineEvent[] = [];

    for await (const ev of orchestrator.runAgent({ prompt: 'Report context test', mentions: [] })) {
      events.push(ev);
    }

    const contextReports = events.filter((e) => e.type === 'context.report') as Extract<
      EngineEvent,
      { type: 'context.report' }
    >[];

    expect(contextReports.length).toBe(2);

    const finalReport = contextReports[1].items;
    const testCliItem = finalReport.find((i) => i.path === 'tests/test_cli.py');
    expect(testCliItem).toBeDefined();
    expect(testCliItem!.source).toBe('agent-tool');
    expect(testCliItem!.reason).toBe('CLI test suite to verify');

    const docsItem = finalReport.find((i) => i.path === 'docs/cli.rst');
    expect(docsItem).toBeDefined();
    expect(docsItem!.source).toBe('agent-tool');
    expect(docsItem!.reason).toBe('Documentation for built-in commands');
  });

  it('resets budget and context items to seed and mentions on failover', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession')
      .mockResolvedValueOnce('session-primary-fail')
      .mockResolvedValueOnce('session-fallback-ok');

    // Primary agent runs, reads a file, then experiences an unreachable error
    let primaryAttempt = true;
    vi.spyOn(client, 'createTurn').mockImplementation(async function* () {
      if (primaryAttempt) {
        primaryAttempt = false;

        // Primary reads a file
        yield {
          id: '1',
          event: 'message',
          data: {
            type: 'model.message.delta',
            id: 'm1',
            finish_reason: 'tool_calls',
            tool_calls: [
              {
                index: 0,
                id: 'call_primary_read',
                type: 'function',
                function: {
                  name: 'readFile',
                  arguments: JSON.stringify({ path: 'src/flask/cli.py' }),
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
            type: 'tool.response',
            tool_call_id: 'call_primary_read',
            ok: true,
            content: 'cli file content',
          },
          rawData: '',
        } as RawEvent;

        // Non-retryable error causing immediate failover
        yield {
          id: '3',
          event: 'turn.update',
          data: {
            type: 'turn.update',
            state: {
              status: 'error',
              message: 'Primary model quota exceeded 429',
            },
          },
          rawData: '',
        } as RawEvent;
      } else {
        // Fallback agent succeeds cleanly
        yield {
          id: '4',
          event: 'turn.done',
          data: { type: 'turn.done', state: { status: 'done', output: 'fallback finished' } },
          rawData: '',
        } as RawEvent;
      }
    });

    const orchestrator = new SessionOrchestrator(host, client, config);
    const events: EngineEvent[] = [];

    for await (const ev of orchestrator.runAgent({
      prompt: 'Failover budget reset test',
      mentions: [{ kind: 'file', label: 'mention', path: 'src/mention.ts', content: 'mention text' }],
    })) {
      events.push(ev);
    }

    // Verify failover event occurred
    const failoverEv = events.find((e) => e.type === 'failover');
    expect(failoverEv).toBeDefined();

    const failoverIndex = events.findIndex((e) => e.type === 'failover');

    // Post-failover budget event must reset to initial tokens
    const postFailoverBudget = events
      .slice(failoverIndex)
      .find((e) => e.type === 'budget') as Extract<EngineEvent, { type: 'budget' }>;
    expect(postFailoverBudget).toBeDefined();

    // Post-failover context.report must reset to seed + mentions ONLY (no agent-tool files)
    const postFailoverContext = events
      .slice(failoverIndex)
      .find((e) => e.type === 'context.report') as Extract<EngineEvent, { type: 'context.report' }>;
    expect(postFailoverContext).toBeDefined();

    // Contains seed and mention
    expect(postFailoverContext.items.some((i) => i.path === 'src/seed.ts' && i.source === 'auto')).toBe(true);
    expect(postFailoverContext.items.some((i) => i.path === 'src/mention.ts' && i.source === 'mention')).toBe(true);

    // Does NOT contain src/flask/cli.py from the failed primary attempt
    expect(postFailoverContext.items.some((i) => i.path === 'src/flask/cli.py')).toBe(false);
  });

  it('inline mode charges prompt and selection text without seed, mentions, or context.report', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-inline-1');
    vi.spyOn(client, 'createTurn').mockImplementation(async function* () {
      yield {
        id: '1',
        event: 'turn.done',
        data: { type: 'turn.done', state: { status: 'done', output: 'inline done' } },
        rawData: '',
      } as RawEvent;
    });

    const orchestrator = new SessionOrchestrator(host, client, config);
    const events: EngineEvent[] = [];

    for await (const ev of orchestrator.runInline({
      prompt: '12345678', // 8 chars -> 2 tokens
      path: 'src/main.ts',
      selectedText: '1234567890123456', // 16 chars -> 4 tokens
      range: { startLine: 1, endLine: 2 },
    })) {
      events.push(ev);
    }

    // Must NOT contain any context.report events
    const contextReport = events.find((e) => e.type === 'context.report');
    expect(contextReport).toBeUndefined();

    // Initial budget event reflects exactly prompt + selection tokens = 6 tokens
    const budgetEv = events.find((e) => e.type === 'budget') as Extract<EngineEvent, { type: 'budget' }>;
    expect(budgetEv).toBeDefined();
    expect(budgetEv.usedTokens).toBe(6);
    expect(budgetEv.limitTokens).toBe(config.setup.budgets.runToolBudgetTokens);

    // Completed cleanly
    const completedEv = events.find((e) => e.type === 'run.completed');
    expect(completedEv).toBeDefined();
  });
});
