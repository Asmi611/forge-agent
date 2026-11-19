/**
 * eventMapper -- maps raw TrueForge wire events to normalized EngineEvents.
 *
 * Isolation boundary: pure functions only, strictly vscode-free.
 * Consumes wire shapes documented in fixtures/events/*.jsonl and docs/02-TRUEFORGE-FACTS.md.
 */

import type { EngineEvent } from '../types/contract.ts';
import {
  DeltaMerger,
  extractSequenceNumber,
  isPlainObject,
} from './deltaMerger.ts';

/**
 * Resolved approval pause information for an internal pending tool call.
 * The engine uses this to snapshot files, compute hunks, and generate FileProposals.
 */
export interface PauseInfo {
  callId: string;
  threadId: string;
  sourceEventId: string;
  toolName: string;
  args: unknown;
}

/**
 * Explicit error condition when an approval event cannot be correlated to a valid tool call.
 */
export interface CorrelationError {
  callId: string;
  sourceEventId: string;
  reason: string;
}

/**
 * Result of mapping a raw TrueForge wire event.
 */
export interface MapEventResult {
  /** Events strictly conforming to the frozen contract v2.1.0 */
  events: EngineEvent[];
  /** Newly detected approval pauses from this specific raw event */
  newPauses: PauseInfo[];
  /** Explicit sequence gap condition if a gap is detected at a message/stream boundary */
  gap?: { expected: number; received: number };
  /** Explicit unresolved correlation errors when approval items cannot be validated */
  unresolvedPauses?: CorrelationError[];
}

/**
 * Turn-stream sequence tracker managing monotonic ordering and duplicate rejection across a turn stream.
 */
export class SequenceTracker {
  private expectedSeq: number | undefined = undefined;
  private readonly seenSeqNumbers = new Set<number>();
  private readonly pendingBuffer = new Map<number, unknown>();

  /**
   * Resets sequence tracking for a new turn stream without clearing cumulative pauses or cached message definitions.
   */
  public resetTurnStream(): void {
    this.expectedSeq = undefined;
    this.seenSeqNumbers.clear();
    this.pendingBuffer.clear();
  }

  /**
   * Recovers from an unresolvable sequence gap at a completion boundary.
   * Advances expectedSeq past the highest received sequence number so the tracker
   * does not remain stuck buffering forever, while dropping late-arriving stale events.
   */
  public recoverFromGap(): { expected: number; received: number } | undefined {
    if (this.expectedSeq !== undefined && this.pendingBuffer.size > 0) {
      const highest = Math.max(...this.pendingBuffer.keys());
      const gap = { expected: this.expectedSeq, received: highest };
      this.expectedSeq = highest + 1;
      this.pendingBuffer.clear();
      return gap;
    }
    return undefined;
  }

  /**
   * Filters and orders an incoming raw event based on turn-stream sequence numbers.
   */
  public process(raw: unknown): {
    action: 'process' | 'duplicate' | 'buffer';
    bufferedEvents?: unknown[];
    seq?: number;
  } {
    const seq = extractSequenceNumber(raw);
    if (seq === undefined) {
      // Unsequenced event: preserve arrival order immediately
      return { action: 'process' };
    }

    if (this.expectedSeq === undefined) {
      this.expectedSeq = seq;
    }

    if (this.seenSeqNumbers.has(seq) || seq < this.expectedSeq) {
      return { action: 'duplicate', seq };
    }

    this.seenSeqNumbers.add(seq);

    if (seq > this.expectedSeq) {
      this.pendingBuffer.set(seq, raw);
      return { action: 'buffer', seq };
    }

    // seq === this.expectedSeq
    this.expectedSeq++;

    const drained: unknown[] = [];
    while (this.pendingBuffer.has(this.expectedSeq)) {
      const next = this.pendingBuffer.get(this.expectedSeq)!;
      this.pendingBuffer.delete(this.expectedSeq);
      this.expectedSeq++;
      drained.push(next);
    }

    return { action: 'process', bufferedEvents: drained, seq };
  }
}

