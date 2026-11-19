/**
 * Unit tests for createRuntime single-call bootstrapper (Milestone I-0).
 *
 * Tests are hermetic:
 * - Temporary directories with fake config files (cleaned up after each test).
 * - Fake / spied ForgeClient with mocked healthCheck (no live TrueForge).
 * - No dependence on gitignored files.
 * - No key-like literals (tokens built by string concatenation).
 * - Every started runtime is guaranteed stopped in finally / afterEach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import { createRuntime, type ForgeRuntime } from '../../src/engine/runtime.ts';
import { ForgeClient } from '../../src/engine/ForgeClient.ts';
import type { EngineConfig } from '../../src/engine/config.ts';
import type { UiHost } from '../../src/types/contract.ts';

function createMockHost(workspaceRoot: string): UiHost {
  const store = new Map<string, string>();
  return {
    workspaceRoot,
    isWorkspaceTrusted: () => true,
    context: {
      resolveMention: async () => null,
      seed: async () => [],
      search: async () => ({ hits: [], omitted: 0 }),
      findSymbol: async () => ({ symbols: [] }),
      repoMap: async () => ({ tree: '', truncated: false }),
    },
    snapshot: async (relPath: string) => {
      const content = store.get(relPath) ?? '';
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

function buildFakeToken(): string {
  // Constructed via concatenation to prevent false-positive secret scanner matches
  const part1 = 'fake';
  const part2 = 'runtime';
  const part3 = 'token';
  const part4 = '12345';
  return [part1, part2, part3, part4].join('-');
}

function createMockConfig(token?: string, port = 8881): EngineConfig {
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
        name: 'test-runtime-mcp',
        port,
        path: '/mcp',
        perWorkspace: false,
        token: token ?? buildFakeToken(),
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

describe('createRuntime helper', () => {
  const activeRuntimes: ForgeRuntime[] = [];
  const tempDirs: string[] = [];
  let originalEnvToken: string | undefined;

  beforeEach(() => {
    originalEnvToken = process.env.FORGE_MCP_TOKEN;
    delete process.env.FORGE_MCP_TOKEN;
  });

  afterEach(async () => {
    // 1. Ensure all started runtimes are cleanly stopped
    while (activeRuntimes.length > 0) {
      const rt = activeRuntimes.pop();
      if (rt) {
        try {
          await rt.stop();
        } catch {
          // Ignore teardown errors in cleanup
        }
      }
    }

    // 2. Clean up temporary test directories
    for (const d of tempDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // Ignore directory cleanup errors
      }
    }
    tempDirs.length = 0;

    // 3. Restore environment
    if (originalEnvToken !== undefined) {
      process.env.FORGE_MCP_TOKEN = originalEnvToken;
    } else {
      delete process.env.FORGE_MCP_TOKEN;
    }

    vi.restoreAllMocks();
  });

  function createTempForgeDir(): { forgeDir: string; workspaceRoot: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runtime-test-'));
    tempDirs.push(root);
    const forgeDir = path.join(root, 'forge');
    fs.mkdirSync(forgeDir, { recursive: true });

    // Write minimal valid setup.example.json and models.example.json
    const setupExample = {
      baseUrl: 'http://127.0.0.1:8790',
      agents: { primary: 'agent-1', fallback: 'agent-2' },
      mcp: { name: 'forge-editor', perWorkspace: false, port: 8882, path: '/mcp' },
      budgets: {
        seedTokens: 1000,
        mentionsTokens: 500,
        runToolBudgetTokens: 5000,
        maxToolCalls: 10,
        maxRunSeconds: 60,
      },
      retry: { max: 2, baseDelayMs: 100 },
    };
    const modelsExample = {
      profiles: {
        primary: {
          agent: 'agent-1',
          provider: 'prov-1',
          modelId: 'mod-1',
          kind: 'primary',
          modelContextTokens: 16000,
        },
        fallback: {
          agent: 'agent-2',
          provider: 'prov-2',
          modelId: 'mod-2',
          kind: 'fallback',
          modelContextTokens: 16000,
        },
      },
    };

    fs.writeFileSync(path.join(forgeDir, 'setup.example.json'), JSON.stringify(setupExample, null, 2));
    fs.writeFileSync(path.join(forgeDir, 'models.example.json'), JSON.stringify(modelsExample, null, 2));

    return { forgeDir, workspaceRoot: root };
  }

  it('successfully initializes runtime with valid config and mock client (happy path)', async () => {
    const { forgeDir, workspaceRoot } = createTempForgeDir();
    const host = createMockHost(workspaceRoot);
    const config = createMockConfig(undefined, 8881);
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'health').mockResolvedValue({ ok: true, detail: 'Healthy test probe' });
    vi.spyOn(client, 'registerMcp').mockResolvedValue({ ok: true, reused: false });

    const result = await createRuntime({
      host,
      forgeDir,
      config,
      client,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    activeRuntimes.push(result.runtime);
    expect(result.runtime.engine).toBeDefined();
    expect(typeof result.runtime.engine.runAgent).toBe('function');
    expect(typeof result.runtime.engine.runInline).toBe('function');
    expect(typeof result.runtime.engine.switchModel).toBe('function');
    expect(result.runtime.engine.activeModel()).toBe('primary-model-id');

    expect(result.runtime.info.baseUrl).toBe('http://127.0.0.1:8790');
    expect(result.runtime.info.connectorName).toBe('test-runtime-mcp');
    expect(result.runtime.info.mcpUrl).toContain('/mcp');

    // Idempotent stop check
    await result.runtime.stop();
    await expect(result.runtime.stop()).resolves.toBeUndefined();
  });

  it('loads configuration from disk including setup.local.json token', async () => {
    const { forgeDir, workspaceRoot } = createTempForgeDir();
    const token = buildFakeToken();
    fs.writeFileSync(
      path.join(forgeDir, 'setup.local.json'),
      JSON.stringify({ mcp: { token, port: 8883 } }, null, 2),
    );

    const host = createMockHost(workspaceRoot);
    const dummyClient = new ForgeClient(createMockConfig().setup);
    vi.spyOn(dummyClient, 'health').mockResolvedValue({ ok: true });
    vi.spyOn(dummyClient, 'registerMcp').mockResolvedValue({ ok: true, reused: false });

    const result = await createRuntime({
      host,
      forgeDir,
      client: dummyClient,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    activeRuntimes.push(result.runtime);
    expect(result.runtime.info.port).toBe(8883);
    await result.runtime.stop();
  });

  it('returns config_missing when forgeDir does not exist', async () => {
    const host = createMockHost(os.tmpdir());
    const nonExistentDir = path.join(os.tmpdir(), 'non-existent-forge-dir-' + Date.now());

    const result = await createRuntime({
      host,
      forgeDir: nonExistentDir,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('config_missing');
    expect(result.error.message).toContain('not found');
  });

  it('returns config_missing when base example files are missing', async () => {
    const emptyForgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-forge-'));
    tempDirs.push(emptyForgeDir);
    const host = createMockHost(emptyForgeDir);

    const result = await createRuntime({
      host,
      forgeDir: emptyForgeDir,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('config_missing');
    expect(result.error.message).toContain('(*.example.json) are missing');
  });

  it('returns config_invalid when setup.example.json has bad JSON syntax', async () => {
    const { forgeDir, workspaceRoot } = createTempForgeDir();
    fs.writeFileSync(path.join(forgeDir, 'setup.example.json'), '{ broken json ');

    const host = createMockHost(workspaceRoot);
    const result = await createRuntime({
      host,
      forgeDir,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('config_invalid');
    expect(result.error.message).toContain('Invalid configuration');
  });

  it('returns token_missing when no token is configured and FORGE_MCP_TOKEN is unset', async () => {
    const { forgeDir, workspaceRoot } = createTempForgeDir();
    const host = createMockHost(workspaceRoot);
    const config = createMockConfig();
    delete (config.setup.mcp as Record<string, unknown>).token;

    const result = await createRuntime({
      host,
      forgeDir,
      config,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('token_missing');
    expect(result.error.actionHint).toBe('Run npm run forge:setup in the forge-agent repository.');
  });

  it('falls back to FORGE_MCP_TOKEN environment variable when config token is omitted', async () => {
    const { forgeDir, workspaceRoot } = createTempForgeDir();
    const envToken = buildFakeToken();
    process.env.FORGE_MCP_TOKEN = envToken;

    const host = createMockHost(workspaceRoot);
    const config = createMockConfig();
    delete (config.setup.mcp as Record<string, unknown>).token;

    const client = new ForgeClient(config.setup);
    vi.spyOn(client, 'health').mockResolvedValue({ ok: true });
    vi.spyOn(client, 'registerMcp').mockResolvedValue({ ok: true, reused: false });

    const result = await createRuntime({
      host,
      forgeDir,
      config,
      client,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    activeRuntimes.push(result.runtime);
    await result.runtime.stop();
  });

  it('returns service_unreachable when client.health() returns ok: false', async () => {
    const { forgeDir, workspaceRoot } = createTempForgeDir();
    const host = createMockHost(workspaceRoot);
    const config = createMockConfig();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'health').mockResolvedValue({
      ok: false,
      detail: 'Connection refused at 127.0.0.1:8790',
    });

    const result = await createRuntime({
      host,
      forgeDir,
      config,
      client,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('service_unreachable');
    expect(result.error.message).toContain('TrueForge service is unreachable');
    expect(result.error.actionHint).toBe(
      'Start TrueForge: npx @truefoundry/trueforge@latest (default http://localhost:8790)',
    );
  });

  it('returns service_unreachable when client.health() throws an error', async () => {
    const { forgeDir, workspaceRoot } = createTempForgeDir();
    const host = createMockHost(workspaceRoot);
    const config = createMockConfig();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'health').mockRejectedValue(new Error('Network offline'));

    const result = await createRuntime({
      host,
      forgeDir,
      config,
      client,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('service_unreachable');
    expect(result.error.message).toContain('TrueForge health check failed');
  });

  it('returns mcp_registration_failed when client.registerMcp rejects', async () => {
    const { forgeDir, workspaceRoot } = createTempForgeDir();
    const host = createMockHost(workspaceRoot);
    const config = createMockConfig(undefined, 8885);
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'health').mockResolvedValue({ ok: true });
    vi.spyOn(client, 'registerMcp').mockRejectedValue(new Error('Unauthorized connector update'));

    const result = await createRuntime({
      host,
      forgeDir,
      config,
      client,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('mcp_registration_failed');
    expect(result.error.message).toContain('register MCP server with TrueForge');
  });

  it('strictly redacts token if it appears in error messages', async () => {
    const { forgeDir, workspaceRoot } = createTempForgeDir();
    const secretToken = buildFakeToken();
    const host = createMockHost(workspaceRoot);
    const config = createMockConfig(secretToken, 8886);
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'health').mockResolvedValue({ ok: true });
    // Intentionally throw an error that includes the secret token in its message
    vi.spyOn(client, 'registerMcp').mockRejectedValue(
      new Error(`Registration failed for token ${secretToken}`),
    );

    const result = await createRuntime({
      host,
      forgeDir,
      config,
      client,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.message).not.toContain(secretToken);
    expect(result.error.message).toContain('[REDACTED]');
    if (result.error.detail) {
      expect(result.error.detail).not.toContain(secretToken);
      expect(result.error.detail).toContain('[REDACTED]');
    }
  });

  it('returns port_collision when loopback ports cannot be bound', async () => {
    const { forgeDir, workspaceRoot } = createTempForgeDir();
    const host = createMockHost(workspaceRoot);
    const config = createMockConfig(undefined, 8887);
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'health').mockResolvedValue({ ok: true });
    vi.spyOn(client, 'registerMcp').mockResolvedValue({ ok: true, reused: false });

    // Block ports 8887 through 8937 (all 51 scan attempts: configuredPort + MAX_PORT_SCAN_ATTEMPTS)
    const blockers: net.Server[] = [];
    try {
      for (let p = 8887; p <= 8937; p++) {
        const s = net.createServer();
        await new Promise<void>((resolve, reject) => {
          s.once('error', reject);
          s.listen(p, '127.0.0.1', () => resolve());
        });
        blockers.push(s);
      }

      const result = await createRuntime({
        host,
        forgeDir,
        config,
        client,
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        activeRuntimes.push(result.runtime);
        return;
      }

      expect(result.error.kind).toBe('port_collision');
      expect(result.error.actionHint).toContain('Free up loopback ports');
    } finally {
      for (const s of blockers) {
        try {
          s.close();
        } catch {
          // Ignore close errors
        }
      }
    }
  });
});
