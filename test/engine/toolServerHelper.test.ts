/**
 * Unit tests for startToolServer helper and engine-cli lifecycle integration (Milestone E-06b).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as net from 'node:net';
import * as path from 'node:path';
import type { UiHost, EngineApi, EngineEvent } from '../../src/types/contract.ts';
import {
  startToolServer,
  type ToolServerHandle,
} from '../../src/mcp/startToolServer.ts';
import type { McpToolServer } from '../../src/mcp/McpToolServer.ts';
import { ForgeClient, type RawEvent } from '../../src/engine/ForgeClient.ts';
import { SessionOrchestrator } from '../../src/engine/SessionOrchestrator.ts';
import type { EngineConfig } from '../../src/engine/config.ts';
import { runCli } from '../../scripts/engine-cli.ts';

function createMockHost(files: Record<string, string> = {}): UiHost {
  const store = new Map<string, string>(Object.entries(files));
  return {
    workspaceRoot: path.resolve(process.cwd()),
    isWorkspaceTrusted: () => true,
    context: {
      resolveMention: async () => null,
      seed: async () => [],
      search: async () => ({ hits: [], omitted: 0 }),
      findSymbol: async () => ({ symbols: [] }),
      repoMap: async () => ({ tree: '', truncated: false }),
    },
    snapshot: async (relPath: string) => {
      const content = store.get(relPath);
      if (content === undefined) {
        throw new Error(`File not found: ${relPath}`);
      }
      return {
        path: relPath,
        text: content,
        version: 1,
        exists: true,
        isDirty: false,
        contentHash: 'hash-' + relPath,
      };
    },
    readFile: async (p: string) => store.get(p) ?? '',
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
        port: 8880,
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

describe('startToolServer helper', () => {
  const runningHandles: ToolServerHandle[] = [];

  afterEach(async () => {
    while (runningHandles.length > 0) {
      const handle = runningHandles.pop();
      if (handle) {
        try {
          await handle.stop();
        } catch {
          // Ignore teardown errors
        }
      }
    }
  });

  it('starts on 127.0.0.1, generates 64-char hex token, and returns valid handle', async () => {
    const host = createMockHost();
    const handle = await startToolServer({ host, port: 8881 });
    runningHandles.push(handle);

    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(handle.token).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(handle.token)).toBe(true);
    expect(handle.server.isRunning).toBe(true);
  });

  it('falls back to next port upon port collision', async () => {
    const host = createMockHost();
    const handle1 = await startToolServer({ host, port: 8882 });
    runningHandles.push(handle1);

    const handle2 = await startToolServer({ host, port: 8882 });
    runningHandles.push(handle2);

    expect(handle1.server.port).toBe(8882);
    expect(handle2.server.port).toBe(8883);
    expect(handle2.url).toBe('http://127.0.0.1:8883/mcp');
  });

  it('stop() is idempotent and releases bound socket', async () => {
    const host = createMockHost();
    const handle = await startToolServer({ host, port: 8884 });

    expect(handle.server.isRunning).toBe(true);
    const boundPort = handle.server.port!;

    await handle.stop();
    expect(handle.server.isRunning).toBe(false);

    // Multiple calls to stop() must be safe and idempotent
    await expect(handle.stop()).resolves.toBeUndefined();
    await expect(handle.stop()).resolves.toBeUndefined();

    // Verify port is freed
    const canBind = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(boundPort, '127.0.0.1', () => {
        probe.close(() => resolve(true));
      });
    });
    expect(canBind).toBe(true);
  });

  it('registers bound URL + token with TrueForge when client is provided', async () => {
    const host = createMockHost();
    const config = createMockConfig();
    const client = new ForgeClient(config.setup);

    const registerSpy = vi.spyOn(client, 'registerMcp').mockResolvedValue({ ok: true, reused: false });

    const handle = await startToolServer({
      host,
      client,
      port: 8885,
      name: 'custom-mcp',
      token: 'test-token-123',
    });
    runningHandles.push(handle);

    expect(registerSpy).toHaveBeenCalledWith({
      name: 'custom-mcp',
      url: 'http://127.0.0.1:8885/mcp',
      token: 'test-token-123',
    });
  });

  it('redacts secret token from error message if registerMcp fails and stops server', async () => {
    const host = createMockHost();
    const config = createMockConfig();
    const client = new ForgeClient(config.setup);

    const secretToken = 'super-secret-hex-token-9999999999';
    vi.spyOn(client, 'registerMcp').mockRejectedValue(
      new Error(`HTTP 409 conflict for token ${secretToken} at url`)
    );

    let thrownError: Error | null = null;
    try {
      await startToolServer({
        host,
        client,
        port: 8886,
        token: secretToken,
      });
    } catch (err: unknown) {
      thrownError = err as Error;
    }

    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toContain('Failed to register MCP server with TrueForge:');
    expect(thrownError!.message).toContain('[REDACTED]');
    expect(thrownError!.message).not.toContain(secretToken);
  });

  it('never leaks secret token to logger during startup or shutdown', async () => {
    const host = createMockHost();
    const loggedMessages: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const logger = {
      info: (message: string, meta?: Record<string, unknown>) => loggedMessages.push({ message, meta }),
      warn: (message: string, meta?: Record<string, unknown>) => loggedMessages.push({ message, meta }),
      error: (message: string, meta?: Record<string, unknown>) => loggedMessages.push({ message, meta }),
    };

    const secretToken = 'unique-unlogged-token-7777777777';
    const handle = await startToolServer({
      host,
      port: 8887,
      token: secretToken,
      logger,
    });
    runningHandles.push(handle);

    await handle.stop();

    expect(loggedMessages.length).toBeGreaterThan(0);
    const serializedLogs = JSON.stringify(loggedMessages);
    expect(serializedLogs).not.toContain(secretToken);
    expect(serializedLogs).toContain('tool_server:started');
    expect(serializedLogs).toContain('tool_server:stopping');
  });

  it('call with no proposalProvider configured returns no active run', async () => {
    const host = createMockHost();
    const handle = await startToolServer({ host, port: 8888 });
    runningHandles.push(handle);

    // Test the internal proposal handlers attached to server
    const serverAny = handle.server as unknown as {
      customProposeEditHandler: (args: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
      customCreateFileHandler: (args: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    };

    const editRes = await serverAny.customProposeEditHandler(
      { path: 'src/test.ts', edits: [], rationale: 'test' },
      { host }
    );
    expect(editRes.isError).toBe(true);
    expect(editRes.content[0].text).toBe('no active run');

    const createRes = await serverAny.customCreateFileHandler(
      { path: 'src/new.ts', content: 'test', rationale: 'test' },
      { host }
    );
    expect(createRes.isError).toBe(true);
    expect(createRes.content[0].text).toBe('no active run');
  });

  it('call before any run has ever started returns no active run', async () => {
    const host = createMockHost();
    const config = createMockConfig();
    const client = new ForgeClient(config.setup);
    const orchestrator = new SessionOrchestrator(host, client, config);

    const handle = await startToolServer({
      host,
      proposalProvider: orchestrator,
      port: 8889,
    });
    runningHandles.push(handle);

    const serverAny = handle.server as unknown as {
      customProposeEditHandler: (args: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
      customCreateFileHandler: (args: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    };

    const editRes = await serverAny.customProposeEditHandler(
      { path: 'src/test.ts', edits: [], rationale: 'test' },
      { host }
    );
    expect(editRes.isError).toBe(true);
    expect(editRes.content[0].text).toBe('no active run');

    const createRes = await serverAny.customCreateFileHandler(
      { path: 'src/new.ts', content: 'test', rationale: 'test' },
      { host }
    );
    expect(createRes.isError).toBe(true);
    expect(createRes.content[0].text).toBe('no active run');
  });

  it('call after a run completes returns no active run (no stale lastDecisionStore)', async () => {
    const host = createMockHost({ 'src/sample.ts': 'alpha\n' });
    const config = createMockConfig();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('session-helper-completed');
    vi.spyOn(client, 'submitApprovals').mockResolvedValue({ eventIds: ['ev_ok'] });

    async function* turnEvents() {
      yield {
        id: '1',
        event: 'message',
        data: {
          type: 'model.message.delta',
          id: 'msg_1',
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              index: 0,
              id: 'call_helper_1',
              type: 'function',
              function: {
                name: 'proposeEdit',
                arguments: JSON.stringify({
                  path: 'src/sample.ts',
                  edits: [{ oldText: 'alpha', newText: 'beta' }],
                  rationale: 'update alpha',
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
          type: 'tool.approval_required',
          id: 'appr_helper',
          thread_id: 'main',
          tool_calls: [{ id: 'call_helper_1', source_event_id: 'msg_1' }],
        },
        rawData: '',
      } as RawEvent;
      yield {
        id: '3',
        event: 'message',
        data: {
          type: 'turn.update',
          state: { status: 'paused', required_actions: [{ type: 'approval' }] },
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
    const handle = await startToolServer({
      host,
      proposalProvider: orchestrator,
      port: 8890,
    });
    runningHandles.push(handle);

    const serverAny = handle.server as unknown as {
      customProposeEditHandler: (args: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    };

    let activeResultText = '';
    const runPromise = (async () => {
      for await (const ev of orchestrator.runAgent({ prompt: 'test run', mentions: [] })) {
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
          // During active pause, verify handler resolves the decision
          const activeRes = await serverAny.customProposeEditHandler(
            {
              path: 'src/sample.ts',
              edits: [{ oldText: 'alpha', newText: 'beta' }],
              rationale: 'update alpha',
            },
            { host, callOptions: { toolCallId: 'call_helper_1' } }
          );
          activeResultText = activeRes.content[0].text;
        }
      }
    })();

    await runPromise;

    // Verify active pause returned truthful accepted message
    expect(activeResultText).toContain('Applied 1 of 1 hunks to src/sample.ts.');

    // Now after run completes, calling proposeEdit must return 'no active run'
    const postRunRes = await serverAny.customProposeEditHandler(
      {
        path: 'src/sample.ts',
        edits: [{ oldText: 'alpha', newText: 'beta' }],
        rationale: 'update alpha',
      },
      { host, callOptions: { toolCallId: 'call_helper_1' } }
    );
    expect(postRunRes.content[0].text).toBe('no active run');
    expect(postRunRes.isError).toBe(true);
  });
});

/** Minimal fully typed EngineApi stub for CLI lifecycle tests without any. */
function createStubEngine(runAgentFn: () => AsyncGenerator<EngineEvent, void, undefined>): EngineApi {
  return {
    runInline: () => (async function* () {})(),
    runAgent: runAgentFn,
    cancel: async () => {},
    reviewDone: async () => {},
    switchModel: async () => {},
    activeModel: () => 'primary-model-id',
  };
}

