/**
 * SessionOrchestrator -- single-flight run coordinator for Forge Agent.
 *
 * Implements the EngineApi state machine, coordinating TrueForge sessions,
 * turn streaming, event mapping, cancellation, and error normalization.
 */

import * as crypto from 'node:crypto';
import type {
  EngineApi,
  EngineEvent,
  TerminalEvent,
  InlineRequest,
  AgentRequest,
  ReviewResult,
  ForgeError,
  UiHost,
} from '../types/contract.ts';
import {
  isPlainObject,
  type EngineConfig,
} from './config.ts';
import {
  ForgeClient,
  HttpError,
  NetworkError,
  type ContextBlock,
  type RawEvent,
} from './ForgeClient.ts';
import {
  mapRawEvent,
  mapTerminal,
  createEventMapperState,
  type EventMapperState,
} from './eventMapper.ts';
import { SingleConsumerEventQueue } from './eventQueue.ts';
import { ApprovalBridge, type PauseResolution } from './approvalBridge.ts';
import {
  handleProposeEdit,
  proposeEditInputSchema,
} from '../mcp/tools/proposeEdit.ts';
import {
  handleCreateFile,
  createFileInputSchema,
} from '../mcp/tools/createFile.ts';
import type { ToolExecutionContext, ToolCallResult } from '../mcp/limits.ts';
import type { DecisionStore } from './ProposalStore.ts';
import type { z } from 'zod';

/**
 * Pluggable logger interface for SessionOrchestrator transitions and diagnostics.
 */