/**
 * State object holding DeltaMerger, SequenceTracker, and cumulative turn pause state.
 */
export interface EventMapperState {
  deltaMerger: DeltaMerger;
  sequenceTracker: SequenceTracker;
  /** Cumulative unconsumed pauses in the active turn */
  pauses: PauseInfo[];
  /** Atomically returns and drains all cumulative unconsumed pauses */
  consumePauses(): PauseInfo[];
  /** Resets turn-stream sequence tracking for a subsequent turn without clearing unconsumed pauses */
  resetTurnStream(): void;
  /** Checks for unresolved sequence gaps at completion boundaries and recovers safely */
  checkUnresolvedGap(): { expected: number; received: number } | undefined;
}

/**
 * Factory for creating fresh EventMapperState.
 */
export function createEventMapperState(deltaMerger?: DeltaMerger): EventMapperState {
  const merger = deltaMerger ?? new DeltaMerger();
  const sequenceTracker = new SequenceTracker();
  const pauses: PauseInfo[] = [];

  return {
    deltaMerger: merger,
    sequenceTracker,
    pauses,
    consumePauses(): PauseInfo[] {
      const drained = [...pauses];
      pauses.length = 0;
      return drained;
    },
    resetTurnStream(): void {
      sequenceTracker.resetTurnStream();
    },
    checkUnresolvedGap(): { expected: number; received: number } | undefined {
      const gap = sequenceTracker.recoverFromGap();
      if (gap) {
        merger.invalidateUnfinished();
      }
      return gap;
    },
  };
}

/**
 * Infers execution success (ok) and human-readable summary from a tool.response payload.
 */
export function inferToolResult(
  toolCallId: string,
  content: unknown,
  explicitOk?: boolean
): { ok: boolean; summary: string } {
  if (explicitOk !== undefined) {
    return {
      ok: explicitOk,
      summary: typeof content === 'string' ? content : JSON.stringify(content ?? ''),
    };
  }

  // If content is a string, check for JSON error structures (such as TrueForge synthetic denials)
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isPlainObject(parsed)) {
          // Check for error property or isError flag
          if (parsed.error !== undefined || parsed.isError === true) {
            let errorText = '';
            if (Array.isArray(parsed.error)) {
              for (const item of parsed.error) {
                if (isPlainObject(item) && typeof item.text === 'string') {
                  try {
                    const nested = JSON.parse(item.text) as unknown;
                    if (isPlainObject(nested) && typeof nested.error === 'string') {
                      errorText = nested.error;
                      break;
                    }
                  } catch {
                    errorText = item.text;
                    break;
                  }
                }
              }
            } else if (typeof parsed.error === 'string') {
              errorText = parsed.error;
            }
            return {
              ok: false,
              summary: errorText.length > 0 ? errorText : trimmed.slice(0, 500),
            };
          }
        }
      } catch {
        // Not valid JSON, proceed to string inspection
      }
    }

    if (trimmed.startsWith('Error:') || trimmed.startsWith('error:')) {
      return { ok: false, summary: trimmed.slice(0, 500) };
    }

    return { ok: true, summary: trimmed.slice(0, 500) };
  }

  if (isPlainObject(content)) {
    if (content.error !== undefined || content.isError === true) {
      const summary = typeof content.error === 'string' ? content.error : JSON.stringify(content);
      return { ok: false, summary: summary.slice(0, 500) };
    }
    return { ok: true, summary: JSON.stringify(content).slice(0, 500) };
  }

  return { ok: true, summary: String(content ?? toolCallId).slice(0, 500) };
}

/**
 * Maps a single raw TrueForge wire event to normalized EngineEvents and newly detected PauseInfos.
 * Covers turn-stream sequencing, deduplication, out-of-order buffering, and gap invalidation.
 * Never throws on unknown, malformed, or out-of-order events.
 */
