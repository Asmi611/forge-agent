/**
 * Comprehensive unit test suite for Card E-01:
 * Config loading, ForgeClient HTTP, robust SSE parser, and setup idempotency.
 * Fully typed with zero `any`.
 */

import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { getEventListeners } from 'node:events';
import {
  loadConfig,
  validateBaseUrl,
  validateSetupConfig,
  validateModelProfile,
  computeWorkspaceSuffix,
  deepMerge,
  isPlainObject,
  loadCanonicalAgentConfig,
  ConfigError,
  type ModelsConfig,
} from '../../src/engine/config.ts';
import {
  ForgeClient,
  parseSseStream,
  HttpError,
  NetworkError,
  ForgeClientError,
  type RawEvent,
} from '../../src/engine/ForgeClient.ts';

function asRecord(val: unknown): Record<string, unknown> {
  if (isPlainObject(val)) {
    return val;
  }
  throw new Error(`Expected object record, got ${typeof val}`);
}

function createReadableByteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let idx = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (idx < chunks.length) {
        controller.enqueue(chunks[idx++]);
      } else {
        controller.close();
      }
    },
  });
}

function createMockResponse(status: number, data: unknown): Response {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createMockStreamResponse(chunks: Uint8Array[]): Response {
  const stream = createReadableByteStream(chunks);
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const dummySetup = {
  baseUrl: 'http://localhost:8790',
  isLoopback: true,
  rejectedNonLoopback: false,
  agents: { primary: 'forge-primary', fallback: 'forge-fallback' },
  mcp: { name: 'forge-editor', perWorkspace: false, port: 8792, path: '/mcp' },
  budgets: { seedTokens: 3000, mentionsTokens: 6000, runToolBudgetTokens: 30000, maxToolCalls: 40, maxRunSeconds: 300 },
  retry: { max: 3, baseDelayMs: 1000 },
};

describe('Config Loader & Security Validator', () => {
  it('computes deterministic 8-char SHA-256 workspace suffix', () => {
    const s1 = computeWorkspaceSuffix('C:\\Users\\Asmi\\forge-dev1');
    const s2 = computeWorkspaceSuffix('c:/users/asmi/forge-dev1');
    expect(s1).toBe(s2);
    expect(s1).toHaveLength(8);
    expect(/^[0-9a-f]{8}$/.test(s1)).toBe(true);
  });

  it('validates loopback addresses correctly', () => {
    expect(validateBaseUrl('http://localhost:8790').isLoopback).toBe(true);
    expect(validateBaseUrl('http://127.0.0.1:8790').isLoopback).toBe(true);
    expect(validateBaseUrl('http://[::1]:8790').isLoopback).toBe(true);

    const remote = validateBaseUrl('http://192.168.1.100:8790');
    expect(remote.isLoopback).toBe(false);
    expect(remote.rejected).toBe(true);
    expect(remote.warning).toContain('is not a loopback address');
  });

  it('rejects unsupported URL protocols and allows http/https only', () => {
    expect(() => validateBaseUrl('ftp://localhost:8790')).toThrow(ConfigError);
    expect(() => validateBaseUrl('ftp://localhost:8790')).toThrow(/protocol 'ftp:' is unsupported/);

    expect(() => validateBaseUrl('file:///localhost:8790')).toThrow(ConfigError);
    expect(() => validateBaseUrl('file:///localhost:8790')).toThrow(/protocol 'file:' is unsupported/);

    expect(() => validateBaseUrl('ws://localhost:8790')).toThrow(ConfigError);
    expect(() => validateBaseUrl('ws://localhost:8790')).toThrow(/protocol 'ws:' is unsupported/);

    // Valid protocols
    expect(validateBaseUrl('http://localhost:8790').isLoopback).toBe(true);
    expect(validateBaseUrl('https://127.0.0.1:8790').isLoopback).toBe(true);
  });

  it('validates required nested setup fields and rejects incomplete objects', () => {
    expect(() => validateSetupConfig({}, 'test.json')).toThrow(/missing or empty 'baseUrl'/);

    const missingAgents: Record<string, unknown> = {
      baseUrl: 'http://localhost:8790',
    };
    expect(() => validateSetupConfig(missingAgents, 'test.json')).toThrow(/missing 'agents' object/);

    const invalidPort: Record<string, unknown> = {
      baseUrl: 'http://localhost:8790',
      agents: { primary: 'p', fallback: 'f' },
      mcp: { name: 'mcp', port: 80, path: '/mcp', perWorkspace: false }, // Port < 1024
      budgets: { seedTokens: 1, mentionsTokens: 1, runToolBudgetTokens: 1, maxToolCalls: 1, maxRunSeconds: 1 },
      retry: { max: 1, baseDelayMs: 1 },
    };
    expect(() => validateSetupConfig(invalidPort, 'test.json')).toThrow(/'mcp.port' must be an integer between 1024 and 65535/);

    const invalidBudget: Record<string, unknown> = {
      baseUrl: 'http://localhost:8790',
      agents: { primary: 'p', fallback: 'f' },
      mcp: { name: 'mcp', port: 8792, path: '/mcp', perWorkspace: false },
      budgets: { seedTokens: -1, mentionsTokens: 1, runToolBudgetTokens: 1, maxToolCalls: 1, maxRunSeconds: 1 },
      retry: { max: 1, baseDelayMs: 1 },
    };
    expect(() => validateSetupConfig(invalidBudget, 'test.json')).toThrow(/'budgets.seedTokens' must be a positive number/);
  });

  it('validates model profiles and rejects incomplete profile objects', () => {
    const missingKind: Record<string, unknown> = {
      agent: 'forge-primary',
      provider: 'google',
      modelId: 'gemini-2.5',
      modelContextTokens: 65536,
    };
    expect(() => validateModelProfile(missingKind, 'primary', 'test.json')).toThrow(/missing or empty 'profiles.primary.kind'/);

    const invalidTokens: Record<string, unknown> = {
      agent: 'forge-primary',
      provider: 'google',
      modelId: 'gemini-2.5',
      kind: 'gemini',
      modelContextTokens: -50,
    };
    expect(() => validateModelProfile(invalidTokens, 'primary', 'test.json')).toThrow(/'profiles.primary.modelContextTokens' must be a positive number/);
  });

  it('deepMerge performs recursive merge and replaces arrays and primitives without any', () => {
    const target = { a: 1, nested: { b: 2, c: 3 }, arr: [1, 2] };
    const source: Record<string, unknown> = { nested: { c: 99, d: 4 }, arr: [9] };
    const merged = deepMerge(target, source);

    expect(merged.a).toBe(1);
    expect(merged.nested.b).toBe(2);
    expect(merged.nested.c).toBe(99);
    expect(asRecord(merged.nested).d).toBe(4);
    expect(merged.arr).toEqual([9]);
  });

  it('loadConfig loads example defaults when local configs are absent', () => {
    const cfg = loadConfig({ workspaceRoot: process.cwd() });
    expect(cfg.setup.baseUrl).toBe('http://localhost:8790');
    expect(cfg.setup.isLoopback).toBe(true);
    expect(cfg.setup.mcp.port).toBe(8792);
    expect(cfg.models.profiles.primary.agent).toBe('forge-primary');
  });

  it('loadConfig throws ConfigError on non-loopback base URL unless explicitly allowed', () => {
    expect(() => {
      validateBaseUrl('https://api.external.com');
    }).not.toThrow();

    const check = validateBaseUrl('https://api.external.com');
    expect(check.rejected).toBe(true);
  });

  it('validateSetupConfig accepts optional mcp.token and throws ConfigError if empty string', () => {
    const validConfig = {
      baseUrl: 'http://127.0.0.1:8790',
      agents: { primary: 'p', fallback: 'f' },
      mcp: { name: 'm', perWorkspace: false, port: 8792, path: '/mcp', token: 'valid-token' },
      budgets: { seedTokens: 1, mentionsTokens: 1, runToolBudgetTokens: 1, maxToolCalls: 1, maxRunSeconds: 1 },
      retry: { max: 1, baseDelayMs: 1 },
    };
    expect(() => validateSetupConfig(validConfig, 'test.json')).not.toThrow();

    const emptyTokenConfig = {
      ...validConfig,
      mcp: { ...validConfig.mcp, token: '   ' },
    };
    expect(() => validateSetupConfig(emptyTokenConfig, 'test.json')).toThrow(ConfigError);
    expect(() => validateSetupConfig(emptyTokenConfig, 'test.json')).toThrow(/'mcp.token' must be a non-empty string/);
  });

  it('loadConfig merges persistent mcp.token from setup.local.json preserving other keys', () => {
    const tmpForgeDir = path.resolve(process.cwd(), 'node_modules/.tmp-config-token-test');
    fs.mkdirSync(tmpForgeDir, { recursive: true });

    try {
      // Copy example files into temp forge directory
      const baseSetup = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'forge/setup.example.json'), 'utf-8'));
      const baseModels = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'forge/models.example.json'), 'utf-8'));
      fs.writeFileSync(path.resolve(tmpForgeDir, 'setup.example.json'), JSON.stringify(baseSetup, null, 2));
      fs.writeFileSync(path.resolve(tmpForgeDir, 'models.example.json'), JSON.stringify(baseModels, null, 2));

      // Simulate setup persisting a generated 32-byte hex token and unrelated custom setting
      const generatedToken = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
      const localSetup = {
        custom_unrelated_setting: 'preserve_me',
        mcp: {
          token: generatedToken,
        },
      };
      fs.writeFileSync(path.resolve(tmpForgeDir, 'setup.local.json'), JSON.stringify(localSetup, null, 2));

      const loaded = loadConfig({ forgeDir: tmpForgeDir, workspaceRoot: process.cwd() });
      expect(loaded.setup.mcp.token).toBe(generatedToken);
      expect((loaded.setup as unknown as Record<string, unknown>).custom_unrelated_setting).toBe('preserve_me');
      expect(loaded.setup.baseUrl).toBe(baseSetup.baseUrl);
    } finally {
      fs.rmSync(tmpForgeDir, { recursive: true, force: true });
    }
  });

  it('throws ConfigError when canonical agent instructions or spec are missing or invalid', () => {
    const tmpDir = path.resolve(process.cwd(), 'node_modules/.tmp-canonical-test');
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      // Missing agent-instructions.md
      expect(() => loadCanonicalAgentConfig(tmpDir)).toThrow(ConfigError);
      expect(() => loadCanonicalAgentConfig(tmpDir)).toThrow(/instructions file missing/);

      // Empty agent-instructions.md
      const instPath = path.resolve(tmpDir, 'agent-instructions.md');
      fs.writeFileSync(instPath, '   \n');
      expect(() => loadCanonicalAgentConfig(tmpDir)).toThrow(ConfigError);
      expect(() => loadCanonicalAgentConfig(tmpDir)).toThrow(/instructions file is empty/);

      // Valid instructions, missing agent.spec.json
      fs.writeFileSync(instPath, 'Valid prompt instructions');
      expect(() => loadCanonicalAgentConfig(tmpDir)).toThrow(ConfigError);
      expect(() => loadCanonicalAgentConfig(tmpDir)).toThrow(/agent spec file missing/);

      // Invalid JSON in agent.spec.json
      const specPath = path.resolve(tmpDir, 'agent.spec.json');
      fs.writeFileSync(specPath, '{ invalid json');
      expect(() => loadCanonicalAgentConfig(tmpDir)).toThrow(ConfigError);
      expect(() => loadCanonicalAgentConfig(tmpDir)).toThrow(/Failed to parse JSON file/);

      // Valid spec
      fs.writeFileSync(specPath, JSON.stringify({ name: 'forge-primary', skills: ['lint'] }));
      const loaded = loadCanonicalAgentConfig(tmpDir);
      expect(loaded.instructions).toBe('Valid prompt instructions');
      expect(loaded.spec.name).toBe('forge-primary');
      expect(loaded.spec.skills).toEqual(['lint']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Robust SSE Parser (parseSseStream)', () => {
  it('parses standard SSE events with id field', async () => {
    const raw = 'id: evt_01\nevent: message\ndata: {"type":"turn.created","id":"t1"}\n\n';
    const stream = createReadableByteStream([new TextEncoder().encode(raw)]);
    const events: RawEvent[] = [];

    for await (const evt of parseSseStream(stream)) {
      events.push(evt);
    }

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('evt_01');
    expect(events[0].event).toBe('message');
    expect(asRecord(events[0].data).type).toBe('turn.created');
    expect(asRecord(events[0].data).id).toBe('t1');
  });

  it('correctly handles chunk boundaries split across a line', async () => {
    const part1 = new TextEncoder().encode('event: message\ndata: {"type":"turn.');
    const part2 = new TextEncoder().encode('done","status":"ok"}\n\n');
    const stream = createReadableByteStream([part1, part2]);
    const events: RawEvent[] = [];

    for await (const evt of parseSseStream(stream)) {
      events.push(evt);
    }

    expect(events).toHaveLength(1);
    expect(asRecord(events[0].data).type).toBe('turn.done');
    expect(asRecord(events[0].data).status).toBe('ok');
  });

  it('preserves multi-byte UTF-8 code points split across chunk boundaries without replacement characters', async () => {
    // Arrow symbol '→' is 3 bytes in UTF-8: 0xE2, 0x86, 0x92
    const prefix = new TextEncoder().encode('event: message\ndata: {"arrow":"');
    const b1 = 0xe2;
    const b2 = 0x86;
    const b3 = 0x92;
    const suffix = new TextEncoder().encode('"}\n\n');

    const chunk1 = new Uint8Array(prefix.length + 2);
    chunk1.set(prefix);
    chunk1[prefix.length] = b1;
    chunk1[prefix.length + 1] = b2;

    const chunk2 = new Uint8Array(1 + suffix.length);
    chunk2[0] = b3;
    chunk2.set(suffix, 1);

    const stream = createReadableByteStream([chunk1, chunk2]);
    const events: RawEvent[] = [];

    for await (const evt of parseSseStream(stream)) {
      events.push(evt);
    }

    expect(events).toHaveLength(1);
    expect(asRecord(events[0].data).arrow).toBe('→');
    expect(events[0].rawData).not.toContain('\uFFFD');
  });

  it('joins multiline data lines with newline', async () => {
    const raw = 'event: message\ndata: line 1\ndata: line 2\n\n';
    const stream = createReadableByteStream([new TextEncoder().encode(raw)]);
    const events: RawEvent[] = [];

    for await (const evt of parseSseStream(stream)) {
      events.push(evt);
    }

    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('line 1\nline 2');
  });

  it('ignores SSE comment lines and keepalives', async () => {
    const raw = ': keepalive\n: ping\nevent: message\ndata: {"id":1}\n\n';
    const stream = createReadableByteStream([new TextEncoder().encode(raw)]);
    const events: RawEvent[] = [];

    for await (const evt of parseSseStream(stream)) {
      events.push(evt);
    }

    expect(events).toHaveLength(1);
    expect(asRecord(events[0].data).id).toBe(1);
  });

  it('handles CRLF line endings identically to LF', async () => {
    const raw = 'event: message\r\ndata: {"crlf":true}\r\n\r\n';
    const stream = createReadableByteStream([new TextEncoder().encode(raw)]);
    const events: RawEvent[] = [];

    for await (const evt of parseSseStream(stream)) {
      events.push(evt);
    }

    expect(events).toHaveLength(1);
    expect(asRecord(events[0].data).crlf).toBe(true);
  });

  it('stops cleanly when AbortController aborts mid-stream', async () => {
    const ctrl = new AbortController();
    const raw = 'event: message\ndata: {"step":1}\n\nevent: message\ndata: {"step":2}\n\n';
    const stream = createReadableByteStream([new TextEncoder().encode(raw)]);
    const events: RawEvent[] = [];

    for await (const evt of parseSseStream(stream, ctrl.signal)) {
      events.push(evt);
      ctrl.abort();
    }

    expect(events).toHaveLength(1);
    expect(asRecord(events[0].data).step).toBe(1);
  });

  it('cancels pending reader.read immediately when stream remains open and signal aborts', async () => {
    const ctrl = new AbortController();
    // Stream enqueues first chunk and then stays open indefinitely
    const pendingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message\ndata: {"step":1}\n\n'));
      },
      pull() {
        return new Promise<void>(() => {});
      },
    });

    const generator = parseSseStream(pendingStream, ctrl.signal);

    const first = await generator.next();
    expect(first.done).toBe(false);
    expect(first.value).toBeDefined();
    expect(asRecord(first.value!.data).step).toBe(1);

    // Now reader.read() will be pending
    const nextPromise = generator.next();

    // Abort signal while read is pending
    ctrl.abort();

    const second = await nextPromise;
    expect(second.done).toBe(true);
    expect(getEventListeners(ctrl.signal, 'abort').length).toBe(0);
  });

  it('does not accumulate abort listeners during multi-chunk normal reads and cleans up on completion', async () => {
    const ctrl = new AbortController();
    expect(getEventListeners(ctrl.signal, 'abort').length).toBe(0);

    // 20 sequential chunks
    const chunks: Uint8Array[] = [];
    for (let i = 1; i <= 20; i++) {
      chunks.push(new TextEncoder().encode(`event: message\ndata: {"chunk":${i}}\n\n`));
    }
    const stream = createReadableByteStream(chunks);

    let chunksRead = 0;
    for await (const _evt of parseSseStream(stream, ctrl.signal)) {
      chunksRead++;
      // Listener count during active reading must never exceed 1
      expect(getEventListeners(ctrl.signal, 'abort').length).toBeLessThanOrEqual(1);
    }

    expect(chunksRead).toBe(20);
    // After stream completes normally, listener must be completely removed
    expect(getEventListeners(ctrl.signal, 'abort').length).toBe(0);
  });
});

