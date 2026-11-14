// Shared helpers for the S-02 spike. Plain ESM (no build step): node scripts/spike/<file>.mjs
// Raw HTTP on purpose (no SDK): the spike must show what is really on the wire.
import fs from 'node:fs';
import path from 'node:path';

export const BASE = (process.env.TF_BASE || 'http://localhost:8790').replace(/\/$/, '');
export const MCP_PORT = Number(process.env.MCP_PORT || 8792);
export const MCP_TOKEN = process.env.MCP_TOKEN || 'spike-token-123'; // throw-away value, not a real secret
export const MCP_URL = process.env.MCP_URL || `http://127.0.0.1:${MCP_PORT}/mcp`;
export const FIXTURE_DIR = path.resolve(process.cwd(), 'fixtures', 'events');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Subscribe to the live SSE stream of an existing turn.
// The turn stays open while awaiting the human decision; resume with from_event_id
// or after_event_id to avoid replaying events that already arrived.
// One subscription only: subscribeTurnEvents() is awaited exactly once. The returned
// object owns a mutable `diagnostics` object that the async generator mutates when the
// reader reports done:true (normal closure) or throws (error). The observer reads
// diagnostics from that same object after its for-await loop finishes.
export async function subscribeTurnEvents(sessionId, turnId, { fromEventId } = {}) {
  const url = new URL(BASE + `/api/v1/sessions/${sessionId}/turns/${turnId}/subscribe`);
  if (fromEventId) url.searchParams.set('from_event_id', fromEventId);
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { accept: 'text/event-stream' },
  });
  if (!res.ok) {
    const t = await res.text();
    const err = new Error(`subscribe turn ${turnId} -> HTTP ${res.status}: ${t}`);
    err.status = res.status; err.body = t;
    throw err;
  }
  // SSE: return a reader-like async generator that yields parsed {event, data, rawData}.
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  const reader = res.body.getReader();
  const diagnostics = {
    readEndedNormally: false,
    readEndedWithData: false,
    readError: null,
    bufferedAfterRead: null,
  };
  return {
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            diagnostics.readEndedNormally = true;
            diagnostics.readEndedWithData = buf.length > 0;
            diagnostics.bufferedAfterRead = buf;
            break;
          }
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
            let event = 'message';
            const dataLines = [];
            for (const line of block.split(/\r?\n/)) {
              if (line.startsWith(':')) continue;
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
              if (!dataLines.length) continue;
            }
            if (dataLines.length) {
              const rawData = dataLines.join('\n');
              let data;
              try { data = JSON.parse(rawData); } catch (e) { data = rawData; }
              yield { event, data, rawData };
            }
          }
        }
      } catch (e) {
        diagnostics.readError = e;
        diagnostics.bufferedAfterRead = buf;
        const err = !buf.includes('__stream_closed') ? { event: '__stream_error', data: String(e), rawData: String(e), buffered: buf } : null;
        if (err) yield err;
      }
    },
    diagnostics,
  };
}

export function streamCount(buffer) {
  return buffer.split(/\r?\n\r?\n/).filter((b) => b.length > 0).length;
}

export async function api(method, urlPath, body, { allowFail = false, signal } = {}) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok && !allowFail) {
    throw new Error(`${method} ${urlPath} -> HTTP ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`);
  }
  return { status: res.status, ok: res.ok, json, data: (json && typeof json === 'object' && 'data' in json) ? json.data : json };
}