export function mapRawEvent(raw: unknown, state: EventMapperState): MapEventResult {
  if (!isPlainObject(raw)) {
    return { events: [], newPauses: [] };
  }

  try {
    const rawData = isPlainObject(raw.data) ? raw.data : isPlainObject(raw) ? raw : null;
    if (!rawData) {
      return { events: [], newPauses: [] };
    }

    const type = typeof rawData.type === 'string' ? rawData.type : undefined;
    const hasFinishReason =
      (typeof rawData.finish_reason === 'string' && rawData.finish_reason.length > 0) ||
      (typeof rawData.finishReason === 'string' && rawData.finishReason.length > 0);

    // Starting a new turn resets sequence tracking before tracking turn.created's own sequence
    if (type === 'turn.created') {
      state.resetTurnStream();
    }

    // Process turn-stream sequencing across all event types
    const seqResult = state.sequenceTracker.process(raw);

    if (seqResult.action === 'duplicate') {
      return { events: [], newPauses: [] };
    }

    if (seqResult.action === 'buffer') {
      // Automatic finish-boundary gap recovery:
      // If an out-of-order buffered event is a completion boundary (finish_reason or turn.done),
      // apply safe gap recovery policy automatically and invalidate unfinished messages/calls.
      if (hasFinishReason || type === 'turn.done') {
        const gap = state.sequenceTracker.recoverFromGap();
        if (gap) {
          state.deltaMerger.invalidateUnfinished();
          if (type === 'turn.done') {
            state.resetTurnStream();
          }
          return { events: [], newPauses: [], gap };
        }
      }
      return { events: [], newPauses: [] };
    }

    // In-order event processing: run through lifecycle-aware executor
    const combinedResult: MapEventResult = { events: [], newPauses: [] };

    executeInOrderEvent(rawData, state, combinedResult);

    // If buffered events were drained, execute each one in sequence order through the same lifecycle pipeline
    if (seqResult.bufferedEvents && seqResult.bufferedEvents.length > 0) {
      for (const buffered of seqResult.bufferedEvents) {
        if (!isPlainObject(buffered)) continue;
        const bData = isPlainObject(buffered.data) ? buffered.data : buffered;
        executeInOrderEvent(bData, state, combinedResult);
      }
    }

    return combinedResult;
  } catch {
    // Streams never throw
    return { events: [], newPauses: [] };
  }
}

/**
 * Executes an in-order wire event and applies its lifecycle hooks consistently
 * whether the event was directly received or drained from the sequence buffer.
 */
function executeInOrderEvent(
  rawData: Record<string, unknown>,
  state: EventMapperState,
  combinedResult: MapEventResult
): void {
  const type = typeof rawData.type === 'string' ? rawData.type : undefined;
  const hasFinishReason =
    typeof rawData.finish_reason === 'string' && rawData.finish_reason.length > 0;

  // Process the single event
  const result = mapSingleEvent(rawData, state);
  combinedResult.events.push(...result.events);
  combinedResult.newPauses.push(...result.newPauses);
  if (result.unresolvedPauses) {
    combinedResult.unresolvedPauses = [
      ...(combinedResult.unresolvedPauses ?? []),
      ...result.unresolvedPauses,
    ];
  }

  // Lifecycle check for finish boundary gap if pending buffer still has unresolved items
  if (hasFinishReason || type === 'turn.done') {
    const gap = state.checkUnresolvedGap();
    if (gap) {
      combinedResult.gap = gap;
    }
  }

  // Lifecycle hook for turn.done: resets turn stream for subsequent turn
  if (type === 'turn.done') {
    state.resetTurnStream();
  }
}

/**
 * Internal processor for an individual sequenced/in-order wire event.
 */