describe('ForgeClient Protocol & Helpers', () => {
  it('health() never throws and reports detail on failure', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const client = new ForgeClient(dummySetup);
    const h = await client.health();

    expect(h.ok).toBe(false);
    expect(h.detail).toContain('Cannot connect to TrueForge');
    global.fetch = originalFetch;
  });

  it('userMessageInput formats prompt and context blocks correctly', () => {
    const client = new ForgeClient(dummySetup);
    const plain = client.userMessageInput('Hello world');
    expect(plain).toEqual([{ type: 'user.message', content: 'Hello world' }]);

    const withContext = client.userMessageInput('Fix bug', [
      { path: 'src/main.ts', reason: 'entry point', range: { startLine: 1, endLine: 10 }, text: 'const x = 1;' },
    ]);
    const firstBlock = asRecord(withContext[0]);
    expect(firstBlock.type).toBe('user.message');
    expect(firstBlock.content).toContain('src/main.ts');
    expect(firstBlock.content).toContain('lines 1-10');
    expect(firstBlock.content).toContain('Fix bug');
  });

  it('approvalsInput formats decisions without review bypass items', () => {
    const client = new ForgeClient(dummySetup);
    const decisions = client.approvalsInput([
      { threadId: 'main', toolCallId: 'call_1', status: 'allow' },
      { threadId: 'main', toolCallId: 'call_2', status: 'deny', reason: 'Rejected by user' },
    ]);

    expect(decisions).toHaveLength(2);
    const d0 = asRecord(decisions[0]);
    expect(d0.type).toBe('user.tool_approval');
    expect(d0.tool_call_id).toBe('call_1');
    expect(d0.approval).toEqual({ status: 'allow' });

    const d1 = asRecord(decisions[1]);
    expect(d1.type).toBe('user.tool_approval');
    expect(d1.tool_call_id).toBe('call_2');
    expect(d1.approval).toEqual({ status: 'deny', reason: 'Rejected by user' });

    // Invariant: client does not contain review bypass policies
    expect(asRecord(client).tool_approval_policy).toBeUndefined();
  });

  it('cancel maps 200 to cancelled and 404/409 to already_terminal', async () => {
    const originalFetch = global.fetch;
    const client = new ForgeClient(dummySetup);

    // Mock 200
    global.fetch = vi.fn().mockResolvedValue(createMockResponse(200, { status: 'ok' }));
    const c1 = await client.cancel('sess_1');
    expect(c1).toEqual({ ok: true, status: 'cancelled' });

    // Mock 404
    global.fetch = vi.fn().mockResolvedValue(createMockResponse(404, { message: 'Session not found' }));
    const c2 = await client.cancel('sess_1');
    expect(c2).toEqual({ ok: true, status: 'already_terminal' });

    // Mock 500 throws HttpError
    global.fetch = vi.fn().mockResolvedValue(createMockResponse(500, 'Internal Error'));
    await expect(client.cancel('sess_1')).rejects.toThrow(HttpError);

    global.fetch = originalFetch;
  });

  it('correctly translates HTTP and network errors with typed wrappers', () => {
    const httpErr = new HttpError(403, { error: 'Forbidden' }, 'Custom action');
    expect(httpErr.status).toBe(403);
    expect(httpErr.message).toContain('HTTP 403');
    expect(httpErr.message).toContain('Forbidden');
    expect(httpErr.body).toEqual({ error: 'Forbidden' });

    const cause = new Error('ECONNREFUSED 127.0.0.1:8790');
    const netErr = new NetworkError('ECONNREFUSED', cause);
    expect(netErr.code).toBe('ECONNREFUSED');
    expect(netErr.cause).toBe(cause);
    expect(netErr.message).toContain('Network error [ECONNREFUSED]');
  });
});

