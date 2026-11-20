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
  ContextItem,
  LineRange,
} from '../types/contract.ts';
import { RunBudget } from './budget.ts';
import {
  isPlainObject,
  type EngineConfig,
} from './config.ts';
import {
  ForgeClient,
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
import type { z } from 'zod';

import {
  ResilienceManager,
  type ClassifiedError,
  redactToken,
} from './ResilienceManager.ts';
import {
  LoopGuard,
  LOOP_GUARD_STOP_MESSAGE,
} from './loopGuard.ts';

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
  resilienceManager?: ResilienceManager;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  jitter?: boolean;
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
  initialTokens: number;
  approvalBridge: ApprovalBridge;
  originalInput: unknown[];
  primaryFailure?: ClassifiedError | ForgeError;
  loopGuard: LoopGuard;
  budget: RunBudget;
  isBudgetLive: boolean;
  seedContextItems: ContextItem[];
  contextItems: Map<string, ContextItem>;
  activeToolCalls: Map<string, { tool: string; args: unknown }>;
}

/**
 * Orchestrates the single-flight agent run loop, mapping wire SSE turns to EngineEvents.
 */
export class SessionOrchestrator implements EngineApi {
  private activeContext: RunContext | null = null;
  private runEpoch = 0;
  private activeProfile: 'primary' | 'fallback';
  private lastRunAnyHunkApplied = false;
  private readonly host: UiHost;