function mapSingleEvent(rawData: Record<string, unknown>, state: EventMapperState): MapEventResult {
  const type = typeof rawData.type === 'string' ? rawData.type : undefined;
  if (!type) {
    return { events: [], newPauses: [] };
  }

  switch (type) {
    case 'model.message': {
      state.deltaMerger.processBaseMessage(rawData);
      return { events: [], newPauses: [] };
    }

    case 'model.message.delta': {
      const mergeResult = state.deltaMerger.mergeDelta(rawData);
      const events: EngineEvent[] = [];

      if (mergeResult.textChunk && mergeResult.textChunk.length > 0) {
        events.push({
          type: 'token',
          text: mergeResult.textChunk,
        });
      }

      for (const toolCall of mergeResult.newlyFinalizedToolCalls) {
        events.push({
          type: 'tool.call',
          callId: toolCall.id,
          tool: toolCall.name,
          args: toolCall.parsedArgs ?? {},
          thread: mergeResult.message.threadId || 'main',
        });
      }

      return { events, newPauses: [] };
    }

    case 'tool.response': {
      const toolCallId = String(rawData.tool_call_id ?? rawData.toolCallId ?? '');
      const content = rawData.content;
      const explicitOk = typeof rawData.ok === 'boolean' ? rawData.ok : undefined;
      const { ok, summary } = inferToolResult(toolCallId, content, explicitOk);

      return {
        events: [
          {
            type: 'tool.result',
            callId: toolCallId,
            ok,
            summary,
          },
        ],
        newPauses: [],
      };
    }

    case 'tool.approval_required': {
      const threadId = String(rawData.thread_id ?? rawData.threadId ?? 'main');
      const rawToolCalls = rawData.tool_calls ?? rawData.toolCalls;
      const newPauses: PauseInfo[] = [];
      const unresolvedPauses: CorrelationError[] = [];

      if (Array.isArray(rawToolCalls)) {
        for (const item of rawToolCalls) {
          if (!isPlainObject(item)) continue;
          const callId = String(item.id ?? '').trim();
          const sourceEventId = String(item.source_event_id ?? item.sourceEventId ?? '').trim();

          if (!callId || !sourceEventId) {
            unresolvedPauses.push({
              callId: callId || 'missing',
              sourceEventId: sourceEventId || 'missing',
              reason: 'Missing callId or sourceEventId in approval payload',
            });
            continue;
          }

          const msg = state.deltaMerger.getMessage(sourceEventId);
          if (!msg) {
            unresolvedPauses.push({
              callId,
              sourceEventId,
              reason: `Source message '${sourceEventId}' not found in assembled state`,
            });
            continue;
          }

          const resolvedCall = state.deltaMerger.getToolCall(sourceEventId, callId);
          if (!resolvedCall) {
            unresolvedPauses.push({
              callId,
              sourceEventId,
              reason: `Tool call '${callId}' not found in source message '${sourceEventId}'`,
            });
            continue;
          }

          if (!resolvedCall.name || resolvedCall.name.trim() === '') {
            unresolvedPauses.push({
              callId,
              sourceEventId,
              reason: `Tool call '${callId}' has missing or empty tool name`,
            });
            continue;
          }

          if (resolvedCall.isCorrupted || resolvedCall.parsedArgs === undefined) {
            unresolvedPauses.push({
              callId,
              sourceEventId,
              reason: `Tool call '${callId}' has corrupted or incomplete arguments`,
            });
            continue;
          }

          // Full validation passed: create verified PauseInfo
          const pause: PauseInfo = {
            callId,
            threadId,
            sourceEventId,
            toolName: resolvedCall.name,
            args: resolvedCall.parsedArgs,
          };

          state.pauses.push(pause);
          newPauses.push(pause);
        }
      }

      return {
        events: [],
        newPauses,
        ...(unresolvedPauses.length > 0 ? { unresolvedPauses } : {}),
      };
    }

    case 'thread.created': {
      const threadId = String(rawData.thread_id ?? rawData.threadId ?? rawData.id ?? '');
      const rawLabel = rawData.label ?? rawData.name ?? rawData.title;
      const label = typeof rawLabel === 'string' ? rawLabel : undefined;

      const event: EngineEvent = {
        type: 'subagent',
        threadId,
        state: 'started',
        ...(label ? { label } : {}),
      };

      return { events: [event], newPauses: [] };
    }

    case 'thread.done': {
      const threadId = String(rawData.thread_id ?? rawData.threadId ?? rawData.id ?? '');
      return {
        events: [
          {
            type: 'subagent',
            threadId,
            state: 'done',
          },
        ],
        newPauses: [],
      };
    }

    // Explicitly recognized wire events that emit no direct UI events
    case 'turn.created':
    case 'turn.update':
    case 'user.tool_approval':
    case 'mcp.initialize':
    case 'turn.done':
    default:
      return { events: [], newPauses: [] };
  }
}