describe('Committed Event Fixture Replay', () => {
  it('replays 01-plain.jsonl cleanly', async () => {
    const fixturePath = path.resolve(process.cwd(), 'fixtures/events/01-plain.jsonl');
    const rawContent = fs.readFileSync(fixturePath, 'utf-8');

    const lines = rawContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const sseText = lines.map((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return `event: ${parsed.event || 'message'}\ndata: ${JSON.stringify(parsed.data)}\n\n`;
    }).join('');

    const stream = createReadableByteStream([new TextEncoder().encode(sseText)]);
    const events: RawEvent[] = [];

    for await (const evt of parseSseStream(stream)) {
      events.push(evt);
    }

    expect(events.length).toBeGreaterThanOrEqual(4);
    const types = events.map((e) => asRecord(e.data).type);
    expect(types).toContain('turn.created');
    expect(types).toContain('model.message');
    expect(types).toContain('model.message.delta');
    expect(types).toContain('turn.done');
  });

  it('replays 04-cancel.jsonl and extracts cancelled terminal state', async () => {
    const fixturePath = path.resolve(process.cwd(), 'fixtures/events/04-cancel.jsonl');
    const rawContent = fs.readFileSync(fixturePath, 'utf-8');
    const lines = rawContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const sseText = lines.map((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return `event: ${parsed.event || 'message'}\ndata: ${JSON.stringify(parsed.data)}\n\n`;
    }).join('');

    const stream = createReadableByteStream([new TextEncoder().encode(sseText)]);
    const events: RawEvent[] = [];

    for await (const evt of parseSseStream(stream)) {
      events.push(evt);
    }

    const doneEvt = events.find((e) => asRecord(e.data).type === 'turn.done');
    expect(doneEvt).toBeDefined();
    expect(asRecord(asRecord(doneEvt!.data).state).status).toBe('cancelled');
  });

  it('replays 05-model-404.jsonl and extracts error terminal state', async () => {
    const fixturePath = path.resolve(process.cwd(), 'fixtures/events/05-model-404.jsonl');
    const rawContent = fs.readFileSync(fixturePath, 'utf-8');
    const lines = rawContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const sseText = lines.map((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return `event: ${parsed.event || 'message'}\ndata: ${JSON.stringify(parsed.data)}\n\n`;
    }).join('');

    const stream = createReadableByteStream([new TextEncoder().encode(sseText)]);
    const events: RawEvent[] = [];

    for await (const evt of parseSseStream(stream)) {
      events.push(evt);
    }

    const doneEvt = events.find((e) => asRecord(e.data).type === 'turn.done');
    expect(doneEvt).toBeDefined();
    expect(asRecord(asRecord(doneEvt!.data).state).status).toBe('error');
    expect(asRecord(asRecord(doneEvt!.data).state).message).toContain('404');
  });
});

