/**
 * TrueForge HTTP client, SSE parser, and session/turn lifecycle manager.
 * Single isolation boundary between Forge Agent and TrueForge wire APIs.
 */

import * as path from 'node:path';
import {
  type SetupConfig,
  type ModelsConfig,
  isPlainObject,
  loadCanonicalAgentConfig,
} from './config.ts';

export class ForgeClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeClientError';
  }
}

export class HttpError extends ForgeClientError {
  public readonly status: number;
  public readonly body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    super(message ? `${message} (HTTP ${status}: ${detail})` : `HTTP ${status}: ${detail}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export class NetworkError extends ForgeClientError {
  public readonly code: string;
  public readonly cause: Error;

  constructor(code: string, cause: Error, message?: string) {
    super(message ?? `Network error [${code}]: ${cause.message}`);
    this.name = 'NetworkError';
    this.code = code;
    this.cause = cause;
  }
}

export interface RawEvent {
  id?: string;
  event: string;
  data: unknown;
  rawData: string;
}

export interface ApprovalDecisionItem {
  threadId: string;
  toolCallId: string;
  status: 'allow' | 'deny';
  reason?: string;
}

export interface ContextBlock {
  path: string;
  reason: string;
  range?: { startLine: number; endLine: number };
  text: string;
}

export interface CancelResult {
  ok: boolean;
  status: 'cancelled' | 'already_terminal';
}

export interface SubscribeTurnOptions {
  fromEventId?: string;
  afterEventId?: string;
  signal?: AbortSignal;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
}


interface AgentRecord {
  id?: string;
  name?: string;
  description?: string;
  manifest?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Parses Server-Sent Events stream into RawEvents with UTF-8 byte boundary preservation and immediate abort. */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<RawEvent, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';

  let signalListener: (() => void) | undefined;

  const abortPromise = new Promise<{ done: true; value: undefined }>((resolve) => {
    if (signal) {
      if (signal.aborted) {
        resolve({ done: true, value: undefined });
        reader.cancel().catch(() => {});
      } else {
        signalListener = () => {
          resolve({ done: true, value: undefined });
          reader.cancel().catch(() => {});
        };
        signal.addEventListener('abort', signalListener, { once: true });
      }
    }
  });

  try {
    while (true) {
      if (signal?.aborted) {
        break;
      }

      // Race reader.read() against immediate signal abort so pending reads never hang
      const readResult = await Promise.race([reader.read(), abortPromise]);

      if (readResult.done || signal?.aborted) {
        break;
      }

      buf += decoder.decode(readResult.value, { stream: true });

      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        if (signal?.aborted) {
          break;
        }
        const block = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');

        let event = 'message';
        let id: string | undefined = undefined;
        const dataLines: string[] = [];

        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith(':')) {
            // Ignore SSE comment lines / keepalives
            continue;
          }
          if (line.startsWith('event:')) {
            event = line.slice(6).trim();
          } else if (line.startsWith('id:')) {
            id = line.slice(3).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^ /, ''));
          }
        }

        if (dataLines.length > 0) {
          const rawData = dataLines.join('\n');
          let parsedData: unknown;
          try {
            parsedData = JSON.parse(rawData);
          } catch {
            parsedData = rawData;
          }

          if (!id && isPlainObject(parsedData) && typeof parsedData.id === 'string') {
            id = parsedData.id;
          }

          yield { id, event, data: parsedData, rawData };
          if (signal?.aborted) {
            break;
          }
        }
      }
      if (signal?.aborted) {
        break;
      }
    }

    if (!signal?.aborted) {
      // Flush any remaining characters in decoder buffer
      const finalChunk = decoder.decode();
      if (finalChunk.length > 0) {
        buf += finalChunk;
      }

      if (buf.trim().length > 0) {
        const dataLines: string[] = [];
        let event = 'message';
        let id: string | undefined = undefined;
        for (const line of buf.split(/\r?\n/)) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('id:')) id = line.slice(3).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        if (dataLines.length > 0) {
          const rawData = dataLines.join('\n');
          let parsedData: unknown;
          try {
            parsedData = JSON.parse(rawData);
          } catch {
            parsedData = rawData;
          }
          if (!id && isPlainObject(parsedData) && typeof parsedData.id === 'string') {
            id = parsedData.id;
          }
          yield { id, event, data: parsedData, rawData };
        }
      }
    }
  } finally {
    if (signal && signalListener) {
      signal.removeEventListener('abort', signalListener);
    }
    try {
      await reader.cancel();
    } catch {
      // Reader cancellation error safely ignored on teardown
    }
    reader.releaseLock();
  }
}

type ApprovalCommitState =
  | { status: 'verified'; eventId: string }
  | { status: 'unverified' };

export class ForgeClient {
  private readonly baseUrl: string;
  private readonly config: SetupConfig;
  private readonly committedApprovals = new Map<string, ApprovalCommitState>();

  constructor(config: SetupConfig) {
    this.config = config;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
  }

  private async request(
    method: string,
    urlPath: string,
    body?: unknown,
    options?: { signal?: AbortSignal; headers?: Record<string, string> }
  ): Promise<{ status: number; ok: boolean; data: unknown }> {
    const url = `${this.baseUrl}${urlPath}`;
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...options?.headers,
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: options?.signal,
      });
    } catch (err: unknown) {
      const error = err as Error;
      const code = (error as { code?: string }).code ?? error.name ?? 'NETWORK_ERROR';
      throw new NetworkError(code, error, `Request to ${method} ${urlPath} failed: ${error.message}`);
    }

    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    return { status: res.status, ok: res.ok, data };
  }

  /** Probes TrueForge connectivity via GET /api/v1/models. Never throws. */
  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      try {
        const res = await this.request('GET', '/api/v1/models', undefined, { signal: ctrl.signal });
        if (res.ok) {
          const list = res.data;
          const count = Array.isArray(list)
            ? list.length
            : isPlainObject(list) && Array.isArray(list.data)
            ? list.data.length
            : 'multiple';
          return { ok: true, detail: `Connected to TrueForge at ${this.baseUrl} (${count} models available)` };
        }
        return { ok: false, detail: `TrueForge returned HTTP ${res.status} on connectivity probe` };
      } finally {
        clearTimeout(timer);
      }
    } catch (err: unknown) {
      return { ok: false, detail: `Cannot connect to TrueForge at ${this.baseUrl}: ${(err as Error).message}` };
    }
  }

  /** Idempotently registers or updates the local MCP connector in TrueForge via PUT upsert. */
  async registerMcp(params: { name: string; url: string; token: string }): Promise<{ ok: boolean; reused: boolean }> {
    const manifest = {
      type: 'remote',
      name: params.name,
      description: 'Forge Editor tools (read-only queries + proposal handlers)',
      url: params.url,
      auth: {
        type: 'header',
        headers: { 'x-forge-token': params.token },
      },
    };

    const res = await this.request('PUT', '/api/v1/settings/mcp-servers', { manifest });
    if (res.ok) {
      return { ok: true, reused: true };
    }

    const detail = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    const safeDetail = detail.replace(new RegExp(params.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[REDACTED]');
    throw new HttpError(res.status, safeDetail, `Failed to register MCP server '${params.name}'`);
  }

  /** Idempotently creates or safely updates primary and fallback agents from canonical specs with ownership verification. */
  async ensureAgents(
    modelsConfig?: ModelsConfig,
    options?: { forgeDir?: string; workspaceRoot?: string } | string
  ): Promise<{ primary: boolean; fallback: boolean }> {
    if (!modelsConfig) {
      throw new ForgeClientError('ensureAgents: ModelsConfig is required to configure agents. None was provided.');
    }

    const primaryModelId = modelsConfig.profiles?.primary?.modelId;
    const fallbackModelId = modelsConfig.profiles?.fallback?.modelId;

    if (!primaryModelId || typeof primaryModelId !== 'string' || primaryModelId.trim() === '' || primaryModelId.includes('YOUR_')) {
      throw new ForgeClientError(
        `ensureAgents: Missing or unconfigured primary modelId ('${primaryModelId}'). Valid provider/model ID required in forge/models.local.json.`
      );
    }

    if (!fallbackModelId || typeof fallbackModelId !== 'string' || fallbackModelId.trim() === '' || fallbackModelId.includes('YOUR_')) {
      throw new ForgeClientError(
        `ensureAgents: Missing or unconfigured fallback modelId ('${fallbackModelId}'). Valid provider/model ID required in forge/models.local.json.`
      );
    }

    const workspaceRoot = typeof options === 'string' ? options : options?.workspaceRoot ?? process.cwd();
    const forgeDir = typeof options === 'object' && options.forgeDir ? options.forgeDir : path.resolve(workspaceRoot, 'forge');

    // Load canonical instructions and spec from forge/
    const canonical = loadCanonicalAgentConfig(forgeDir);

    const primaryName = this.config.agents.primary;
    const fallbackName = this.config.agents.fallback;
    const connectorName = this.config.mcp.name;
    const ownershipMarker = '[managed-by:forge-agent]';

    const listRes = await this.request('GET', '/api/v1/agents');
    if (!listRes.ok) {
      throw new HttpError(listRes.status, listRes.data, 'Failed to list agents');
    }

    const listPayload = listRes.data;
    const agentsList: AgentRecord[] = Array.isArray(listPayload)
      ? (listPayload as AgentRecord[])
      : isPlainObject(listPayload) && Array.isArray(listPayload.data)
      ? (listPayload.data as AgentRecord[])
      : [];

    const configureAgent = async (name: string, modelId: string): Promise<boolean> => {
      const existing = agentsList.find((a) => a && a.name === name);

      // Start with canonical spec from forge/agent.spec.json
      const agentSpec: Record<string, unknown> = {
        ...canonical.spec,
        name,
        model: { name: modelId },
        instructions: canonical.instructions,
        mcp_servers: [
          {
            name: connectorName,
            transport: 'http',
            preload: true,
            require_approval_for_tools: ['proposeEdit', 'createFile'],
          },
        ],
      };

      if (!existing) {
        // Create fresh agent
        const createRes = await this.request('POST', '/api/v1/agents', {
          name,
          description: `${ownershipMarker} Forge coding assistant (${name})`,
          manifest: agentSpec,
        });

        if (!createRes.ok) {
          throw new HttpError(createRes.status, createRes.data, `Failed to create agent '${name}'`);
        }
        return true;
      }

      // Existing agent: verify ownership before update
      const agentId = existing.id ?? existing.name ?? name;
      const getRes = await this.request('GET', `/api/v1/agents/${agentId}`);
      if (!getRes.ok) {
        throw new HttpError(getRes.status, getRes.data, `Failed to fetch existing agent '${name}' details`);
      }

      const rawData = getRes.data;
      const fullExisting = isPlainObject(rawData) && isPlainObject(rawData.data)
        ? (rawData.data as AgentRecord)
        : (rawData as AgentRecord);
      const hasOwnership = fullExisting.description?.includes(ownershipMarker);

      if (!hasOwnership) {
        throw new ForgeClientError(
          `Refusing to overwrite existing agent '${name}' (id: ${agentId}): description does not contain ownership marker '${ownershipMarker}'. Setup aborted.`
        );
      }

      // Preserve optional manifest fields while updating model, instructions, and mcp_servers
      const preservedManifest: Record<string, unknown> = {
        ...(fullExisting.manifest ?? {}),
        ...canonical.spec,
        model: { name: modelId },
        instructions: canonical.instructions,
        mcp_servers: [
          {
            name: connectorName,
            transport: 'http',
            preload: true,
            require_approval_for_tools: ['proposeEdit', 'createFile'],
          },
        ],
      };

      const updateRes = await this.request('PUT', `/api/v1/agents/${agentId}`, {
        description: fullExisting.description,
        manifest: preservedManifest,
      });

      if (!updateRes.ok) {
        throw new HttpError(updateRes.status, updateRes.data, `Failed to update agent '${name}'`);
      }
      return true;
    };

    const primaryOk = await configureAgent(primaryName, primaryModelId);
    const fallbackOk = await configureAgent(fallbackName, fallbackModelId);

    return { primary: primaryOk, fallback: fallbackOk };
  }

  /** Creates a new session bound to a named agent. Returns session ID. */
  async createSession(agentName: string): Promise<string> {
    const res = await this.request('POST', '/api/v1/sessions', { agent: { name: agentName } });
    if (!res.ok) {
      throw new HttpError(res.status, res.data, `Failed to create session for agent '${agentName}'`);
    }

    const payload = res.data;
    const id = isPlainObject(payload)
      ? (typeof payload.id === 'string'
          ? payload.id
          : typeof payload.session_id === 'string'
          ? payload.session_id
          : isPlainObject(payload.data) && typeof payload.data.id === 'string'
          ? payload.data.id
          : undefined)
      : undefined;

    if (!id) {
      throw new ForgeClientError(`No session id in response from createSession: ${JSON.stringify(res.data)}`);
    }

    return id;
  }

  /** Starts a turn stream and yields raw SSE frames. Handles chunking, comments, and cancellation. */
  async *createTurn(
    sessionId: string,
    input: unknown[],
    signal?: AbortSignal
  ): AsyncGenerator<RawEvent, void, undefined> {
    const url = `${this.baseUrl}/api/v1/sessions/${sessionId}/turns`;
    let res: Response;

    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify({
          input,
          stream: true,
          previous_turn_id: 'auto',
        }),
        signal,
      });
    } catch (err: unknown) {
      const error = err as Error;
      const code = (error as { code?: string }).code ?? error.name ?? 'NETWORK_ERROR';
      throw new NetworkError(code, error, `createTurn failed: ${error.message}`);
    }

    if (!res.ok) {
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      throw new HttpError(res.status, body, `createTurn failed with HTTP ${res.status}`);
    }

    if (!res.body) {
      throw new ForgeClientError('Response body is null on createTurn stream');
    }

    yield* parseSseStream(res.body, signal);
  }

  /** Submits approval decisions to the active paused turn via /events. Validates HTTP 201 response IDs. */
  async submitApprovals(
    sessionId: string,
    turnId: string,
    approvals: unknown[],
    signal?: AbortSignal
  ): Promise<{ eventIds: string[] }> {
    const uncommitted: Array<Record<string, unknown>> = [];
    const verifiedEventIds: string[] = [];
    const unverifiedToolCallIds: string[] = [];

    for (const item of approvals) {
      if (isPlainObject(item)) {
        const toolCallId = String(item.tool_call_id ?? item.toolCallId ?? '');
        const key = `${sessionId}:${turnId}:${toolCallId}`;
        const state = this.committedApprovals.get(key);
        if (state) {
          if (state.status === 'verified') {
            verifiedEventIds.push(state.eventId);
          } else {
            unverifiedToolCallIds.push(toolCallId);
          }
        } else {
          uncommitted.push(item);
        }
      }
    }

    if (unverifiedToolCallIds.length > 0) {
      throw new ForgeClientError(
        `submitApprovals: Approval for tool call(s) [${unverifiedToolCallIds.join(', ')}] was previously submitted with HTTP 201 but its event ID could not be verified. Resubmission refused; reconciliation required via turn stream/history.`
      );
    }

    if (uncommitted.length === 0) {
      // All approvals were already submitted and verified. Never resubmit!
      return { eventIds: verifiedEventIds };
    }

    const res = await this.request(
      'POST',
      `/api/v1/sessions/${sessionId}/turns/${turnId}/events`,
      { events: uncommitted },
      { signal }
    );

    if (!res.ok) {
      throw new HttpError(res.status, res.data, `submitApprovals failed for turn '${turnId}' with HTTP ${res.status}`);
    }

    const payload = res.data;

    const markAllUncommittedAsUnverified = () => {
      for (const item of uncommitted) {
        const toolCallId = String(item.tool_call_id ?? item.toolCallId ?? '');
        const key = `${sessionId}:${turnId}:${toolCallId}`;
        this.committedApprovals.set(key, { status: 'unverified' });
      }
    };

    // 1. Validate response payload shape
    if (!isPlainObject(payload) || !Array.isArray(payload.data)) {
      markAllUncommittedAsUnverified();
      throw new ForgeClientError(
        `submitApprovals: Server returned HTTP 201 but response payload was malformed (expected { data: [...] }, got ${JSON.stringify(payload)})`
      );
    }

    const dataArray = payload.data;

    // 2. Validate response array length matches submitted count
    if (dataArray.length !== uncommitted.length) {
      markAllUncommittedAsUnverified();
      throw new ForgeClientError(
        `submitApprovals: Server returned HTTP 201 with ${dataArray.length} event(s), but ${uncommitted.length} approval(s) were submitted`
      );
    }

    // 3. Validate every item before committing any verified state
    const validatedNewEventIds: string[] = [];
    for (let i = 0; i < uncommitted.length; i++) {
      const evt = dataArray[i];
      if (!isPlainObject(evt) || typeof evt.id !== 'string' || evt.id.trim().length === 0) {
        markAllUncommittedAsUnverified();
        throw new ForgeClientError(
          `submitApprovals: Server returned HTTP 201 but event at index ${i} is missing a valid 'id' property`
        );
      }
      validatedNewEventIds.push(evt.id);
    }

    // 4. Complete batch is valid: store verified event IDs
    for (let i = 0; i < uncommitted.length; i++) {
      const item = uncommitted[i];
      const toolCallId = String(item.tool_call_id ?? item.toolCallId ?? '');
      const key = `${sessionId}:${turnId}:${toolCallId}`;
      this.committedApprovals.set(key, { status: 'verified', eventId: validatedNewEventIds[i] });
    }

    return { eventIds: [...verifiedEventIds, ...validatedNewEventIds] };
  }

  /** Subscribes to an active turn's SSE stream with cursor resumption, deduplication and bounded reconnection. */
  async *subscribeTurn(
    sessionId: string,
    turnId: string,
    opts?: SubscribeTurnOptions
  ): AsyncGenerator<RawEvent, void, undefined> {
    const seenEventIds = new Set<string>();
    let lastProcessedEventId = opts?.afterEventId;
    let initialFromEventId = opts?.fromEventId;
    let receivedDone = false;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = opts?.maxReconnectAttempts ?? this.config.retry?.max ?? 3;
    const reconnectDelayMs = opts?.reconnectDelayMs ?? 500;

    while (!receivedDone && !opts?.signal?.aborted) {
      const url = new URL(`${this.baseUrl}/api/v1/sessions/${sessionId}/turns/${turnId}/subscribe`);

      // Documented cursor semantics:
      // after_event_id is exclusive (replays events strictly after this id)
      // from_event_id is inclusive (replays starting at this id)
      if (lastProcessedEventId) {
        url.searchParams.set('after_event_id', lastProcessedEventId);
      } else if (initialFromEventId) {
        url.searchParams.set('from_event_id', initialFromEventId);
      }

      let res: Response;
      try {
        res = await fetch(url.toString(), {
          method: 'GET',
          headers: { accept: 'text/event-stream' },
          signal: opts?.signal,
        });
      } catch (err: unknown) {
        if (opts?.signal?.aborted) {
          break;
        }
        if (reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts++;
          await new Promise((r) => setTimeout(r, reconnectDelayMs));
          continue;
        }
        const error = err as Error;
        const code = (error as { code?: string }).code ?? error.name ?? 'NETWORK_ERROR';
        throw new NetworkError(code, error, `subscribeTurn connection failed: ${error.message}`);
      }

      if (!res.ok) {
        const text = await res.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
        throw new HttpError(res.status, body, `subscribeTurn failed with HTTP ${res.status}`);
      }

      if (!res.body) {
        throw new ForgeClientError('Response body is null on subscribeTurn stream');
      }

      try {
        for await (const rawEvent of parseSseStream(res.body, opts?.signal)) {
          // Track and deduplicate replayed events
          if (rawEvent.id) {
            if (seenEventIds.has(rawEvent.id)) {
              // Duplicate event from server replay (e.g. inclusive from_event_id) -> skip
              continue;
            }
            seenEventIds.add(rawEvent.id);
            lastProcessedEventId = rawEvent.id;
            // Once we have processed at least one event, future reconnections use after_event_id
            initialFromEventId = undefined;
          }

          // Terminal event detection: check rawEvent.data.type first, then fall back to rawEvent.event
          const dataType = isPlainObject(rawEvent.data) && typeof rawEvent.data.type === 'string'
            ? rawEvent.data.type
            : undefined;
          const eventType = dataType ?? rawEvent.event;

          if (eventType === 'turn.done') {
            receivedDone = true;
          }

          yield rawEvent;

          if (receivedDone || opts?.signal?.aborted) {
            break;
          }
        }
      } catch (streamErr: unknown) {
        if (opts?.signal?.aborted) {
          break;
        }
        // Stream broke mid-transmission without delivering turn.done: bounded retry
        if (reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts++;
          await new Promise((r) => setTimeout(r, reconnectDelayMs));
          continue;
        }
        const error = streamErr as Error;
        const code = (error as { code?: string }).code ?? error.name ?? 'STREAM_ERROR';
        throw new NetworkError(code, error, `subscribeTurn stream interrupted: ${error.message}`);
      }

      if (receivedDone || opts?.signal?.aborted) {
        break;
      }

      // Stream closed cleanly by server (EOF) without delivering turn.done: bounded retry
      if (!receivedDone && reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        await new Promise((r) => setTimeout(r, reconnectDelayMs));
        continue;
      } else if (!receivedDone) {
        throw new NetworkError('STREAM_DROPPED', new Error('Stream ended prematurely without turn.done after max retries'));
      }
    }
  }

  /** Idempotently cancels the active turn in a session. Never throws on already-terminal states. */
  async cancel(sessionId: string): Promise<CancelResult> {
    try {
      const res = await this.request('POST', `/api/v1/sessions/${sessionId}/cancel`, {});
      if (res.ok) {
        return { ok: true, status: 'cancelled' };
      }
      if (res.status === 404 || res.status === 409) {
        // Session does not exist, or turn is not currently active / already terminal
        return { ok: true, status: 'already_terminal' };
      }
      throw new HttpError(res.status, res.data, `Cancel failed with HTTP ${res.status}`);
    } catch (err: unknown) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 409)) {
        return { ok: true, status: 'already_terminal' };
      }
      throw err;
    }
  }

  /** Pure helper: constructs user message input array with optional formatted context blocks. */
  userMessageInput(text: string, contextBlocks?: ContextBlock[]): unknown[] {
    if (!contextBlocks || contextBlocks.length === 0) {
      return [{ type: 'user.message', content: text }];
    }

    const formattedBlocks = contextBlocks.map((block) => {
      const rangeStr = block.range ? ` (lines ${block.range.startLine}-${block.range.endLine})` : '';
      return `### Context: ${block.path} [${block.reason}]${rangeStr}\n\`\`\`\n${block.text}\n\`\`\``;
    });

    const combinedContent = `${formattedBlocks.join('\n\n')}\n\n### User Request\n${text}`;
    return [{ type: 'user.message', content: combinedContent }];
  }

  /** Pure helper: constructs user.tool_approval items array for /events. */
  approvalsInput(items: ApprovalDecisionItem[]): unknown[] {
    return items.map((item) => ({
      type: 'user.tool_approval',
      thread_id: item.threadId,
      tool_call_id: item.toolCallId,
      approval:
        item.status === 'allow'
          ? { status: 'allow' }
          : { status: 'deny', reason: item.reason ?? 'User rejected changes' },
    }));
  }
}