/**
 * Terminal turn outcome representations.
 */
export type TerminalOutcome =
  | { status: 'done'; outcome: 'done'; output?: unknown; requiredActions?: unknown[] }
  | { status: 'cancelled'; outcome: 'cancelled'; reason?: string }
  | { status: 'error'; outcome: 'error'; message: string }
  | { status: 'paused'; outcome: 'paused'; requiredActions: unknown[] }
  | { status: 'non_terminal'; outcome: 'non_terminal'; currentStatus?: string; reason?: string };

export type TerminalResult = TerminalOutcome;

/**
 * Maps a TrueForge turn state payload to a normalized TerminalResult.
 *
 * Rules:
 * 1. Paused status or active action_required_on_events takes precedence over done.
 * 2. Finished turn with required_actions remains 'done', carrying requiredActions.
 * 3. Never defaults running, unknown, or malformed states to done.
 * 4. Only positively established completion returns 'done'.
 */
export function mapTerminal(input: unknown): TerminalResult {
  if (!isPlainObject(input)) {
    return { status: 'non_terminal', outcome: 'non_terminal' };
  }

  const rawData = isPlainObject(input.data) ? input.data : input;
  const stateObj = isPlainObject(rawData.state) ? rawData.state : rawData;
  const status = typeof stateObj.status === 'string' ? stateObj.status : undefined;

  // 1. Check for paused condition: explicit status or active paused events (Fact F18)
  const pausedActions = stateObj.action_required_on_events ?? stateObj.actionRequiredOnEvents;
  const hasPausedActions = Array.isArray(pausedActions) && pausedActions.length > 0;

  if (status === 'paused' || hasPausedActions) {
    const actions = (hasPausedActions
      ? pausedActions
      : Array.isArray(stateObj.required_actions)
      ? stateObj.required_actions
      : Array.isArray(stateObj.requiredActions)
      ? stateObj.requiredActions
      : []) as unknown[];

    return {
      status: 'paused',
      outcome: 'paused',
      requiredActions: actions,
    };
  }

  // 2. Check for explicit cancellation
  if (status === 'cancelled') {
    const reason = typeof stateObj.reason === 'string' ? stateObj.reason : undefined;
    return {
      status: 'cancelled',
      outcome: 'cancelled',
      ...(reason ? { reason } : {}),
    };
  }

  // 3. Check for explicit error
  if (status === 'error' || typeof stateObj.message === 'string' || typeof stateObj.error === 'string') {
    const message = String(stateObj.message ?? stateObj.error ?? 'Unknown error');
    return {
      status: 'error',
      outcome: 'error',
      message,
    };
  }

  // 4. Positively established done status
  if (status === 'done') {
    const actions = (Array.isArray(stateObj.required_actions)
      ? stateObj.required_actions
      : Array.isArray(stateObj.requiredActions)
      ? stateObj.requiredActions
      : []) as unknown[];

    return {
      status: 'done',
      outcome: 'done',
      output: stateObj.output,
      requiredActions: actions,
    };
  }

  // 5. Non-terminal: running, starting, pending, unknown status, or missing status
  return {
    status: 'non_terminal',
    outcome: 'non_terminal',
    ...(status ? { currentStatus: status, reason: 'in_progress_or_unrecognized' } : {}),
  };
}
