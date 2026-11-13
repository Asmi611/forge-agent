// Minimal MCP test server used by the spike (streamable HTTP, bound to 127.0.0.1, requires x-forge-token).
// Tools: echo (no side effect), gated_echo (approval-gated in the agent). Logs EVERYTHING that identifies a call (Q14).
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { MCP_PORT, MCP_TOKEN } from './_lib.mjs';

export const calls = []; // every tools/call the handler really executed

function redact(h) {
  const o = { ...h };
  for (const k of Object.keys(o)) if (/token|authorization|cookie/i.test(k)) o[k] = '[redacted]';
  return o;
}

function build(reqInfo) {
  const server = new McpServer({ name: 'forge-spike', version: '0.0.1' });
  const record = (tool, args, extra) => {
    const entry = {
      at: new Date().toISOString(), tool, args,
      meta: extra && extra._meta ? extra._meta : null,
      extraKeys: extra ? Object.keys(extra) : [],
      requestId: extra && extra.requestId,
      headers: redact(reqInfo.headers),
    };
    calls.push(entry);
    console.log('  [mcp] tools/call executed:', JSON.stringify(entry));
    return entry;
  };
  server.registerTool('echo', {
    description: 'Echo text back. Use when you are asked to test the echo tool.',
    inputSchema: { text: z.string() },
  }, async ({ text }, extra) => { record('echo', { text }, extra); return { content: [{ type: 'text', text: `echo: ${text}` }] }; });
  server.registerTool('gated_echo', {
    description: 'Echo text back (requires human approval). Use when asked to test the gated echo tool.',
    inputSchema: { text: z.string() },
  }, async ({ text }, extra) => { record('gated_echo', { text }, extra); return { content: [{ type: 'text', text: `gated echo: ${text}` }] }; });
  return server;
}

export function startMcpServer() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(async (req, res) => {
      const host = (req.headers.host || '').split(':')[0];
      if (host !== '127.0.0.1' && host !== 'localhost') { res.writeHead(403).end('bad host'); console.log('  [mcp] REJECT bad Host', req.headers.host); return; }
      if (req.headers['x-forge-token'] !== MCP_TOKEN) { res.writeHead(401).end('unauthorized'); console.log('  [mcp] REJECT missing/wrong x-forge-token from', req.socket.remoteAddress); return; }
      let body = '';
      for await (const c of req) body += c;
      let parsed; try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = undefined; }
      if (parsed) console.log('  [mcp] <-', req.method, parsed.method || '(batch)', parsed.params && parsed.params.name ? `tool=${parsed.params.name}` : '', parsed.params && parsed.params._meta ? `_meta=${JSON.stringify(parsed.params._meta)}` : '');
      const server = build(req);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    });
    srv.on('error', reject);
    srv.listen(MCP_PORT, '127.0.0.1', () => { console.log(`  [mcp] listening on http://127.0.0.1:${MCP_PORT}/mcp`); resolve(srv); });
  });
}

// Run standalone: node scripts/spike/mcp-server.mjs
if (process.argv[1] && process.argv[1].endsWith('mcp-server.mjs')) {
  startMcpServer().catch((e) => { console.error(e); process.exit(1); });
}