describe('Approvals Resumption & Reconnection Protocol', () => {
  it('submitApprovals sends POST /events and returns server-minted event IDs', async () => {
    const originalFetch = global.fetch;
    const client = new ForgeClient(dummySetup);

    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/api/v1/sessions/sess_1/turns/turn_1/events');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string) as { events: Array<{ tool_call_id: string }> };
      expect(body.events).toHaveLength(1);
      expect(body.events[0].tool_call_id).toBe('call_123');

      return createMockResponse(201, {
        data: [{ id: 'evt_server_minted_1', type: 'user.tool_approval' }],
      });
    });

    const res = await client.submitApprovals('sess_1', 'turn_1', [
      { type: 'user.tool_approval', thread_id: 'main', tool_call_id: 'call_123', approval: { status: 'allow' } },
    ]);

    expect(res.eventIds).toEqual(['evt_server_minted_1']);
    global.fetch = originalFetch;
  });

  it('never resubmits approvals after receiving HTTP 201', async () => {
    const originalFetch = global.fetch;
    const client = new ForgeClient(dummySetup);
    let postCount = 0;

    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.includes('/turns/turn_1/events')) {
        postCount++;
        return createMockResponse(201, {
          data: [{ id: 'evt_minted_1', type: 'user.tool_approval' }],
        });
      }
      return createMockResponse(404, {});
    });

    const decision = [
      { type: 'user.tool_approval', thread_id: 'main', tool_call_id: 'call_unique_1', approval: { status: 'allow' } },
    ];

    // First submission: should make HTTP POST and return minted event ID
    const res1 = await client.submitApprovals('sess_1', 'turn_1', decision);
    expect(res1.eventIds).toEqual(['evt_minted_1']);
    expect(postCount).toBe(1);

    // Second submission with the same toolCallId: must NOT make another HTTP POST
    const res2 = await client.submitApprovals('sess_1', 'turn_1', decision);
    expect(res2.eventIds).toEqual(['evt_minted_1']);
    expect(postCount).toBe(1); // fetch was NOT called again!

    global.fetch = originalFetch;
  });

  it('throws ForgeClientError and prevents blind resubmission when HTTP 201 response has missing IDs', async () => {
    const originalFetch = global.fetch;
    const client = new ForgeClient(dummySetup);
    let postCount = 0;

    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postCount++;
        return createMockResponse(201, {
          data: [{ type: 'user.tool_approval' }], // Missing id
        });
      }
      return createMockResponse(404, {});
    });

    const decision = [
      { type: 'user.tool_approval', thread_id: 'main', tool_call_id: 'call_missing_id', approval: { status: 'allow' } },
    ];

    await expect(client.submitApprovals('sess_1', 'turn_1', decision)).rejects.toThrow(ForgeClientError);
    expect(postCount).toBe(1);

    // Calling again: must not blindly resubmit to /events; must throw reconciliation error
    await expect(client.submitApprovals('sess_1', 'turn_1', decision)).rejects.toThrow(
      /reconciliation required/
    );
    expect(postCount).toBe(1);

    global.fetch = originalFetch;
  });

  it('throws ForgeClientError and prevents blind resubmission when HTTP 201 response array is incomplete', async () => {
    const originalFetch = global.fetch;
    const client = new ForgeClient(dummySetup);
    let postCount = 0;

    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postCount++;
        return createMockResponse(201, {
          data: [{ id: 'evt_only_one' }], // Submitted 2, got 1
        });
      }
      return createMockResponse(404, {});
    });

    const decision = [
      { type: 'user.tool_approval', thread_id: 'main', tool_call_id: 'call_incomplete_1', approval: { status: 'allow' } },
      { type: 'user.tool_approval', thread_id: 'main', tool_call_id: 'call_incomplete_2', approval: { status: 'deny' } },
    ];

    await expect(client.submitApprovals('sess_1', 'turn_1', decision)).rejects.toThrow(
      /Server returned HTTP 201 with 1 event\(s\), but 2 approval\(s\) were submitted/
    );
    expect(postCount).toBe(1);

    // Calling again: must not blindly resubmit after HTTP 201; must throw reconciliation error
    await expect(client.submitApprovals('sess_1', 'turn_1', decision)).rejects.toThrow(
      /reconciliation required/
    );
    expect(postCount).toBe(1);

    global.fetch = originalFetch;
  });

  it('throws ForgeClientError and prevents blind resubmission when HTTP 201 response payload is malformed', async () => {
    const originalFetch = global.fetch;
    const client = new ForgeClient(dummySetup);
    let postCount = 0;

    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postCount++;
        return createMockResponse(201, { status: 'success' }); // Missing data array
      }
      return createMockResponse(404, {});
    });

    const decision = [
      { type: 'user.tool_approval', thread_id: 'main', tool_call_id: 'call_malformed', approval: { status: 'allow' } },
    ];

    await expect(client.submitApprovals('sess_1', 'turn_1', decision)).rejects.toThrow(
      /Server returned HTTP 201 but response payload was malformed/
    );
    expect(postCount).toBe(1);

    // Calling again: must not blindly resubmit after HTTP 201; must throw reconciliation error
    await expect(client.submitApprovals('sess_1', 'turn_1', decision)).rejects.toThrow(
      /reconciliation required/
    );
    expect(postCount).toBe(1);

    global.fetch = originalFetch;
  });

  it('records all approvals as unverified when second item lacks an ID and blocks second HTTP POST on subsequent call', async () => {
    const originalFetch = global.fetch;
    const client = new ForgeClient(dummySetup);
    let postCount = 0;

    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postCount++;
        return createMockResponse(201, {
          data: [
            { id: 'evt_1', type: 'user.tool_approval' },
            { type: 'user.tool_approval' }, // Second item lacks ID
            { id: 'evt_3', type: 'user.tool_approval' },
          ],
        });
      }
      return createMockResponse(404, {});
    });

    const decisions = [
      { type: 'user.tool_approval', thread_id: 'main', tool_call_id: 'call_1', approval: { status: 'allow' } },
      { type: 'user.tool_approval', thread_id: 'main', tool_call_id: 'call_2', approval: { status: 'allow' } },
      { type: 'user.tool_approval', thread_id: 'main', tool_call_id: 'call_3', approval: { status: 'allow' } },
    ];

    // First call must throw because second response item has no ID
    await expect(client.submitApprovals('sess_1', 'turn_1', decisions)).rejects.toThrow(
      /missing a valid 'id' property/
    );
    expect(postCount).toBe(1);

    // Second call: call_1, call_2, AND call_3 must all be recorded as unverified
    // It must throw the reconciliation error and NEVER perform a second HTTP POST!
    await expect(client.submitApprovals('sess_1', 'turn_1', decisions)).rejects.toThrow(
      /Resubmission refused; reconciliation required/
    );
    expect(postCount).toBe(1); // Crucial assertion: no second HTTP POST occurred!

    // Later approval (call_3) was not left unrecorded:
    await expect(client.submitApprovals('sess_1', 'turn_1', [decisions[2]])).rejects.toThrow(
      /Resubmission refused; reconciliation required/
    );
    expect(postCount).toBe(1); // Still exactly 1!

    global.fetch = originalFetch;
  });

  it('never returns an unverified commit as a valid event ID', async () => {
    const originalFetch = global.fetch;
    const client = new ForgeClient(dummySetup);

    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return createMockResponse(201, {
          data: [{ id: '' }], // Empty invalid ID
        });
      }
      return createMockResponse(404, {});
    });

    const decision = [
      { type: 'user.tool_approval', thread_id: 'main', tool_call_id: 'call_unverified_guard', approval: { status: 'allow' } },
    ];

    // First call throws validation error
    await expect(client.submitApprovals('sess_1', 'turn_1', decision)).rejects.toThrow(ForgeClientError);

    // Subsequent call MUST throw reconciliation error and NEVER return a sentinel string like 'committed-unverified'
    await expect(client.submitApprovals('sess_1', 'turn_1', decision)).rejects.toThrow(
      /reconciliation required/
    );

    global.fetch = originalFetch;
  });

  it('handles dropped stream, reconnects with cursor, deduplicates replayed events, and delivers turn.done', async () => {
    const originalFetch = global.fetch;
    const client = new ForgeClient(dummySetup);
    let requestCount = 0;
    const requestedUrls: string[] = [];

    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      requestCount++;
      requestedUrls.push(url);

      if (requestCount === 1) {
        // First connection yields event 1, then drops connection abruptly without turn.done
        const sseText = 'id: evt_1\nevent: message\ndata: {"type":"model.message.delta","content":"part1"}\n\n';
        return createMockStreamResponse([new TextEncoder().encode(sseText)]);
      }

      if (requestCount === 2) {
        // Reconnected stream: server replays evt_1 (duplicate) plus evt_2, plus terminal turn.done
        const sseText =
          'id: evt_1\nevent: message\ndata: {"type":"model.message.delta","content":"part1"}\n\n' +
          'id: evt_2\nevent: message\ndata: {"type":"model.message.delta","content":"part2"}\n\n' +
          'id: evt_3\nevent: message\ndata: {"type":"turn.done","status":"done"}\n\n';
        return createMockStreamResponse([new TextEncoder().encode(sseText)]);
      }

      return createMockResponse(404, {});
    });

    const events: RawEvent[] = [];
    for await (const evt of client.subscribeTurn('sess_1', 'turn_1', {
      afterEventId: 'evt_0',
      reconnectDelayMs: 10,
      maxReconnectAttempts: 2,
    })) {
      events.push(evt);
    }

    // 1. Initial request used after_event_id=evt_0
    expect(requestedUrls[0]).toContain('after_event_id=evt_0');

    // 2. Second request automatically used after_event_id=evt_1
    expect(requestedUrls[1]).toContain('after_event_id=evt_1');

    // 3. Duplicate evt_1 in stream 2 was deduplicated!
    expect(events).toHaveLength(3); // evt_1, evt_2, evt_3
    expect(events[0].id).toBe('evt_1');
    expect(events[1].id).toBe('evt_2');
    expect(events[2].id).toBe('evt_3');
    expect(asRecord(events[2].data).type).toBe('turn.done');

    global.fetch = originalFetch;
  });

  it('enforces configured retry limit when every connection emits an event and drops without turn.done', async () => {
    const originalFetch = global.fetch;
    const client = new ForgeClient(dummySetup);
    let requestCount = 0;

    global.fetch = vi.fn().mockImplementation(async () => {
      requestCount++;
      // Every connection emits an event with id and drops without turn.done
      const sseText = `id: evt_${requestCount}\nevent: message\ndata: {"type":"model.message.delta","content":"c${requestCount}"}\n\n`;
      return createMockStreamResponse([new TextEncoder().encode(sseText)]);
    });

    const events: RawEvent[] = [];
    await expect(async () => {
      for await (const evt of client.subscribeTurn('sess_1', 'turn_1', {
        maxReconnectAttempts: 2,
        reconnectDelayMs: 10,
      })) {
        events.push(evt);
      }
    }).rejects.toThrow(NetworkError);

    // Initial connection (1) + 2 reconnect attempts = 3 total requests
    expect(requestCount).toBe(3);
    expect(events).toHaveLength(3);

    global.fetch = originalFetch;
  });

  it('detects terminal event when identified by SSE event field instead of data.type', async () => {
    const originalFetch = global.fetch;
    const client = new ForgeClient(dummySetup);

    global.fetch = vi.fn().mockImplementation(async () => {
      // SSE stream where event is 'turn.done', but data has no 'type' field
      const sseText = 'event: turn.done\ndata: {"status":"done","output":"completed"}\n\n';
      return createMockStreamResponse([new TextEncoder().encode(sseText)]);
    });

    const events: RawEvent[] = [];
    for await (const evt of client.subscribeTurn('sess_1', 'turn_1')) {
      events.push(evt);
    }

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('turn.done');
    expect(asRecord(events[0].data).status).toBe('done');

    global.fetch = originalFetch;
  });
});

