/**
 * Pure loop guard detecting infinite loops, repetition, and runaway agent turns (Milestone E-07a).
 *
 * Tracks tool invocations in memory without I/O or VS Code dependencies.
 * Triggers when identical calls repeat 3 times, total calls exceed maxToolCalls,
 * or elapsed run time exceeds maxRunSeconds.
 */

/** Canonical stop message emitted when loop guard terminates a run. */
export const LOOP_GUARD_STOP_MESSAGE =
  'The agent seems stuck (repeating the same step). Stopped safely.';

/** Configuration options for LoopGuard. */
export interface LoopGuardOptions {
  /** Maximum number of tool calls permitted per run before stopping (default: 40). */
  maxToolCalls?: number;
  /** Maximum wall-clock seconds permitted per run before stopping (default: 300). */
  maxRunSeconds?: number;
  /** Number of identical (toolName, args) invocations that triggers a stop (default: 3). */
  repeatThreshold?: number;
  /** Optional clock function returning epoch milliseconds (default: Date.now). */
  clock?: () => number;
}

/** Result returned when loop guard allows execution to continue. */
export interface LoopGuardContinue {
  stop: false;
}

/** Result returned when loop guard halts execution due to a policy limit. */
export interface LoopGuardStop {
  stop: true;
  reason: string;
  trigger?: 'repeat' | 'call_limit' | 'time_limit';
}

/** Discriminated union outcome returned by LoopGuard.record(). */
export type LoopGuardResult = LoopGuardContinue | LoopGuardStop;

/** Recursively sorts object keys for deterministic, order-insensitive canonical JSON comparison. */
function canonicalize(val: unknown): unknown {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(canonicalize);
  }
  const obj = val as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    if (obj[key] !== undefined) {
      result[key] = canonicalize(obj[key]);
    }
  }
  return result;
}

/** Produces order-insensitive canonical JSON string for tool arguments. */
export function canonicalizeArgs(args: unknown): string {
  try {
    return JSON.stringify(canonicalize(args)) ?? '';
  } catch {
    return String(args);
  }
}

/**
 * Pure stateful loop guard tracking tool invocations within a single run.
 */
export class LoopGuard {
  private readonly maxToolCalls: number;
  private readonly maxRunSeconds: number;
  private readonly repeatThreshold: number;
  private readonly clock: () => number;

  private startTime: number;
  private totalCalls = 0;
  private readonly callCounts = new Map<string, number>();

  /**
   * Constructs a new LoopGuard with optional limit overrides and injectable clock.
   *
   * @param options - Configuration options for limits and clock
   */
  constructor(options?: LoopGuardOptions) {
    this.maxToolCalls = options?.maxToolCalls ?? 40;
    this.maxRunSeconds = options?.maxRunSeconds ?? 300;
    this.repeatThreshold = options?.repeatThreshold ?? 3;
    this.clock = options?.clock ?? (() => Date.now());
    this.startTime = this.clock();
  }

  /**
   * Records a tool call invocation and evaluates loop guard policies.
   *
   * @param toolName - Name of the tool being called
   * @param args - Tool arguments (evaluated in an order-insensitive manner)
   * @returns LoopGuardResult indicating whether to continue or stop with a reason
   */
  public record(toolName: string, args: unknown): LoopGuardResult {
    // 1. Check elapsed wall-clock time limit
    const now = this.clock();
    const elapsedSeconds = (now - this.startTime) / 1000;
    if (elapsedSeconds > this.maxRunSeconds) {
      return {
        stop: true,
        reason: LOOP_GUARD_STOP_MESSAGE,
        trigger: 'time_limit',
      };
    }

    // 2. Increment total tool calls and check call limit
    this.totalCalls++;
    if (this.totalCalls > this.maxToolCalls) {
      return {
        stop: true,
        reason: LOOP_GUARD_STOP_MESSAGE,
        trigger: 'call_limit',
      };
    }

    // 3. Check identical (toolName, canonicalArgs) repetition threshold
    const key = `${toolName}\0${canonicalizeArgs(args)}`;
    const count = (this.callCounts.get(key) ?? 0) + 1;
    this.callCounts.set(key, count);

    if (count >= this.repeatThreshold) {
      return {
        stop: true,
        reason: LOOP_GUARD_STOP_MESSAGE,
        trigger: 'repeat',
      };
    }

    return { stop: false };
  }

  /**
   * Resets all invocation counts, call history, and the elapsed timer.
   */
  public reset(): void {
    this.totalCalls = 0;
    this.callCounts.clear();
    this.startTime = this.clock();
  }

  /** Current count of total tool calls recorded in this guard cycle. */
  public get totalCallCount(): number {
    return this.totalCalls;
  }
}