// POST /api/v1/sessions/{sessionId}/turns/{turnId}/events
// Body: { events: [ { type: 'user.tool_approval', thread_id, tool_call_id, approval } ] }
export async function submitApprovalEvent(sessionId, turnId, threadId, toolCallId, approval, { signal } = {}) {
  const res = await fetch(BASE + `/api/v1/sessions/${sessionId}/turns/${turnId}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ events: [{ type: 'user.tool_approval', thread_id: threadId, tool_call_id: toolCallId, approval }] }),
    signal,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    throw new Error(`submit approval event -> HTTP ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`);
  }
  return { status: res.status, ok: res.ok, json, data: (json && typeof json === 'object' && 'data' in json) ? json.data : json };
}

// saveFixture() never overwrites an existing fixture: it checks existence before writing.
// The resume fixtures are distinct artifacts (SSE-observed, API history, turn 1) and must
// not clobber each other or the pre-recorded turn 1 fixture.
export function saveFixture(name, lines) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const file = path.join(FIXTURE_DIR, name);
  if (fs.existsSync(file)) {
    console.warn(`  [fixture SKIPPED] ${path.relative(process.cwd(), file)} already exists (not overwritten)`);
    return;
  }
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  console.log(`  [fixture saved] ${path.relative(process.cwd(), file)} (${lines.length} lines)`);
}

// POST /api/v1/sessions/{id}/turns with stream:true -> SSE. Returns every raw frame.
// opts.onEvent(evt, frames) may return 'stop' to abort the stream early (used by the cancel test).
export async function streamTurn(sessionId, body, opts = {}) {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/v1/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ ...body, stream: true }),
    signal: ctrl.signal,
  });
  const frames = []; // {event, data, rawData}
  if (!res.ok) {
    const t = await res.text();
    const err = new Error(`create-turn -> HTTP ${res.status}: ${t}`);
    err.status = res.status; err.body = t;
    throw err;
  }
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let stopped = false;
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
        let event = 'message';
        const dataLines = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        if (dataLines.length) {
          const rawData = dataLines.join('\n');
          let data;
          try { data = JSON.parse(rawData); } catch { data = rawData; }
          const frame = { event, data, rawData };
          frames.push(frame);
          if (opts.onEvent && opts.onEvent(frame, frames) === 'stop') {
            stopped = true;
            ctrl.abort();
            break;
          }
        }
        if (stopped) break;
      }
    }
  } catch (e) {
    if (!stopped) { frames.push({ event: '__stream_error', data: String(e), rawData: String(e), buffered: buf }); }
  }
  return frames;
}

export function streamClosedNormally(readerValue) {
  return readerValue && readerValue.done === true;
}

export const fixtureLines = (frames) => frames.map((f) => JSON.stringify({ event: f.event, data: f.data }));
export const typeOf = (f) => (f.data && f.data.type) || f.event;
export function summarize(frames) {
  const counts = {};
  for (const f of frames) counts[typeOf(f)] = (counts[typeOf(f)] || 0) + 1;
  return counts;
}
export function findDone(frames) { return frames.find((f) => typeOf(f) === 'turn.done'); }
export function findApproval(frames) { return frames.find((f) => typeOf(f) === 'tool.approval_required'); }
export function turnIdOf(frames) {
  const c = frames.find((f) => typeOf(f) === 'turn.created');
  return c && c.data && (c.data.turn_id || c.data.turnId || (c.data.turn && c.data.turn.id));
}

export async function pickModel() {
  if (process.env.TF_MODEL) return process.env.TF_MODEL;
  const r = await api('GET', '/api/v1/models', undefined, { allowFail: true });
  console.log('GET /api/v1/models ->', r.status, JSON.stringify(r.json).slice(0, 1500));
  console.log('\nSet the model and re-run, e.g. (PowerShell):  $env:TF_MODEL="<model name from the list above>"');
  process.exit(2);
}

// Create-or-replace an agent by name. manifest = AgentSpec (snake_case on the wire).
export async function upsertAgent(name, manifest, description = 'forge spike agent') {
  const body = { name, description, manifest };
  let r = await api('POST', '/api/v1/agents', body, { allowFail: true });
  if (r.status === 409 || (!r.ok && JSON.stringify(r.json).toLowerCase().includes('exist'))) {
    // find id then update
    const list = await api('GET', '/api/v1/agents');
    const listData = list.data;
    const items = Array.isArray(listData) ? listData : (listData && listData.items ? listData.items : []);
    const found = items.find((a) => a.name === name);
    if (!found) throw new Error('agent exists but not found in list: ' + JSON.stringify(listData).slice(0, 500));
    r = await api('PUT', `/api/v1/agents/${found.id || found.agent_id || name}`, { description, manifest }, { allowFail: true });
    if (!r.ok) r = await api('PATCH', `/api/v1/agents/${found.id || found.agent_id || name}`, { description, manifest });
  } else if (!r.ok) {
    throw new Error(`create agent failed HTTP ${r.status}: ${JSON.stringify(r.json)}`);
  }
  return r.data;
}

export async function registerMcp(name, url, token) {
  const manifest = {
    type: 'remote', name, description: 'forge spike echo tools', url,
    auth: { type: 'header', headers: { 'x-forge-token': token } },
  };
  let r = await api('POST', '/api/v1/settings/mcp-servers', { manifest }, { allowFail: true });
  if (r.ok) {
    return { ...r, reused: false };
  }
  if (r.status !== 409) {
    throw new Error(`register MCP failed. create: HTTP ${r.status} ${JSON.stringify(r.json)}`);
  }
  const list = await api('GET', '/api/v1/settings/mcp-servers');
  const existing = Array.isArray(list.data) ? list.data.find((s) => s && s.name === name) : undefined;
  if (!existing) {
    throw new Error(`register MCP: name '${name}' is taken but no matching registration found in the existing list`);
  }
  const sameName = existing.name === name;
  const sameUrl = existing?.manifest?.url === url;
  const sameAuthType = existing?.manifest?.auth?.type === 'header';
  const expectedHeaderKey = existing?.manifest?.auth?.headers?.['x-forge-token'];
  const headerKeyPresent = expectedHeaderKey !== undefined && expectedHeaderKey !== null && String(expectedHeaderKey).length > 0;
  if (sameName && sameUrl && sameAuthType && headerKeyPresent) {
    return { ...r, reused: true, existing, tokenVerified: false };
  }
  throw new Error(`register MCP: existing '${name}' differs from the requested configuration (name match: ${sameName}, url match: ${sameUrl}, auth type match: ${sameAuthType}). Reuse is not safe; no update/delete performed.`);
}

export async function newSession(agentName) {
  const r = await api('POST', '/api/v1/sessions', { agent: { name: agentName } });
  const d = r.data;
  const id = d && (d.id || d.session_id || (d.session && d.session.id));
  if (!id) throw new Error('no session id in response: ' + JSON.stringify(r.json));
  return { id, raw: r.json };
}
