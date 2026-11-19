/**
 * DeltaMerger -- pure logic for assembling TrueForge streamed deltas.
 *
 * Responsibilities:
 * - Keeps a map of id -> assembled model.message.
 * - Merges model.message.delta fragments (text content and tool-call chunks).
 * - Concatenates partial JSON argument fragments without acting on them prematurely.
 * - Finalizes and exposes tool calls strictly when a completion signal (finish_reason)
 *   is present AND id, name, and parsed arguments are valid.
 * - Guarantees each finalized tool call is emitted exactly once.
 * - Supports explicit invalidation of unfinished messages/tool calls on stream gaps.
 */

export interface AssembledToolCall {
  index: number;
  id: string;
  name: string;
  rawArguments: string;
  parsedArgs?: unknown;
  toolInfo?: unknown;
  emitted: boolean;
  isCorrupted: boolean;
}

export interface AssembledMessage {
  id: string;
  threadId: string;
  content: string;
  toolCalls: Map<number, AssembledToolCall>;
  finishReason?: string;
  usage?: unknown;
  model?: unknown;
  isCorrupted: boolean;
}

export interface MergeDeltaResult {
  message: AssembledMessage;
  newlyFinalizedToolCalls: AssembledToolCall[];
  textChunk?: string;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extracts sequence number from event or data payload, if present.
 */
export function extractSequenceNumber(raw: unknown): number | undefined {
  if (!isPlainObject(raw)) return undefined;
  const direct = raw.sequence_number ?? raw.sequenceNumber;
  if (typeof direct === 'number') return direct;
  if (isPlainObject(raw.data)) {
    const dataSeq = raw.data.sequence_number ?? raw.data.sequenceNumber;
    if (typeof dataSeq === 'number') return dataSeq;
  }
  return undefined;
}

export class DeltaMerger {
  private readonly messages = new Map<string, AssembledMessage>();

  /**
   * Resets all assembled message state (e.g. between runs or on session failover).
   */
  public reset(): void {
    this.messages.clear();
  }

  /**
   * Looks up an assembled message by its TrueForge message ID.
   */
  public getMessage(id: string): AssembledMessage | undefined {
    return this.messages.get(id);
  }

  /**
   * Looks up a specific tool call within an assembled message by message ID and tool_call_id.
   */
  public getToolCall(messageId: string, callId: string): AssembledToolCall | undefined {
    const msg = this.messages.get(messageId);
    if (!msg) return undefined;
    for (const toolCall of msg.toolCalls.values()) {
      if (toolCall.id === callId) {
        return toolCall;
      }
    }
    return undefined;
  }

  /**
   * Invalidates all unfinished messages and un-emitted tool calls.
   * Every un-emitted tool call is marked isCorrupted = true regardless of message finishReason.
   * Already-emitted (finalized) tool calls are preserved.
   */
  public invalidateUnfinished(): void {
    for (const msg of this.messages.values()) {
      if (!msg.finishReason) {
        msg.isCorrupted = true;
      }
      for (const tc of msg.toolCalls.values()) {
        if (!tc.emitted) {
          tc.isCorrupted = true;
        }
      }
    }
  }

  /**
   * Processes a base `model.message` event, anchoring the message in state.
   */
  public processBaseMessage(raw: Record<string, unknown>): AssembledMessage {
    const id = String(raw.id ?? '');
    const threadId = String(raw.thread_id ?? raw.threadId ?? 'main');
    let existing = this.messages.get(id);
    if (!existing) {
      existing = {
        id,
        threadId,
        content: typeof raw.content === 'string' ? raw.content : '',
        toolCalls: new Map<number, AssembledToolCall>(),
        finishReason: typeof raw.finish_reason === 'string' ? raw.finish_reason : undefined,
        usage: raw.usage,
        model: raw.model,
        isCorrupted: false,
      };
      this.messages.set(id, existing);
    } else {
      if (raw.thread_id || raw.threadId) {
        existing.threadId = threadId;
      }
      if (raw.model) existing.model = raw.model;
      if (raw.usage) existing.usage = raw.usage;
    }
    return existing;
  }

  /**
   * Ingests a verified in-order `model.message.delta` wire payload, handling
   * argument accumulation and completion-gated finalization.
   */
  public mergeDelta(raw: Record<string, unknown>): MergeDeltaResult {
    const id = String(raw.id ?? '');
    const threadId = String(raw.thread_id ?? raw.threadId ?? 'main');
    const message = this.getOrCreateMessage(id, threadId);

    let textChunk: string | undefined = undefined;

    // 1. Text fragment accumulation
    if (typeof raw.content === 'string' && raw.content.length > 0) {
      textChunk = raw.content;
      message.content += textChunk;
    }

    // 2. Tool call fragments accumulation
    const rawToolCalls = raw.tool_calls ?? raw.toolCalls;
    if (Array.isArray(rawToolCalls)) {
      for (const item of rawToolCalls) {
        if (!isPlainObject(item)) continue;
        const index = typeof item.index === 'number' ? item.index : message.toolCalls.size;
        let toolCall = message.toolCalls.get(index);
        if (!toolCall) {
          toolCall = {
            index,
            id: typeof item.id === 'string' ? item.id : '',
            name: '',
            rawArguments: '',
            emitted: false,
            isCorrupted: false,
          };
          message.toolCalls.set(index, toolCall);
        }

        if (toolCall.isCorrupted) {
          continue;
        }

        if (typeof item.id === 'string' && item.id.length > 0) {
          toolCall.id = item.id;
        }

        if (item.tool_info || item.toolInfo) {
          toolCall.toolInfo = item.tool_info ?? item.toolInfo;
        }

        const fn = item.function;
        if (isPlainObject(fn)) {
          if (typeof fn.name === 'string' && fn.name.length > 0) {
            toolCall.name = fn.name;
          }
          if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
            toolCall.rawArguments += fn.arguments;
          }
        }
      }
    }

    // 3. Finish reason tracking
    if (typeof raw.finish_reason === 'string') {
      message.finishReason = raw.finish_reason;
    }
    if (raw.usage) {
      message.usage = raw.usage;
    }

    // 4. Tool call finalization check:
    // Requires BOTH completion signal (finish_reason) AND valid id, name, and parsed JSON arguments.
    const newlyFinalized: AssembledToolCall[] = [];
    const hasCompletionSignal =
      message.finishReason === 'tool_calls' ||
      message.finishReason === 'stop';

    if (hasCompletionSignal && !message.isCorrupted) {
      for (const toolCall of message.toolCalls.values()) {
        if (toolCall.emitted || toolCall.isCorrupted) continue;
        if (!toolCall.id || !toolCall.name) continue;

        const argsStr = toolCall.rawArguments.trim();
        try {
          if (argsStr.length === 0) {
            toolCall.parsedArgs = {};
          } else {
            toolCall.parsedArgs = JSON.parse(argsStr);
          }
          toolCall.emitted = true;
          newlyFinalized.push(toolCall);
        } catch {
          // Arguments invalid JSON despite finish_reason: mark corrupted, do not emit
          toolCall.isCorrupted = true;
        }
      }
    }

    return {
      message,
      newlyFinalizedToolCalls: newlyFinalized,
      textChunk,
    };
  }

  private getOrCreateMessage(id: string, threadId: string): AssembledMessage {
    let msg = this.messages.get(id);
    if (!msg) {
      msg = {
        id,
        threadId: threadId || 'main',
        content: '',
        toolCalls: new Map<number, AssembledToolCall>(),
        isCorrupted: false,
      };
      this.messages.set(id, msg);
    }
    return msg;
  }
}