export interface EngineLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug?(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Options for configuring SessionOrchestrator.
 */
export interface OrchestratorOptions {
  logger?: EngineLogger;
  clock?: () => number;
  activeProfile?: 'primary' | 'fallback';
}

/**
 * Ephemeral per-run execution context.
 * Only `activeContext` and the authoritative epoch counter belong on the orchestrator.
 */
interface RunContext {
  runId: string;
  mode: 'inline' | 'agent';
  epoch: number;
  profile: 'primary' | 'fallback';
  modelId: string;
  abortController: AbortController;
  queue: SingleConsumerEventQueue;
  mapperState: EventMapperState;
  sessionId: string | null;
  isCancelled: boolean;
  isConsumerTerminated: boolean;
  isFinalized: boolean;
  usedTokens: number;
  approvalBridge: ApprovalBridge;
}

/**
 * Orchestrates the single-flight agent run loop, mapping wire SSE turns to EngineEvents.
 */
export class SessionOrchestrator implements EngineApi {
  private activeContext: RunContext | null = null;
  private runEpoch = 0;
  private activeProfile: 'primary' | 'fallback';
  private lastRunAnyHunkApplied = false;
  private lastDecisionStore: DecisionStore | null = null;
  private readonly host: UiHost;
  private readonly client: ForgeClient;
  private readonly config: EngineConfig;
  private readonly logger?: EngineLogger;
  private readonly clock: () => number;

  constructor(
    host: UiHost,
    client: ForgeClient,
    config: EngineConfig,
    options?: OrchestratorOptions
  ) {
    this.host = host;
    this.client = client;
    this.config = config;
    this.logger = options?.logger;
    this.clock = options?.clock ?? (() => Date.now());
    this.activeProfile = options?.activeProfile ?? 'primary';
  }

  /**
   * Returns this orchestrator instance as an EngineApi.
   */
  public toApi(): EngineApi {
    return this;
  }

  /**
   * Returns the model ID corresponding to the currently active model profile.
   */
  public activeModel(): string {
    const profile = this.config.models.profiles[this.activeProfile];
    return profile?.modelId ?? 'unknown-model';
  }

  /**
   * Switches the active model profile between primary and fallback.
   */
  public async switchModel(profile: string): Promise<void> {
    if (profile !== 'primary' && profile !== 'fallback') {
      throw new Error(`Unknown model profile: '${profile}' (expected 'primary' or 'fallback')`);
    }
    this.activeProfile = profile;
    this.log('model:switch', { activeProfile: this.activeProfile, model: this.activeModel() });
  }

  /**
   * Executes an inline edit run, returning an async iterable of EngineEvents.
   * Busy slot is claimed on the first iterator next(), not on generator creation.
   */
  public runInline(req: InlineRequest): AsyncIterable<EngineEvent> {
    return this.createRunIterable('inline', req);
  }

  /**
   * Executes an agent run, returning an async iterable of EngineEvents.
   * Busy slot is claimed on the first iterator next(), not on generator creation.
   */
  public runAgent(req: AgentRequest): AsyncIterable<EngineEvent> {
    return this.createRunIterable('agent', req);
  }

  /**
   * Returns whether any accepted hunk has been applied in the active run (or latest run).
   */
  public get anyHunkApplied(): boolean {
    return this.activeContext?.approvalBridge.anyHunkApplied ?? this.lastRunAnyHunkApplied;
  }

  /**
   * Returns proposeEdit and createFile handlers bound to the active run's DecisionStore.
   * Pluggable hook for McpToolServer.setProposalHandlers().
   */
  public getProposalHandlers(): {
    proposeEdit: (args: z.infer<typeof proposeEditInputSchema>, ctx: ToolExecutionContext) => Promise<ToolCallResult>;
    createFile: (args: z.infer<typeof createFileInputSchema>, ctx: ToolExecutionContext) => Promise<ToolCallResult>;
  } {
    return {
      proposeEdit: async (args, ctx) => {
        const store = this.activeContext?.approvalBridge.getDecisionStore() ?? this.lastDecisionStore ?? undefined;
        return handleProposeEdit(args, ctx, store);
      },
      createFile: async (args, ctx) => {
        const store = this.activeContext?.approvalBridge.getDecisionStore() ?? this.lastDecisionStore ?? undefined;
        return handleCreateFile(args, ctx, store);
      },
    };
  }

  /**
   * Cancels the active run immediately. Idempotent and returns fast.
   */
  public async cancel(): Promise<void> {
    const ctx = this.activeContext;
    if (!ctx || ctx.isFinalized) {
      return;
    }

    ctx.isCancelled = true;
    if (ctx.approvalBridge) {
      ctx.approvalBridge.cancel((ev) => ctx.queue.push(ev, ctx.epoch));
    }
    this.runEpoch++;
    ctx.abortController.abort();

    await this.finalizeRun(ctx, { type: 'run.cancelled' }, 'cancel_requested');
  }

  /**
   * Acknowledges review completion for a pending proposal batch.
   * Resolves decisions in DecisionStore and unblocks the approval bridge.
   */
  public async reviewDone(result: ReviewResult): Promise<void> {
    if (!this.activeContext || this.activeContext.isFinalized || this.activeContext.isCancelled) {
      this.log('review:done_ignored', { batchId: result.batchId, reason: 'no_active_run_or_cancelled' });
      return;
    }
    this.log('review:done', { batchId: result.batchId });
    this.activeContext.approvalBridge.reviewDone(result);
  }

  /**
   * Creates an AsyncIterable for a run, claiming the busy slot on the first next() invocation.
   */
  private createRunIterable(
    mode: 'inline' | 'agent',
    req: InlineRequest | AgentRequest
  ): AsyncIterable<EngineEvent> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<EngineEvent> => {
        let runContext: RunContext | null = null;
        let iterator: AsyncIterator<EngineEvent> | null = null;
        let initialized = false;
        let busyEmitted = false;

        return {
          next: async (): Promise<IteratorResult<EngineEvent>> => {
            if (!initialized) {
              initialized = true;

              // Claim the busy slot on first next()
              if (this.activeContext !== null) {
                if (busyEmitted) {
                  return { done: true, value: undefined };
                }
                busyEmitted = true;
                const busyError: ForgeError = {
                  kind: 'busy',
                  message: 'Engine is busy with an active run',
                  retryable: false,
                };
                return { done: false, value: { type: 'run.failed', error: busyError } };
              }

              const runId = crypto.randomUUID();
              const epoch = ++this.runEpoch;
              const abortController = new AbortController();
              const mapperState = createEventMapperState();
              const queue = new SingleConsumerEventQueue(() => this.runEpoch);

              // Capture the selected profile and model at run start
              const profile = this.activeProfile;
              const modelId = this.config.models.profiles[profile]?.modelId ?? 'unknown-model';

              runContext = {
                runId,
                mode,
                epoch,
                profile,
                modelId,
                abortController,
                queue,
                mapperState,
                sessionId: null,
                isCancelled: false,
                isConsumerTerminated: false,
                isFinalized: false,
                usedTokens: 0,
                approvalBridge: new ApprovalBridge(this.host),
              };

              this.activeContext = runContext;
              this.log('run:start', { runId, mode, epoch, profile, model: modelId });

              // Start background event pump
              this.startRunPump(runContext, req);

              iterator = queue[Symbol.asyncIterator]();
            }

            if (busyEmitted) {
              return { done: true, value: undefined };
            }

            if (!iterator) {
              return { done: true, value: undefined };
            }

            return iterator.next();
          },

          return: async (): Promise<IteratorResult<EngineEvent>> => {
            if (runContext && !runContext.isFinalized) {
              runContext.isConsumerTerminated = true;
              await this.finalizeRun(runContext, null, 'consumer_return');
            }
            if (iterator?.return) {
              return iterator.return();
            }
            return { done: true, value: undefined };
          },

          throw: async (err?: unknown): Promise<IteratorResult<EngineEvent>> => {
            if (runContext && !runContext.isFinalized) {
              runContext.isConsumerTerminated = true;
              await this.finalizeRun(runContext, null, 'consumer_throw');
            }
            if (iterator?.throw) {
              return iterator.throw(err);
            }
            return Promise.reject(err);
          },
        };
      },
    };
  }

  /**
   * Background event pump coordinating session creation, turn streaming, and event mapping.
   */
  private async startRunPump(
    ctx: RunContext,
    req: InlineRequest | AgentRequest
  ): Promise<void> {
    try {
      // 1. Emit run.started before createSession() with fixed captured modelId
      ctx.queue.push(
        {
          type: 'run.started',
          runId: ctx.runId,
          mode: ctx.mode,
          model: ctx.modelId,
        },
        ctx.epoch
      );

      // 2. Build first turn input
      const input = await this.buildFirstTurnInput(ctx, req);

      if (ctx.isCancelled || ctx.abortController.signal.aborted) {
        return;
      }

      // 3. Emit initial budget event through run's existing queue
      ctx.queue.push(
        {
          type: 'budget',
          usedTokens: ctx.usedTokens,
          limitTokens: this.config.setup.budgets.runToolBudgetTokens,
        },
        ctx.epoch
      );
      this.log('run:budget_initial', {
        runId: ctx.runId,
        usedTokens: ctx.usedTokens,
        limitTokens: this.config.setup.budgets.runToolBudgetTokens,
      });

      // 4. Create session on active profile agent captured at start
      const agentName = this.config.setup.agents[ctx.profile];
      this.log('run:create_session', { runId: ctx.runId, agentName });

      let sessionId: string;
      try {
        sessionId = await this.client.createSession(agentName);
      } catch (err: unknown) {
        if (ctx.isCancelled || ctx.abortController.signal.aborted) {
          return;
        }
        throw err;
      }

      ctx.sessionId = sessionId;
      this.log('run:session_created', { runId: ctx.runId, sessionId });

      // Handle cancellation while createSession was pending
      if (ctx.isCancelled || ctx.abortController.signal.aborted) {
        this.safeRemoteCancel(sessionId);
        return;
      }

      // 4. Stream turn events
      this.log('run:create_turn', { runId: ctx.runId, sessionId });
      let turnStream: AsyncIterable<RawEvent> = this.client.createTurn(
        sessionId,
        input,
        ctx.abortController.signal
      );

      let terminalEncountered: TerminalEvent | null = null;
      let currentTurnId = '';
      let lastProcessedEventId: string | undefined = undefined;
      let hasResumedFromPause = false;

      while (!terminalEncountered && !ctx.isCancelled && !ctx.abortController.signal.aborted) {
        for await (const raw of turnStream) {
          if (ctx.isCancelled || ctx.abortController.signal.aborted) {
            break;
          }

          // Track turnId and eventId from incoming raw event
          const rawEvent = raw as RawEvent;
          const rawData = isPlainObject(rawEvent.data)
            ? (rawEvent.data as Record<string, unknown>)
            : isPlainObject(raw)
            ? (raw as Record<string, unknown>)
            : null;

          const eventTurnId = typeof rawData?.turn_id === 'string'
            ? rawData.turn_id
            : typeof rawData?.turnId === 'string'
            ? rawData.turnId
            : undefined;
          if (eventTurnId) {
            currentTurnId = eventTurnId;
          }

          const eventId = typeof rawData?.id === 'string'
            ? rawData.id
            : typeof rawEvent?.id === 'string'
            ? rawEvent.id
            : undefined;
          if (eventId) {
            lastProcessedEventId = eventId;
          }

          const mapResult = mapRawEvent(raw, ctx.mapperState);
          for (const ev of mapResult.events) {
            ctx.queue.push(ev, ctx.epoch);
          }

          // 4a. Handle sequence gap at completion boundary: log and never treat discarded completion as successful
          if (mapResult.gap) {
            this.log('stream:sequence_gap', {
              runId: ctx.runId,
              expected: mapResult.gap.expected,
              received: mapResult.gap.received,
            });
            terminalEncountered = {
              type: 'run.failed',
              error: {
                kind: 'unknown',
                message: `Sequence gap detected at completion boundary (expected ${mapResult.gap.expected}, received ${mapResult.gap.received})`,
                retryable: false,
              },
            };
            break;
          }

          // 4b. Coordinate approval pauses via ApprovalBridge (Milestone E-06)
          if (mapResult.newPauses.length > 0) {
            this.log('stream:new_pauses', { runId: ctx.runId, count: mapResult.newPauses.length });
            const pauses = ctx.mapperState.consumePauses();
            let pauseRes: PauseResolution;
            try {
              pauseRes = await ctx.approvalBridge.handlePause(
                pauses,
                sessionId,
                currentTurnId,
                ctx.abortController.signal,
                (ev) => ctx.queue.push(ev, ctx.epoch)
              );
            } catch (err: unknown) {
              if (ctx.isCancelled || ctx.abortController.signal.aborted) {
                return;
              }
              throw err;
            }

            if (ctx.isCancelled || ctx.abortController.signal.aborted) {
              return;
            }

            // Submit ALL pending approvals (pre-denied + human-reviewed) together in ONE resume call
            try {
              await this.client.submitApprovals(
                sessionId,
                currentTurnId,
                pauseRes.approvals,
                ctx.abortController.signal
              );
              hasResumedFromPause = true;
            } catch (err: unknown) {
              if (ctx.isCancelled || ctx.abortController.signal.aborted) {
                return;
              }
              const forgeError = this.classifyError(err);
              terminalEncountered = { type: 'run.failed', error: forgeError };
              break;
            }
          }

          // 4c. Handle unresolvedPauses if present in mapper API
          if (mapResult.unresolvedPauses && mapResult.unresolvedPauses.length > 0) {
            this.log('stream:unresolved_pauses', { runId: ctx.runId, count: mapResult.unresolvedPauses.length });
            terminalEncountered = {
              type: 'run.failed',
              error: {
                kind: 'unknown',
                message: `Unresolved approval pause correlation error: ${mapResult.unresolvedPauses.map((u) => u.reason).join('; ')}`,
                retryable: false,
              },
            };
            break;
          }

          // 4d. Call mapTerminal() ONLY for actual terminal wire events (turn.update and turn.done)
          const eventType = rawData && typeof rawData.type === 'string' ? rawData.type : rawEvent.event;

          if (eventType === 'turn.update' || eventType === 'turn.done') {
            const terminal = mapTerminal(raw);

            // Preserve pause precedence: explicit paused status OR done with non-empty requiredActions is a pause
            const hasRequiredActions =
              terminal.outcome === 'done' &&
              Array.isArray(terminal.requiredActions) &&
              terminal.requiredActions.length > 0;

            if (terminal.outcome === 'paused' || hasRequiredActions) {
              if (ctx.mapperState.pauses.length > 0) {
                this.log('stream:paused_terminal_with_pauses', { runId: ctx.runId, count: ctx.mapperState.pauses.length });
                const pauses = ctx.mapperState.consumePauses();
                let pauseRes: PauseResolution;
                try {
                  pauseRes = await ctx.approvalBridge.handlePause(
                    pauses,
                    sessionId,
                    currentTurnId,
                    ctx.abortController.signal,
                    (ev) => ctx.queue.push(ev, ctx.epoch)
                  );
                } catch (err: unknown) {
                  if (ctx.isCancelled || ctx.abortController.signal.aborted) {
                    return;
                  }
                  throw err;
                }

                if (ctx.isCancelled || ctx.abortController.signal.aborted) {
                  return;
                }

                try {
                  await this.client.submitApprovals(
                    sessionId,
                    currentTurnId,
                    pauseRes.approvals,
                    ctx.abortController.signal
                  );
                  hasResumedFromPause = true;
                } catch (err: unknown) {
                  if (ctx.isCancelled || ctx.abortController.signal.aborted) {
                    return;
                  }
                  const forgeError = this.classifyError(err);
                  terminalEncountered = { type: 'run.failed', error: forgeError };
                  break;
                }
              }
              // If pauses was empty, it was already handled by mapResult.newPauses: stream continues!
            } else if (terminal.outcome === 'error') {
              terminalEncountered = {
                type: 'run.failed',
                error: {
                  kind: 'model',
                  message: terminal.message,
                  retryable: false,
                },
              };
              break;
            } else if (terminal.outcome === 'cancelled') {
              terminalEncountered = { type: 'run.cancelled' };
              break;
            } else if (eventType === 'turn.done') {
              if (terminal.outcome === 'done') {
                // Check for unconsumed approval pauses at completion
                if (ctx.mapperState.pauses.length > 0) {
                  terminalEncountered = {
                    type: 'run.failed',
                    error: {
                      kind: 'unknown',
                      message: 'Turn completed with unresolved approval pauses',
                      retryable: false,
                    },
                  };
                  break;
                }

                const summary = this.extractSummary(terminal.output);
                terminalEncountered = { type: 'run.completed', summary };
                break;
              } else if (terminal.outcome === 'non_terminal') {
                // A non_terminal result on turn.done is a failure
                terminalEncountered = {
                  type: 'run.failed',
                  error: {
                    kind: 'unknown',
                    message: `turn.done received with non-terminal status '${terminal.currentStatus ?? 'unknown'}'`,
                    retryable: false,
                  },
                };
                break;
              }
            }
          }
        }

        if (terminalEncountered || ctx.isCancelled || ctx.abortController.signal.aborted) {
          break;
        }

        // If the original SSE stream ended when the turn paused, reconnect with client.subscribeTurn
        if (hasResumedFromPause && currentTurnId && lastProcessedEventId) {
          hasResumedFromPause = false;
          this.log('stream:reconnect_subscribe', {
            runId: ctx.runId,
            turnId: currentTurnId,
            afterEventId: lastProcessedEventId,
          });
          turnStream = this.client.subscribeTurn(
            sessionId,
            currentTurnId,
            {
              afterEventId: lastProcessedEventId,
              signal: ctx.abortController.signal,
            }
          );
        } else {
          // Stream ended without a terminal event and not resuming from pause
          break;
        }
      }

      if (ctx.isCancelled || ctx.abortController.signal.aborted) {
        return;
      }

      if (terminalEncountered) {
        await this.finalizeRun(ctx, terminalEncountered, 'turn_terminal');
      } else {
        // Unexpected stream EOF without a positively established successful terminal outcome -> unreachable failure
        const eofError: ForgeError = {
          kind: 'unreachable',
          message: 'Stream ended prematurely without a terminal turn event',
          retryable: true,
        };
        await this.finalizeRun(ctx, { type: 'run.failed', error: eofError }, 'unexpected_stream_eof');
      }
    } catch (err: unknown) {
      if (ctx.isCancelled || ctx.abortController.signal.aborted) {
        return;
      }
      const forgeError = this.classifyError(err);
      await this.finalizeRun(ctx, { type: 'run.failed', error: forgeError }, 'pump_error');
    }
  }

  /**
   * Finalizes a run: releases the lock, aborts background streams, and delivers the terminal event.
   */
  private async finalizeRun(
    ctx: RunContext,
    terminalEvent: TerminalEvent | null,
    reason?: string
  ): Promise<void> {
    if (ctx.isFinalized) {
      return;
    }
    ctx.isFinalized = true;

    this.log('run:finalize', {
      runId: ctx.runId,
      reason,
      hasTerminal: terminalEvent !== null,
      isConsumerTerminated: ctx.isConsumerTerminated,
    });

    if (this.activeContext === ctx) {
      this.lastRunAnyHunkApplied = ctx.approvalBridge.anyHunkApplied;
      this.lastDecisionStore = ctx.approvalBridge.getDecisionStore();
      this.activeContext = null;
    }

    ctx.abortController.abort();
    this.runEpoch++;

    if (!ctx.isConsumerTerminated && terminalEvent !== null) {
      ctx.queue.pushTerminal(terminalEvent);
    }

    ctx.queue.close();

    // Best-effort remote cancellation only when cancelled or during silent consumer teardown.
    // Safe against both synchronous exceptions and promise rejections.
    if (ctx.sessionId && (ctx.isCancelled || ctx.isConsumerTerminated)) {
      this.safeRemoteCancel(ctx.sessionId);
    }
  }

  /**
   * Safely attempts best-effort remote session cancellation.
   * Catches both synchronous exceptions and asynchronous promise rejections so cleanup
   * never fails, throws, or prevents finalization.
   */
  private safeRemoteCancel(sessionId: string): void {
    try {
      const cancelPromise = this.client.cancel(sessionId);
      if (cancelPromise && typeof cancelPromise.catch === 'function') {
        cancelPromise.catch((err: unknown) => {
          this.log('cancel_error', { sessionId, error: (err as Error).message });
        });
      }
    } catch (err: unknown) {
      this.log('cancel_error', { sessionId, error: (err as Error).message });
    }
  }

  /**
   * Constructs the initial turn input message blocks from user prompt, mentions, and seed context.
   * Performs minimal initial token accounting consistently from the actual text read.
   */
  private async buildFirstTurnInput(
    ctx: RunContext,
    req: InlineRequest | AgentRequest
  ): Promise<unknown[]> {
    if (ctx.mode === 'inline') {
      const inlineReq = req as InlineRequest;
      const promptTokens = Math.ceil(inlineReq.prompt.length / 4);
      const textTokens = Math.ceil(inlineReq.selectedText.length / 4);
      ctx.usedTokens = promptTokens + textTokens;

      const blocks: ContextBlock[] = [
        {
          path: inlineReq.path,
          reason: 'inline selection',
          range: inlineReq.range,
          text: inlineReq.selectedText,
        },
      ];
      return this.client.userMessageInput(inlineReq.prompt, blocks);
    }

    const agentReq = req as AgentRequest;
    const contextBlocks: ContextBlock[] = [];
    const promptTokens = Math.ceil(agentReq.prompt.length / 4);
    let mentionsTokenCount = 0;
    let seedTokenCount = 0;
    const mentionsLimit = this.config.setup.budgets.mentionsTokens;

    if (agentReq.mentions && agentReq.mentions.length > 0) {
      for (const mention of agentReq.mentions) {
        const estimatedTokens = Math.ceil(mention.content.length / 4);
        if (mentionsTokenCount + estimatedTokens <= mentionsLimit) {
          contextBlocks.push({
            path: mention.path,
            reason: `@${mention.label}`,
            text: mention.content,
          });
          mentionsTokenCount += estimatedTokens;
        } else {
          const allowedChars = Math.max(0, (mentionsLimit - mentionsTokenCount) * 4);
          const truncatedContent =
            allowedChars > 100
              ? `${mention.content.slice(0, allowedChars)}\n... (mention truncated due to budget)`
              : `[File ${mention.path} omitted due to mentions budget limit]`;
          contextBlocks.push({
            path: mention.path,
            reason: `@${mention.label} (truncated)`,
            text: truncatedContent,
          });
          const actualTruncatedTokens = Math.ceil(truncatedContent.length / 4);
          mentionsTokenCount += actualTruncatedTokens;
          break;
        }
      }
    }

    const seedBudget = this.config.setup.budgets.seedTokens;
    try {
      const seedItems = await this.host.context.seed(agentReq.prompt, seedBudget);
      if (seedItems && seedItems.length > 0) {
        for (const item of seedItems) {
          try {
            // Use supported host.readFile(path, range?) API per UiHost contract
            const text = await this.host.readFile(item.path, item.range);
            // Token accounting corresponds to the actual text returned by host.readFile() and sent to TrueForge
            const actualTokens = Math.ceil(text.length / 4);
            seedTokenCount += actualTokens;
            contextBlocks.push({
              path: item.path,
              reason: item.reason,
              range: item.range,
              text,
            });
          } catch {
            // Ignore individual file read failures for seed items
          }
        }
      }
    } catch (seedErr: unknown) {
      this.log('seed:error', { error: (seedErr as Error).message });
    }

    ctx.usedTokens = promptTokens + mentionsTokenCount + seedTokenCount;

    return this.client.userMessageInput(agentReq.prompt, contextBlocks);
  }

  /**
   * Extracts a string summary from supported TrueForge output shapes:
   * 1. output is a string
   * 2. output is an object with a string 'content' property
   * Does not stringify arbitrary objects.
   */
  private extractSummary(output: unknown): string | undefined {
    if (typeof output === 'string' && output.trim().length > 0) {
      return output;
    }
    if (isPlainObject(output) && typeof output.content === 'string' && output.content.trim().length > 0) {
      return output.content;
    }
    return undefined;
  }

  /**
   * Deterministically classifies an encountered error into a contract ForgeError.
   */
  private classifyError(err: unknown): ForgeError {
    if (err instanceof NetworkError) {
      return {
        kind: 'unreachable',
        message: err.message,
        retryable: true,
      };
    }

    if (err instanceof HttpError) {
      if (err.status === 401 || err.status === 403) {
        return {
          kind: 'auth',
          message: err.message,
          retryable: false,
        };
      }
      if (err.status === 429) {
        return {
          kind: 'rate_limit',
          message: err.message,
          retryable: true,
        };
      }
      if (err.status === 408) {
        return {
          kind: 'timeout',
          message: err.message,
          retryable: true,
        };
      }
      if (err.status >= 500 && err.status <= 599) {
        return {
          kind: 'model',
          message: err.message,
          retryable: true,
        };
      }
      return {
        kind: 'unknown',
        message: err.message,
        retryable: false,
      };
    }

    if (err instanceof Error) {
      if (err.name === 'AbortError') {
        return {
          kind: 'unreachable',
          message: 'Request timed out or connection was aborted',
          retryable: true,
        };
      }
      if (err.message.includes('timed out') || err.message.includes('timeout')) {
        return {
          kind: 'timeout',
          message: err.message,
          retryable: false,
        };
      }
      return {
        kind: 'unknown',
        message: err.message,
        retryable: false,
      };
    }

    return {
      kind: 'unknown',
      message: String(err ?? 'Unknown error'),
      retryable: false,
    };
  }

  /**
   * Logs an orchestrator transition with a timestamp and metadata.
   */
  private log(event: string, meta?: Record<string, unknown>): void {
    if (!this.logger) return;
    const timestamp = this.clock();
    this.logger.info(`[${new Date(timestamp).toISOString()}] ${event}`, meta);
  }
}