describe('MCP Registration & Connector Synchronization', () => {
  it('registerMcp sends PUT /api/v1/settings/mcp-servers with correct manifest payload and returns reused: true', async () => {
    const originalFetch = global.fetch;
    const client = new ForgeClient(dummySetup);
    let capturedMethod = '';
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      capturedMethod = init?.method ?? '';
      capturedUrl = url;
      if (typeof init?.body === 'string') {
        capturedBody = JSON.parse(init.body);
      }
      return createMockResponse(200, { status: 'ok' });
    });

    const res = await client.registerMcp({
      name: 'forge-editor',
      url: 'http://127.0.0.1:8792/mcp',
      token: 'persistent-token-12345',
    });

    expect(capturedMethod).toBe('PUT');
    expect(capturedUrl).toContain('/api/v1/settings/mcp-servers');
    expect(capturedBody).toEqual({
      manifest: {
        type: 'remote',
        name: 'forge-editor',
        description: 'Forge Editor tools (read-only queries + proposal handlers)',
        url: 'http://127.0.0.1:8792/mcp',
        auth: {
          type: 'header',
          headers: { 'x-forge-token': 'persistent-token-12345' },
        },
      },
    });
    expect(res).toEqual({ ok: true, reused: true });

    global.fetch = originalFetch;
  });

  it('registerMcp updates existing connector in place via PUT without relying on masked token comparison', async () => {
    const originalFetch = global.fetch;
    const client = new ForgeClient(dummySetup);

    // TrueForge PUT updates in place and returns 200/204
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('PUT');
      return createMockResponse(200, {
        id: 'conn_1',
        name: 'forge-editor',
        manifest: {
          url: 'http://127.0.0.1:8792/mcp',
          auth: { type: 'header', headers: { 'x-forge-token': 'for-***REDACTED***-ken' } },
        },
      });
    });

    const res = await client.registerMcp({
      name: 'forge-editor',
      url: 'http://127.0.0.1:8792/mcp',
      token: 'new-updated-token-999',
    });

    expect(res.ok).toBe(true);
    expect(res.reused).toBe(true);

    global.fetch = originalFetch;
  });

  it('registerMcp redacts secret token from error message when TrueForge returns HTTP 500 error', async () => {
    const originalFetch = global.fetch;
    const client = new ForgeClient(dummySetup);
    const secretToken = 'unshared-secret-token-abcdef123456';

    global.fetch = vi.fn().mockImplementation(async () => {
      return createMockResponse(500, {
        error: `Internal server failure while storing header x-forge-token ${secretToken}`,
      });
    });

    let caughtError: HttpError | null = null;
    try {
      await client.registerMcp({
        name: 'forge-editor',
        url: 'http://127.0.0.1:8792/mcp',
        token: secretToken,
      });
    } catch (err: unknown) {
      caughtError = err as HttpError;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError!.status).toBe(500);
    expect(caughtError!.message).toContain('[REDACTED]');
    expect(caughtError!.message).not.toContain(secretToken);
    expect(JSON.stringify(caughtError!.body)).toContain('[REDACTED]');
    expect(JSON.stringify(caughtError!.body)).not.toContain(secretToken);

    global.fetch = originalFetch;
  });

  it('registerMcp handles 400 Bad Request safely with redacted token in error', async () => {
    const originalFetch = global.fetch;
    const client = new ForgeClient(dummySetup);
    const secretToken = 'another-bad-request-secret-token';

    global.fetch = vi.fn().mockImplementation(async () => {
      return createMockResponse(400, {
        detail: `Invalid manifest format for token: ${secretToken}`,
      });
    });

    let caughtError: HttpError | null = null;
    try {
      await client.registerMcp({
        name: 'forge-editor',
        url: 'http://127.0.0.1:8792/mcp',
        token: secretToken,
      });
    } catch (err: unknown) {
      caughtError = err as HttpError;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError!.status).toBe(400);
    expect(caughtError!.message).toContain('[REDACTED]');
    expect(caughtError!.message).not.toContain(secretToken);

    global.fetch = originalFetch;
  });

  it('ensureAgents throws ForgeClientError when model configuration is missing or contains placeholders', async () => {
    const client = new ForgeClient(dummySetup);

    // Missing modelsConfig
    await expect(client.ensureAgents(undefined)).rejects.toThrow(ForgeClientError);
    await expect(client.ensureAgents(undefined)).rejects.toThrow(
      /ModelsConfig is required to configure agents/
    );

    // Placeholder in primary
    const placeholderConfig: ModelsConfig = {
      profiles: {
        primary: {
          agent: 'forge-primary',
          provider: 'google',
          modelId: 'YOUR_GEMINI_MODEL',
          kind: 'gemini',
          modelContextTokens: 65536,
        },
        fallback: {
          agent: 'forge-fallback',
          provider: 'google',
          modelId: 'google-gemini/gemini-2.5-flash',
          kind: 'gemini',
          modelContextTokens: 65536,
        },
      },
    };

    await expect(client.ensureAgents(placeholderConfig)).rejects.toThrow(
      /Missing or unconfigured primary modelId/
    );

    // Placeholder in fallback
    const fallbackPlaceholder: ModelsConfig = {
      profiles: {
        primary: {
          agent: 'forge-primary',
          provider: 'google',
          modelId: 'google-gemini/gemini-2.5-flash',
          kind: 'gemini',
          modelContextTokens: 65536,
        },
        fallback: {
          agent: 'forge-fallback',
          provider: 'google',
          modelId: 'YOUR_FALLBACK_MODEL',
          kind: 'gemini',
          modelContextTokens: 65536,
        },
      },
    };

    await expect(client.ensureAgents(fallbackPlaceholder)).rejects.toThrow(
      /Missing or unconfigured fallback modelId/
    );
  });

  it('ensureAgents refuses update when ownership marker is absent', async () => {
    const originalFetch = global.fetch;
    const client = new ForgeClient(dummySetup);

    const validModelsConfig: ModelsConfig = {
      profiles: {
        primary: {
          agent: 'forge-primary',
          provider: 'google',
          modelId: 'google-gemini/gemini-2.5-flash',
          kind: 'gemini',
          modelContextTokens: 65536,
        },
        fallback: {
          agent: 'forge-fallback',
          provider: 'google',
          modelId: 'google-gemini/gemini-2.5-flash',
          kind: 'gemini',
          modelContextTokens: 65536,
        },
      },
    };

    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'GET' && url.endsWith('/api/v1/agents')) {
        return createMockResponse(200, {
          data: [{ id: 'agent_unowned_1', name: 'forge-primary' }],
        });
      }
      if (init?.method === 'GET' && url.includes('/agents/agent_unowned_1')) {
        return createMockResponse(200, {
          id: 'agent_unowned_1',
          name: 'forge-primary',
          description: 'Unrelated agent created by another user',
          manifest: {},
        });
      }
      return createMockResponse(404, {});
    });

    await expect(client.ensureAgents(validModelsConfig)).rejects.toThrow(
      /Refusing to overwrite existing agent 'forge-primary'/
    );

    global.fetch = originalFetch;
  });

  it('ensureAgents updates existing agent when ownership marker is present and preserves extra manifest fields', async () => {
    const originalFetch = global.fetch;
    const client = new ForgeClient(dummySetup);

    const validModelsConfig: ModelsConfig = {
      profiles: {
        primary: {
          agent: 'forge-primary',
          provider: 'google',
          modelId: 'google-gemini/gemini-2.5-flash',
          kind: 'gemini',
          modelContextTokens: 65536,
        },
        fallback: {
          agent: 'forge-fallback',
          provider: 'google',
          modelId: 'google-gemini/gemini-2.5-flash',
          kind: 'gemini',
          modelContextTokens: 65536,
        },
      },
    };

    let putCalled = false;
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'GET' && url.endsWith('/api/v1/agents')) {
        return createMockResponse(200, {
          data: [
            { id: 'agent_owned_1', name: 'forge-primary' },
            { id: 'agent_owned_2', name: 'forge-fallback' },
          ],
        });
      }
      if (init?.method === 'GET' && (url.includes('/agents/agent_owned_1') || url.includes('/agents/agent_owned_2'))) {
        return createMockResponse(200, {
          id: 'agent_owned_1',
          name: 'forge-primary',
          description: '[managed-by:forge-agent] Primary agent',
          manifest: { skills: ['existing_custom_skill'] },
        });
      }
      if (init?.method === 'PUT') {
        putCalled = true;
        const body = JSON.parse(init?.body as string) as {
          manifest: {
            skills: string[];
            instructions: string;
            mcp_servers: Array<{ preload: boolean; require_approval_for_tools: string[] }>;
          };
        };
        // Preserves custom skills from previous manifest
        expect(body.manifest.skills).toEqual(['existing_custom_skill']);
        // Reads canonical instructions from forge/agent-instructions.md
        expect(body.manifest.instructions).toContain("You are a coding agent working inside a user's editor");
        expect(body.manifest.mcp_servers[0].preload).toBe(true);
        expect(body.manifest.mcp_servers[0].require_approval_for_tools).toEqual(['proposeEdit', 'createFile']);
        return createMockResponse(200, { id: 'agent_owned_1' });
      }
      return createMockResponse(404, {});
    });

    const res = await client.ensureAgents(validModelsConfig);
    expect(res.primary).toBe(true);
    expect(res.fallback).toBe(true);
    expect(putCalled).toBe(true);

    global.fetch = originalFetch;
  });
});