describe('scripts/engine-cli with tool server lifecycle', () => {
  it('starts tool server before run and stops it cleanly in finally on completion', async () => {
    let serverStarted = false;
    let serverStopped = false;

    const mockStartToolServer = async (_opts: unknown): Promise<ToolServerHandle> => {
      serverStarted = true;
      return {
        url: 'http://127.0.0.1:8792/mcp',
        token: 'test-cli-token',
        // Mock McpToolServer instance stub for CLI lifecycle testing
        server: { isRunning: true, port: 8792 } as unknown as McpToolServer,
        stop: async () => {
          serverStopped = true;
        },
      };
    };

    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);
    const stdoutLines: string[] = [];

    const mockEngine = createStubEngine(async function* () {
      expect(serverStarted).toBe(true);
      expect(serverStopped).toBe(false);
      yield { type: 'run.completed' } satisfies EngineEvent;
    });

    const code = await runCli(['--forgeDir', 'forge', 'test cli run'], {
      config,
      host,
      client,
      healthCheck: async () => ({ ok: true }),
      startToolServer: mockStartToolServer,
      engine: mockEngine,
      stdout: (m) => stdoutLines.push(m),
    });

    expect(code).toBe(0);
    expect(serverStarted).toBe(true);
    expect(serverStopped).toBe(true);
  });

  it('stops tool server in finally even when stream execution fails', async () => {
    let serverStarted = false;
    let serverStopped = false;

    const mockStartToolServer = async (): Promise<ToolServerHandle> => {
      serverStarted = true;
      return {
        url: 'http://127.0.0.1:8792/mcp',
        token: 'test-cli-token',
        // Mock McpToolServer instance stub for CLI lifecycle testing
        server: { isRunning: true, port: 8792 } as unknown as McpToolServer,
        stop: async () => {
          serverStopped = true;
        },
      };
    };

    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);
    const stderrLines: string[] = [];

    const mockEngine = createStubEngine(async function* () {
      throw new Error('Fatal stream explosion');
    });

    const code = await runCli(['--forgeDir', 'forge', 'failing run'], {
      config,
      host,
      client,
      healthCheck: async () => ({ ok: true }),
      startToolServer: mockStartToolServer,
      engine: mockEngine,
      stderr: (m) => stderrLines.push(m),
    });

    expect(code).toBe(1);
    expect(serverStarted).toBe(true);
    expect(serverStopped).toBe(true);
    expect(stderrLines.join('\n')).toContain('CLI execution error: Fatal stream explosion');
  });

  it('skips tool server startup when skipToolServer is true', async () => {
    let serverStarted = false;

    const mockStartToolServer = async (): Promise<ToolServerHandle> => {
      serverStarted = true;
      return {
        url: 'http://127.0.0.1:8792/mcp',
        token: 'test-cli-token',
        // Mock McpToolServer instance stub for CLI lifecycle testing
        server: { isRunning: true, port: 8792 } as unknown as McpToolServer,
        stop: async () => {},
      };
    };

    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);
    const stdoutLines: string[] = [];

    const mockEngine = createStubEngine(async function* () {
      yield { type: 'run.completed' } satisfies EngineEvent;
    });

    const code = await runCli(['--forgeDir', 'forge', 'skip test'], {
      config,
      host,
      client,
      healthCheck: async () => ({ ok: true }),
      skipToolServer: true,
      startToolServer: mockStartToolServer,
      engine: mockEngine,
      stdout: (m) => stdoutLines.push(m),
    });

    expect(code).toBe(0);
    expect(serverStarted).toBe(false);
  });
});