  /**
   * Returns the active run's RunBudget instance, if an active run exists.
   */
  public getActiveBudget(): RunBudget | undefined {
    return this.activeContext?.budget;
  }
  private readonly client: ForgeClient;
  private readonly config: EngineConfig;
  private readonly logger?: EngineLogger;
  private readonly clock: () => number;
  private readonly resilience: ResilienceManager;

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
    this.resilience =
      options?.resilienceManager ??
      new ResilienceManager({
        maxRetries: config.setup.retry?.max ?? 3,
        baseDelayMs: config.setup.retry?.baseDelayMs ?? 1000,
        clock: this.clock,
        sleep: options?.sleep,
        jitter: options?.jitter ?? true,
      });
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
        const store = this.activeContext?.approvalBridge.getDecisionStore();
        if (!store) {
          return {
            content: [{ type: 'text', text: 'no active run' }],
            isError: true,
          };
        }
        return handleProposeEdit(args, ctx, store);
      },
      createFile: async (args, ctx) => {
        const store = this.activeContext?.approvalBridge.getDecisionStore();
        if (!store) {
          return {
            content: [{ type: 'text', text: 'no active run' }],
            isError: true,
          };
        }
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

              const limitTokens = this.config.setup.budgets.runToolBudgetTokens;
              const budget = new RunBudget({
                configuredRunLimit: limitTokens,
                configuredSeedLimit: this.config.setup.budgets.seedTokens,
                configuredMentionsLimit: this.config.setup.budgets.mentionsTokens,
                onBudgetChange: (used, _limit) => {
                  try {
                    if (runContext && runContext.isBudgetLive && !runContext.isFinalized && !runContext.isCancelled) {
                      runContext.usedTokens = used;
                      runContext.queue.push({ type: 'budget', usedTokens: used, limitTokens }, runContext.epoch);
                    }
                  } catch {
                    // never throw
                  }
                },
              });

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
                initialTokens: 0,
                approvalBridge: new ApprovalBridge(this.host),
                originalInput: [],
                loopGuard: new LoopGuard({ clock: this.clock }),
                budget,
                isBudgetLive: false,
                seedContextItems: [],
                contextItems: new Map(),
                activeToolCalls: new Map(),
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
   * Background event pump coordinating session creation, turn streaming, retries, and failover.
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
      ctx.originalInput = input;
      ctx.initialTokens = ctx.usedTokens;

      if (ctx.isCancelled || ctx.abortController.signal.aborted) {
        return;
      }

      // 3. Emit initial budget event through run's existing queue
      const limitTokens = this.config.setup.budgets.runToolBudgetTokens;
      ctx.queue.push(
        {
          type: 'budget',
          usedTokens: ctx.budget.getUsedTokens(),
          limitTokens,
        },
        ctx.epoch
      );
      this.log('run:budget_initial', {
        runId: ctx.runId,
        usedTokens: ctx.budget.getUsedTokens(),
        limitTokens,
      });

      if (ctx.mode === 'agent' && ctx.contextItems.size > 0) {
        ctx.queue.push(
          {
            type: 'context.report',
            items: Array.from(ctx.contextItems.values()),
          },
          ctx.epoch
        );
      }

      ctx.isBudgetLive = true;

      // 4. Execution loop handling session creation, turn streaming, retries, and failover
      let attempt = 0;

      while (!ctx.isCancelled && !ctx.abortController.signal.aborted) {
        // Step A: Ensure active session
        if (!ctx.sessionId) {
          const agentName = this.config.setup.agents[ctx.profile];
          this.log('run:create_session', { runId: ctx.runId, agentName, profile: ctx.profile });

          try {
            ctx.sessionId = await this.client.createSession(agentName);
          } catch (err: unknown) {
            if (ctx.isCancelled || ctx.abortController.signal.aborted) {
              return;
            }
            const classified = this.classifyError(err);

            if (classified.isTrueForgeDown) {
              await this.finalizeRun(ctx, { type: 'run.failed', error: classified }, 'trueforge_down');
              return;
            }

            if (classified.retryable && attempt < this.resilience.maxRetries) {
              attempt++;
              const delayMs = this.resilience.getDelay(attempt);
              this.log('run:retry', { attempt, delayMs, kind: classified.kind, stage: 'create_session' });
              ctx.queue.push({ type: 'retry', attempt, delayMs, kind: classified.kind }, ctx.epoch);
              try {
                await this.resilience.sleep(delayMs, ctx.abortController.signal);
              } catch {
                await this.finalizeRun(ctx, { type: 'run.cancelled' }, 'cancelled_during_backoff');
                return;
              }
              continue;
            }

            const handled = await this.handleTurnError(ctx, classified);
            if (!handled) return;
            attempt = 0;
            continue;
          }

          this.log('run:session_created', { runId: ctx.runId, sessionId: ctx.sessionId });
          if (ctx.isCancelled || ctx.abortController.signal.aborted) {
            if (ctx.sessionId) this.safeRemoteCancel(ctx.sessionId);
            return;
          }
        }

        // Step B: Stream turn
        let sideEffectsOccurredInAttempt = false;
        // A retry re-sends the exact same input items (user prompt and initial context blocks) to TrueForge within the active session, starting a fresh attempt of the turn because no tool calls or proposals were emitted yet.
        const turnInput = ctx.originalInput;
        this.log('run:create_turn', { runId: ctx.runId, sessionId: ctx.sessionId, attempt });

        let turnStream: AsyncIterable<RawEvent>;
        try {
          turnStream = this.client.createTurn(ctx.sessionId, turnInput, ctx.abortController.signal);
        } catch (err: unknown) {
          if (ctx.isCancelled || ctx.abortController.signal.aborted) return;
          const classified = this.classifyError(err);
          if (classified.isTrueForgeDown) {
            await this.finalizeRun(ctx, { type: 'run.failed', error: classified }, 'trueforge_down');
            return;
          }
          if (classified.retryable && attempt < this.resilience.maxRetries) {
            attempt++;
            const delayMs = this.resilience.getDelay(attempt);
            this.log('run:retry', { attempt, delayMs, kind: classified.kind, stage: 'create_turn' });
            ctx.queue.push({ type: 'retry', attempt, delayMs, kind: classified.kind }, ctx.epoch);
            try {
              await this.resilience.sleep(delayMs, ctx.abortController.signal);
            } catch {
              await this.finalizeRun(ctx, { type: 'run.cancelled' }, 'cancelled_during_backoff');
              return;
            }
            continue;
          }
          const handled = await this.handleTurnError(ctx, classified);
          if (!handled) return;
          attempt = 0;
          continue;
        }

        let terminalEncountered: TerminalEvent | null = null;
        let turnErrorToHandle: ClassifiedError | null = null;
        let currentTurnId = '';
        let lastProcessedEventId: string | undefined = undefined;
        let hasResumedFromPause = false;

        try {
          while (!terminalEncountered && !turnErrorToHandle && !ctx.isCancelled && !ctx.abortController.signal.aborted) {
            for await (const raw of turnStream) {
              if (ctx.isCancelled || ctx.abortController.signal.aborted) {
                break;
              }

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
                if (ev.type === 'tool.call') {
                  ctx.activeToolCalls.set(ev.callId, { tool: ev.tool, args: ev.args });
                  if (ev.tool === 'proposeEdit' || ev.tool === 'createFile') {
                    // Edits reset repetition history
                    ctx.loopGuard.reset();
                  } else {
                    const loopCheck = ctx.loopGuard.record(ev.tool, ev.args);
                    if (loopCheck.stop) {
                      this.log('run:loop_guard_stopped', {
                        runId: ctx.runId,
                        tool: ev.tool,
                        reason: loopCheck.reason,
                      });
                      terminalEncountered = {
                        type: 'run.failed',
                        error: {
                          kind: 'stuck',
                          message: LOOP_GUARD_STOP_MESSAGE,
                          retryable: false,
                        },
                      };
                    }
                  }
                }
                if (ev.type === 'proposal.created') {
                  ctx.loopGuard.reset();
                }
                if (ev.type === 'tool.call' || ev.type === 'proposal.created') {
                  sideEffectsOccurredInAttempt = true;
                }
                ctx.queue.push(ev, ctx.epoch);

                if (ev.type === 'tool.result') {
                  const callInfo = ctx.activeToolCalls.get(ev.callId);
                  if (callInfo) {
                    ctx.activeToolCalls.delete(ev.callId);
                    if (ev.ok && ctx.mode === 'agent') {
                      try {
                        let updated = false;
                        if (callInfo.tool === 'readFile') {
                          const args = callInfo.args as { path?: string; range?: LineRange };
                          if (args && typeof args.path === 'string' && args.path.trim().length > 0) {
                            const relPath = args.path.replace(/\\/g, '/');
                            const tokens = Math.max(1, RunBudget.estimateTokens(ev.summary ?? ''));
                            const ci: ContextItem = {
                              path: relPath,
                              reason: 'Read by agent',
                              tokens,
                              source: 'agent-tool',
                              range: args.range,
                            };
                            ctx.contextItems.set(relPath, ci);
                            updated = true;
                          }
                        } else if (callInfo.tool === 'reportContext') {
                          const args = callInfo.args as { items?: Array<{ path: string; reason: string }> };
                          if (args && Array.isArray(args.items)) {
                            for (const item of args.items) {
                              if (item && typeof item.path === 'string' && item.path.trim().length > 0) {
                                const relPath = item.path.replace(/\\/g, '/');
                                const existing = ctx.contextItems.get(relPath);
                                const ci: ContextItem = {
                                  path: relPath,
                                  reason:
                                    typeof item.reason === 'string' && item.reason.trim().length > 0
                                      ? item.reason.trim()
                                      : existing?.reason ?? 'Reported by agent',
                                  tokens: existing?.tokens ?? 50,
                                  source: 'agent-tool',
                                  range: existing?.range,
                                };
                                ctx.contextItems.set(relPath, ci);
                                updated = true;
                              }
                            }
                          }
                        }

                        if (updated) {
                          ctx.queue.push(
                            {
                              type: 'context.report',
                              items: Array.from(ctx.contextItems.values()),
                            },
                            ctx.epoch
                          );
                        }
                      } catch {
                        // never throw
                      }
                    }
                  }
                }

                if (terminalEncountered) {
                  break;
                }
              }

              if (terminalEncountered) {
                break;
              }

              // Sequence gap handling
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

              // Approval pause handling
              if (mapResult.newPauses.length > 0) {
                sideEffectsOccurredInAttempt = true;
                this.log('stream:new_pauses', { runId: ctx.runId, count: mapResult.newPauses.length });
                const pauses = ctx.mapperState.consumePauses();
                let pauseRes: PauseResolution;
                try {
                  pauseRes = await ctx.approvalBridge.handlePause(
                    pauses,
                    ctx.sessionId!,
                    currentTurnId,
                    ctx.abortController.signal,
                    (ev) => {
                      if (ev.type === 'proposal.created') sideEffectsOccurredInAttempt = true;
                      ctx.queue.push(ev, ctx.epoch);
                    }
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
                    ctx.sessionId!,
                    currentTurnId,
                    pauseRes.approvals,
                    ctx.abortController.signal
                  );
                  hasResumedFromPause = true;
                  ctx.loopGuard.reset();
                } catch (err: unknown) {
                  if (ctx.isCancelled || ctx.abortController.signal.aborted) {
                    return;
                  }
                  turnErrorToHandle = this.classifyError(err);
                  break;
                }
              }

              // Terminal wire event inspection
              const eventType = rawData && typeof rawData.type === 'string' ? rawData.type : rawEvent.event;

              if (eventType === 'turn.update' || eventType === 'turn.done') {
                const terminal = mapTerminal(raw);

                const hasRequiredActions =
                  terminal.outcome === 'done' &&
                  Array.isArray(terminal.requiredActions) &&
                  terminal.requiredActions.length > 0;

                if (terminal.outcome === 'paused' || hasRequiredActions) {
                  if (ctx.mapperState.pauses.length > 0) {
                    sideEffectsOccurredInAttempt = true;
                    this.log('stream:paused_terminal_with_pauses', { runId: ctx.runId, count: ctx.mapperState.pauses.length });
                    const pauses = ctx.mapperState.consumePauses();
                    let pauseRes: PauseResolution;
                    try {
                      pauseRes = await ctx.approvalBridge.handlePause(
                        pauses,
                        ctx.sessionId!,
                        currentTurnId,
                        ctx.abortController.signal,
                        (ev) => {
                          if (ev.type === 'proposal.created') sideEffectsOccurredInAttempt = true;
                          ctx.queue.push(ev, ctx.epoch);
                        }
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
                        ctx.sessionId!,
                        currentTurnId,
                        pauseRes.approvals,
                        ctx.abortController.signal
                      );
                      hasResumedFromPause = true;
                      ctx.loopGuard.reset();
                    } catch (err: unknown) {
                      if (ctx.isCancelled || ctx.abortController.signal.aborted) {
                        return;
                      }
                      turnErrorToHandle = this.classifyError(err);
                      break;
                    }
                  }
                } else if (terminal.outcome === 'error') {
                  turnErrorToHandle = this.classifyError(terminal.message);
                  break;
                } else if (terminal.outcome === 'cancelled') {
                  terminalEncountered = { type: 'run.cancelled' };
                  break;
                } else if (eventType === 'turn.done') {
                  if (terminal.outcome === 'done') {
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

            if (terminalEncountered || turnErrorToHandle || ctx.isCancelled || ctx.abortController.signal.aborted) {
              break;
            }

            if (hasResumedFromPause && currentTurnId && lastProcessedEventId) {
              hasResumedFromPause = false;
              this.log('stream:reconnect_subscribe', {
                runId: ctx.runId,
                turnId: currentTurnId,
                afterEventId: lastProcessedEventId,
              });
              turnStream = this.client.subscribeTurn(
                ctx.sessionId!,
                currentTurnId,
                {
                  afterEventId: lastProcessedEventId,
                  signal: ctx.abortController.signal,
                }
              );
            } else {
              break;
            }
          }
        } catch (streamErr: unknown) {
          if (ctx.isCancelled || ctx.abortController.signal.aborted) return;
          turnErrorToHandle = this.classifyError(streamErr);
        }

        if (ctx.isCancelled || ctx.abortController.signal.aborted) return;

        if (terminalEncountered) {
          await this.finalizeRun(ctx, terminalEncountered, 'turn_terminal');
          return;
        }

        if (turnErrorToHandle) {
          // Retry condition: retryable AND no side effects occurred in attempt AND retries remaining
          if (turnErrorToHandle.retryable && !sideEffectsOccurredInAttempt && attempt < this.resilience.maxRetries) {
            attempt++;
            const delayMs = this.resilience.getDelay(attempt);
            this.log('run:retry', { attempt, delayMs, kind: turnErrorToHandle.kind, stage: 'stream_turn' });
            ctx.queue.push({ type: 'retry', attempt, delayMs, kind: turnErrorToHandle.kind }, ctx.epoch);
            try {
              await this.resilience.sleep(delayMs, ctx.abortController.signal);
            } catch {
              await this.finalizeRun(ctx, { type: 'run.cancelled' }, 'cancelled_during_backoff');
              return;
            }
            continue;
          }

          const handled = await this.handleTurnError(ctx, turnErrorToHandle);
          if (!handled) return;
          attempt = 0;
          continue;
        }

        // Premature stream EOF without terminal event
        const eofClassified: ClassifiedError = {
          kind: 'unreachable',
          message: 'Stream ended prematurely without a terminal turn event',
          retryable: true,
          isTrueForgeDown: false,
        };

        if (!sideEffectsOccurredInAttempt && attempt < this.resilience.maxRetries) {
          attempt++;
          const delayMs = this.resilience.getDelay(attempt);
          this.log('run:retry', { attempt, delayMs, kind: 'unreachable', stage: 'stream_eof' });
          ctx.queue.push({ type: 'retry', attempt, delayMs, kind: 'unreachable' }, ctx.epoch);
          try {
            await this.resilience.sleep(delayMs, ctx.abortController.signal);
          } catch {
            await this.finalizeRun(ctx, { type: 'run.cancelled' }, 'cancelled_during_backoff');
            return;
          }
          continue;
        }

        const handled = await this.handleTurnError(ctx, eofClassified);
        if (!handled) return;
        attempt = 0;
      }
    } catch (err: unknown) {
      if (ctx.isCancelled || ctx.abortController.signal.aborted) {
        return;
      }
      const classified = this.classifyError(err);
      await this.finalizeRun(ctx, { type: 'run.failed', error: classified }, 'pump_error');
    }
  }

  /**
   * Evaluates failover eligibility when retries are exhausted or error is non-retryable.
   * Returns true if failover succeeded and loop should continue on fallback;
   * returns false if run was finalized with a terminal event.
   */
  private async handleTurnError(
    ctx: RunContext,
    classified: ClassifiedError
  ): Promise<boolean> {
    if (classified.isTrueForgeDown) {
      await this.finalizeRun(ctx, { type: 'run.failed', error: classified }, 'trueforge_down');
      return false;
    }

    if (ctx.profile === 'primary') {
      const anyApplied = this.anyHunkApplied || ctx.approvalBridge.anyHunkApplied;
      if (anyApplied) {
        // Row 4: no replay when hunks have already been applied
        const failure: ForgeError = {
          kind: classified.kind,
          message:
            'Changes already applied to workspace; failover replay disabled to prevent duplicate application.',
          retryable: false,
        };
        await this.finalizeRun(ctx, { type: 'run.failed', error: failure }, 'failover_prevented_by_applied_hunk');
        return false;
      }

      // Failover to fallback
      this.log('run:failover', {
        runId: ctx.runId,
        from: this.config.setup.agents.primary,
        to: this.config.setup.agents.fallback,
        reason: classified.kind,
      });

      // 1. Discard pending proposals
      const discarded = ctx.approvalBridge.getProposalStore().discardAll();
      for (const p of discarded) {
        ctx.queue.push({ type: 'proposal.discarded', proposalId: p.id, reason: 'failover' }, ctx.epoch);
      }

      // 2. Close old DecisionStore records
      if (ctx.sessionId) {
        ctx.approvalBridge.getDecisionStore().cancelSession(ctx.sessionId);
      }

      // 3. Bump run epoch so late primary events are ignored
      this.runEpoch++;
      ctx.epoch = this.runEpoch;

      // 4. Emit failover event BEFORE fallback streams
      ctx.queue.push(
        {
          type: 'failover',
          from: this.config.setup.agents.primary,
          to: this.config.setup.agents.fallback,
          reason: classified.kind,
        },
        ctx.epoch
      );

      // 5. Budget and context reset: reset meter, re-charge initial tokens, reset context items
      ctx.isBudgetLive = false;
      ctx.budget.reset();
      ctx.budget.charge(ctx.initialTokens);
      ctx.usedTokens = ctx.budget.getUsedTokens();
      const failoverLimit = this.config.setup.budgets.runToolBudgetTokens;
      ctx.queue.push(
        {
          type: 'budget',
          usedTokens: ctx.usedTokens,
          limitTokens: failoverLimit,
        },
        ctx.epoch
      );

      ctx.contextItems.clear();
      for (const item of ctx.seedContextItems) {
        ctx.contextItems.set(item.path, { ...item });
      }
      ctx.activeToolCalls.clear();

      if (ctx.mode === 'agent' && ctx.contextItems.size > 0) {
        ctx.queue.push(
          {
            type: 'context.report',
            items: Array.from(ctx.contextItems.values()),
          },
          ctx.epoch
        );
      }

      ctx.isBudgetLive = true;

      // 6. Switch context to fallback
      ctx.primaryFailure = classified;
      ctx.profile = 'fallback';
      ctx.modelId = this.config.models.profiles.fallback.modelId;
      ctx.sessionId = null;
      ctx.approvalBridge = new ApprovalBridge(this.host);
      ctx.mapperState = createEventMapperState();
      ctx.loopGuard.reset();

      return true;
    }

    // Fallback failed. If primary failed earlier, name both causes with token redacted per Row 5
    let combinedMsg: string;
    if (ctx.primaryFailure) {
      const primaryMsg = ctx.primaryFailure.message;
      const fallbackMsg = classified.message;
      combinedMsg = redactToken(
        `Primary agent (${this.config.setup.agents.primary}) failed: ${primaryMsg}. Fallback agent (${this.config.setup.agents.fallback}) failed: ${fallbackMsg}.`,
        this.config.setup.mcp.token
      );
    } else {
      combinedMsg = redactToken(classified.message, this.config.setup.mcp.token);
    }

    const dualError: ForgeError = {
      kind: classified.kind,
      message: combinedMsg,
      retryable: classified.retryable,
    };

    await this.finalizeRun(ctx, { type: 'run.failed', error: dualError }, 'fallback_failed');
    return false;
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
      ctx.budget.charge(promptTokens + textTokens);
      ctx.usedTokens = ctx.budget.getUsedTokens();

      const blocks: ContextBlock[] = [
        {
          path: inlineReq.path,
          reason: 'inline selection',
          range: inlineReq.range,
          text: inlineReq.selectedText,
        },
      ];
      let effectivePrompt = inlineReq.prompt;
      if (inlineReq.selectedText && inlineReq.selectedText.trim().length > 0) {
        effectivePrompt = `${inlineReq.prompt}\n\nThe selected code is provided, propose the edit directly with proposeEdit, do not search or read first.`;
      }
      return this.client.userMessageInput(effectivePrompt, blocks);
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
          const ci: ContextItem = {
            path: mention.path.replace(/\\/g, '/'),
            reason: `@${mention.label}`,
            tokens: estimatedTokens,
            source: 'mention',
          };
          ctx.seedContextItems.push(ci);
          ctx.contextItems.set(ci.path, ci);
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
          const ci: ContextItem = {
            path: mention.path.replace(/\\/g, '/'),
            reason: `@${mention.label} (truncated)`,
            tokens: actualTruncatedTokens,
            source: 'mention',
          };
          ctx.seedContextItems.push(ci);
          ctx.contextItems.set(ci.path, ci);
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
            const ci: ContextItem = {
              path: item.path.replace(/\\/g, '/'),
              reason: item.reason,
              tokens: actualTokens,
              source: 'auto',
              range: item.range,
            };
            ctx.seedContextItems.push(ci);
            ctx.contextItems.set(ci.path, ci);
          } catch {
            // Ignore individual file read failures for seed items
          }
        }
      }
    } catch (seedErr: unknown) {
      this.log('seed:error', { error: (seedErr as Error).message });
    }

    ctx.budget.charge(promptTokens);
    ctx.budget.chargeMentions(mentionsTokenCount);
    ctx.budget.chargeSeed(seedTokenCount);
    ctx.usedTokens = ctx.budget.getUsedTokens();

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
  private classifyError(err: unknown): ClassifiedError {
    return this.resilience.classify(err, this.config.setup.baseUrl);
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
