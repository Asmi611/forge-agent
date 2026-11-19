/**
 * Comprehensive integration tests for McpToolServer (Milestone E-04).
 *
 * Verifies loopback binding (127.0.0.1), port fallback, constant-time token authentication,
 * strict Host authority validation, HTTP safety (body limits, malformed JSON, content-types),
 * all eight contract v2.1.0 tools (five active read tools and three deferred stubs),
 * concurrent request isolation, and clean lifecycle teardown.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { UiHost } from '../../src/types/contract.ts';
import {
  McpToolServer,
  DEFAULT_MCP_PORT,
  timingSafeTokenCompare,
} from '../../src/mcp/McpToolServer.ts';
import { RunBudget } from '../../src/engine/budget.ts';

interface HttpRequestOptions {
  port: number;
  path?: string;
  method?: string;
  hostHeader?: string | null;
  token?: string;
  contentType?: string;
  accept?: string;
  body?: string;
  extraHeaders?: Record<string, string>;
}

function makeHttpRequest(
  options: HttpRequestOptions
): Promise<{ status: number; text: string; body: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      ...(options.extraHeaders ?? {}),
    };

    if (options.hostHeader !== null) {
      headers['Host'] =
        options.hostHeader !== undefined ? options.hostHeader : `127.0.0.1:${options.port}`;
    }
    if (options.token !== undefined) {
      headers['x-forge-token'] = options.token;
    }
    if (options.contentType !== undefined) {
      headers['Content-Type'] = options.contentType;
    }
    if (options.accept !== undefined) {
      headers['Accept'] = options.accept;
    } else {
      headers['Accept'] = 'application/json, text/event-stream';
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        path: options.path ?? '/mcp',
        method: options.method ?? 'POST',
        headers,
        setHost: options.hostHeader !== null,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({
            status: res.statusCode ?? 0,
            text: raw,
            body: parsed,
          });
        });
      }
    );

    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

describe('McpToolServer HTTP Server & Tool Registry', () => {
  let tempDir: string;
  let workspaceRoot: string;
  let testHost: UiHost;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mcp-server-test-'));
    workspaceRoot = path.join(tempDir, 'workspace');
    fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });

    fs.writeFileSync(path.join(workspaceRoot, 'src', 'index.ts'), 'export const ready = true;\n', 'utf-8');
    fs.writeFileSync(path.join(workspaceRoot, 'README.md'), '# MCP Test Workspace\n', 'utf-8');

    testHost = {
      workspaceRoot,
      isWorkspaceTrusted: () => true,
      context: {
        resolveMention: async () => null,
        seed: async () => [],
        search: async (_q) => ({
          hits: [{ path: 'src/index.ts', line: 1, preview: 'export const ready = true;' }],
          omitted: 0,
        }),
        findSymbol: async (_q) => ({
          symbols: [{ name: 'ready', path: 'src/index.ts', line: 1, kind: 'variable' }],
        }),
        repoMap: async () => ({ tree: 'src/\n  index.ts\nREADME.md', truncated: false }),
      },
      snapshot: async (p) => ({
        path: p,
        exists: true,
        text: '',
        version: 1,
        isDirty: false,
        contentHash: 'hash',
      }),
      readFile: async (p, range) => {
        const full = path.join(workspaceRoot, p);
        const text = fs.readFileSync(full, 'utf-8');
        if (!range) return text;
        const lines = text.split(/\r?\n/);
        return lines.slice(range.startLine - 1, range.endLine).join('\n');
      },
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
  });

  afterAll(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  describe('timingSafeTokenCompare', () => {
    it('compares identical tokens successfully', () => {
      const token = 'abcdef1234567890abcdef1234567890';
      expect(timingSafeTokenCompare(token, token)).toBe(true);
    });

    it('rejects mismatched tokens', () => {
      const tokenA = 'abcdef1234567890abcdef1234567890';
      const tokenB = 'abcdef1234567890abcdef1234567891';
      expect(timingSafeTokenCompare(tokenA, tokenB)).toBe(false);
    });

    it('rejects missing or empty tokens', () => {
      const token = 'abcdef1234567890';
      expect(timingSafeTokenCompare(token, undefined)).toBe(false);
      expect(timingSafeTokenCompare(token, '')).toBe(false);
    });

    it('rejects different length tokens without error', () => {
      expect(timingSafeTokenCompare('short', 'much_longer_token_value')).toBe(false);
    });
  });

  describe('lifecycle, loopback binding and port fallback', () => {
    it('uses DEFAULT_MCP_PORT 8792 as default', () => {
      expect(DEFAULT_MCP_PORT).toBe(8792);
    });

    it('binds strictly to 127.0.0.1 and starts cleanly', async () => {
      const server = new McpToolServer(testHost, { port: 8910 });
      expect(server.isRunning).toBe(false);

      const info = await server.start();
      expect(server.isRunning).toBe(true);
      expect(info.port).toBe(8910);
      expect(info.url).toBe('http://127.0.0.1:8910/mcp');
      expect(info.token).toHaveLength(64);

      await server.stop();
      expect(server.isRunning).toBe(false);
    });

    it('handles multiple stop calls idempotently', async () => {
      const server = new McpToolServer(testHost, { port: 8911 });
      await server.start();
      await server.stop();
      await server.stop(); // Safe, no throw
      expect(server.isRunning).toBe(false);
    });

    it('falls back safely to next free port when default port is occupied', async () => {
      // Occupy target port 8912 with a dummy server
      const blocker = http.createServer((_req, res) => res.end('occupied'));
      await new Promise<void>((resolve) => blocker.listen(8912, '127.0.0.1', () => resolve()));

      const server = new McpToolServer(testHost, { port: 8912 });
      const info = await server.start();

      // Verified fallback to next free port
      expect(info.port).toBe(8913);
      expect(info.url).toBe('http://127.0.0.1:8913/mcp');

      await server.stop();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    });
  });

  describe('HTTP authentication, authority and safety filters', () => {
    let server: McpToolServer;
    let serverPort: number;
    let validToken: string;

    beforeAll(async () => {
      server = new McpToolServer(testHost, { port: 8920 });
      const info = await server.start();
      serverPort = info.port;
      validToken = info.token;
    });

    afterAll(async () => {
      await server.stop();
    });

    it('rejects requests with missing x-forge-token with 401 Unauthorized', async () => {
      const res = await makeHttpRequest({
        port: serverPort,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });

      expect(res.status).toBe(401);
      expect(res.text).toContain('Unauthorized');
    });

    it('rejects requests with invalid x-forge-token with 401 Unauthorized', async () => {
      const res = await makeHttpRequest({
        port: serverPort,
        token: 'wrong-token-value',
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });

      expect(res.status).toBe(401);
    });

    it('rejects external or untrusted Host authorities with 403 Forbidden', async () => {
      // 1. External hostname
      const resEvil = await makeHttpRequest({
        port: serverPort,
        hostHeader: `evil.com:${serverPort}`,
        token: validToken,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(resEvil.status).toBe(403);
      expect(resEvil.text).toContain('Forbidden');

      // 2. Host missing port
      const resNoPort = await makeHttpRequest({
        port: serverPort,
        hostHeader: '127.0.0.1',
        token: validToken,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(resNoPort.status).toBe(403);

      // 3. Host with wrong port
      const resWrongPort = await makeHttpRequest({
        port: serverPort,
        hostHeader: '127.0.0.1:9999',
        token: validToken,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(resWrongPort.status).toBe(403);

      // 4. Missing Host header completely (rejected by RFC 7230 parser with 400 or 403)
      const resNullHost = await makeHttpRequest({
        port: serverPort,
        hostHeader: null,
        token: validToken,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect([400, 403]).toContain(resNullHost.status);
    });

    it('accepts valid Host header authorities: 127.0.0.1:<port> and localhost:<port>', async () => {
      // 1. 127.0.0.1:<port>
      const resIp = await makeHttpRequest({
        port: serverPort,
        hostHeader: `127.0.0.1:${serverPort}`,
        token: validToken,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(resIp.status).toBe(200);

      // 2. localhost:<port>
      const resLocalhost = await makeHttpRequest({
        port: serverPort,
        hostHeader: `localhost:${serverPort}`,
        token: validToken,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });
      expect(resLocalhost.status).toBe(200);
    });

    it('rejects unknown endpoint paths with 404 Not Found', async () => {
      const res = await makeHttpRequest({
        port: serverPort,
        path: '/unknown',
        token: validToken,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(404);
    });

    it('rejects unsupported HTTP methods with 405 Method Not Allowed', async () => {
      const res = await makeHttpRequest({
        port: serverPort,
        method: 'DELETE',
        token: validToken,
      });
      expect(res.status).toBe(405);
    });

    it('rejects POST with missing or non-JSON Content-Type with 415 Unsupported Media Type', async () => {
      const res = await makeHttpRequest({
        port: serverPort,
        token: validToken,
        contentType: 'text/plain',
        body: 'plain text',
      });
      expect(res.status).toBe(415);
    });

    it('rejects malformed JSON payloads with 400 Bad Request', async () => {
      const res = await makeHttpRequest({
        port: serverPort,
        token: validToken,
        contentType: 'application/json',
        body: '{ malformed json: ',
      });
      expect(res.status).toBe(400);
      expect(res.text).toContain('malformed JSON');
    });

    it('rejects request body exceeding MAX_REQUEST_BODY_BYTES with 413 Payload Too Large', async () => {
      const hugeBody = 'x'.repeat(2 * 1024 * 1024 + 1024);
      const res = await makeHttpRequest({
        port: serverPort,
        token: validToken,
        contentType: 'application/json',
        body: hugeBody,
      });
      expect(res.status).toBe(413);
      expect(res.text).toContain('Payload Too Large');
    });
  });

  describe('tool discovery and execution (tools/list & tools/call)', () => {
    let server: McpToolServer;
    let serverPort: number;
    let validToken: string;
    let budget: RunBudget;

    beforeAll(async () => {
      budget = new RunBudget({ configuredRunLimit: 10000 });
      server = new McpToolServer(testHost, { port: 8930, budget });
      const info = await server.start();
      serverPort = info.port;
      validToken = info.token;
    });

    afterAll(async () => {
      await server.stop();
    });

    async function sendMcpPost(payload: unknown): Promise<{ status: number; body: any }> {
      const res = await makeHttpRequest({
        port: serverPort,
        token: validToken,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: res.body };
    }

    it('registers all eight frozen contract tools on tools/list', async () => {
      const { status, body } = await sendMcpPost({
        jsonrpc: '2.0',
        id: 100,
        method: 'tools/list',
      });

      expect(status).toBe(200);
      expect(body.result).toBeDefined();
      expect(Array.isArray(body.result.tools)).toBe(true);

      const toolNames = body.result.tools.map((t: { name: string }) => t.name);
      expect(toolNames).toHaveLength(8);

      // Verify the 5 read tools
      expect(toolNames).toContain('repoMap');
      expect(toolNames).toContain('searchWorkspace');
      expect(toolNames).toContain('findSymbol');
      expect(toolNames).toContain('readFile');
      expect(toolNames).toContain('reportContext');

      // Verify the 3 deferred tools
      expect(toolNames).toContain('proposeEdit');
      expect(toolNames).toContain('createFile');
      expect(toolNames).toContain('runCommand');
    });

    it('executes repoMap tool via tools/call', async () => {
      const { status, body } = await sendMcpPost({
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/call',
        params: {
          name: 'repoMap',
          arguments: {},
        },
      });

      expect(status).toBe(200);
      expect(body.result.content[0].text).toContain('src/');
      expect(body.result.content[0].text).toContain('index.ts');
    });

    it('executes searchWorkspace tool via tools/call', async () => {
      const { status, body } = await sendMcpPost({
        jsonrpc: '2.0',
        id: 102,
        method: 'tools/call',
        params: {
          name: 'searchWorkspace',
          arguments: { query: 'ready' },
        },
      });

      expect(status).toBe(200);
      expect(body.result.content[0].text).toContain('src/index.ts:1:');
    });

    it('executes findSymbol tool via tools/call', async () => {
      const { status, body } = await sendMcpPost({
        jsonrpc: '2.0',
        id: 103,
        method: 'tools/call',
        params: {
          name: 'findSymbol',
          arguments: { name: 'ready' },
        },
      });

      expect(status).toBe(200);
      expect(body.result.content[0].text).toContain('ready (variable) at src/index.ts:1');
    });

    it('executes readFile tool via tools/call', async () => {
      const { status, body } = await sendMcpPost({
        jsonrpc: '2.0',
        id: 104,
        method: 'tools/call',
        params: {
          name: 'readFile',
          arguments: { path: 'src/index.ts' },
        },
      });

      expect(status).toBe(200);
      expect(body.result.content[0].text).toContain('export const ready = true;');
    });

    it('executes reportContext tool via tools/call', async () => {
      const { status, body } = await sendMcpPost({
        jsonrpc: '2.0',
        id: 105,
        method: 'tools/call',
        params: {
          name: 'reportContext',
          arguments: {
            items: [{ path: 'src/index.ts', reason: 'Primary entrypoint' }],
          },
        },
      });

      expect(status).toBe(200);
      expect(body.result.content[0].text).toContain('Context reported: 1 file(s) recorded.');
    });

    it('returns safe deferred stub responses for proposeEdit, createFile and runCommand', async () => {
      // 1. proposeEdit
      const resEdit = await sendMcpPost({
        jsonrpc: '2.0',
        id: 106,
        method: 'tools/call',
        params: {
          name: 'proposeEdit',
          arguments: {
            path: 'src/index.ts',
            edits: [{ oldText: 'true', newText: 'false' }],
            rationale: 'testing stub',
          },
        },
      });
      expect(resEdit.body.result.isError).toBe(true);
      expect(resEdit.body.result.content[0].text).toContain('proposeEdit handler deferred to Milestone E-05');

      // 2. createFile
      const resCreate = await sendMcpPost({
        jsonrpc: '2.0',
        id: 107,
        method: 'tools/call',
        params: {
          name: 'createFile',
          arguments: {
            path: 'src/new.ts',
            content: 'export const x = 1;',
            rationale: 'testing stub',
          },
        },
      });
      expect(resCreate.body.result.isError).toBe(true);
      expect(resCreate.body.result.content[0].text).toContain('createFile handler deferred to Milestone E-05');

      // 3. runCommand
      const resCmd = await sendMcpPost({
        jsonrpc: '2.0',
        id: 108,
        method: 'tools/call',
        params: {
          name: 'runCommand',
          arguments: {
            file: 'git',
            args: ['status'],
          },
        },
      });
      expect(resCmd.body.result.isError).toBe(true);
      expect(resCmd.body.result.content[0].text).toContain('runCommand handler deferred to Milestone E-10');
    });

    it('supports pluggable handlers for future milestones', async () => {
      // Plug custom proposeEdit handler
      server.setProposalHandlers({
        proposeEdit: async (args) => ({
          content: [{ type: 'text', text: `CUSTOM_PROPOSE_EDIT:${args.path}` }],
        }),
      });

      const res = await sendMcpPost({
        jsonrpc: '2.0',
        id: 109,
        method: 'tools/call',
        params: {
          name: 'proposeEdit',
          arguments: {
            path: 'src/index.ts',
            edits: [{ oldText: 'a', newText: 'b' }],
            rationale: 'custom handler test',
          },
        },
      });

      expect(res.body.result.content[0].text).toBe('CUSTOM_PROPOSE_EDIT:src/index.ts');
    });

    it('handles concurrent requests without transport conflicts or race conditions', async () => {
      const concurrentRequests = Array.from({ length: 10 }, (_, i) =>
        sendMcpPost({
          jsonrpc: '2.0',
          id: 200 + i,
          method: 'tools/call',
          params: {
            name: 'findSymbol',
            arguments: { name: `symbol_${i}` },
          },
        })
      );

      const responses = await Promise.all(concurrentRequests);
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body.result).toBeDefined();
        expect(res.body.result.content[0].text).toBeDefined();
      }
    });
  });
});
