/**
 * RunBudget -- context token tracking, deduplication, and budget scaling (Milestone E-04).
 *
 * Enforces cumulative run budget caps (tokens estimated as chars/4),
 * seed/mention charging, identical query deduplication, 80% low-budget warnings,
 * and 100% budget exhaustion refusal per docs/04-CONTEXT-ENGINE.md and docs/01-ARCHITECTURE.md §3.
 */

import type { EngineEvent } from '../types/contract.ts';

/** Default token limits when unconfigured. */
export const DEFAULT_RUN_BUDGET_TOKENS = 30000;
export const DEFAULT_SEED_TOKENS = 3000;
export const DEFAULT_MENTIONS_TOKENS = 6000;
export const DEFAULT_MODEL_CONTEXT_TOKENS = 128000;

/** Fractions of modelContextTokens bounding effective limits. */
export const RUN_BUDGET_FRACTION = 0.25; // 25% of model context
export const SEED_BUDGET_FRACTION = 0.05; // 5% of model context
export const MENTIONS_BUDGET_FRACTION = 0.05; // 5% of model context

/** Threshold ratios for budget alerts. */
export const WARNING_THRESHOLD_RATIO = 0.8; // 80%
export const EXHAUSTION_THRESHOLD_RATIO = 1.0; // 100%

/** Exact message strings per docs/01 §3 and card E-04. */
export const DEDUPLICATION_NOTICE = 'already provided earlier in this run';
export const LOW_BUDGET_WARNING = 'budget low: wrap up';
export const BUDGET_EXHAUSTED_MESSAGE = 'budget exhausted: call reportContext then propose changes';

/**
 * Options for configuring RunBudget.
 */
export interface RunBudgetOptions {
  configuredRunLimit?: number;
  configuredSeedLimit?: number;
  configuredMentionsLimit?: number;
  modelContextTokens?: number;
  onBudgetChange?: (usedTokens: number, limitTokens: number) => void;
}

/**
 * Breakdown of configured vs effective scaled limits.
 */
export interface BudgetLimits {
  configuredRun: number;
  configuredSeed: number;
  configuredMentions: number;
  modelContextTokens: number;
  effectiveRun: number;
  effectiveSeed: number;
  effectiveMentions: number;
}

/**
 * Tracks cumulative context token usage, deduplicates repeated queries, and enforces caps.
 */
export class RunBudget {
  private readonly limits: BudgetLimits;
  private usedTokens = 0;
  private seedTokensCharged = 0;
  private mentionsTokensCharged = 0;
  private readonly seenQueries = new Set<string>();
  private readonly onBudgetChange?: (usedTokens: number, limitTokens: number) => void;

  constructor(options?: RunBudgetOptions) {
    const configuredRun = options?.configuredRunLimit ?? DEFAULT_RUN_BUDGET_TOKENS;
    const configuredSeed = options?.configuredSeedLimit ?? DEFAULT_SEED_TOKENS;
    const configuredMentions = options?.configuredMentionsLimit ?? DEFAULT_MENTIONS_TOKENS;
    const modelContextTokens = options?.modelContextTokens ?? DEFAULT_MODEL_CONTEXT_TOKENS;

    // Effective limits: min(configured, fraction * modelContextTokens)
    const effectiveRun = Math.floor(Math.min(configuredRun, RUN_BUDGET_FRACTION * modelContextTokens));
    const effectiveSeed = Math.floor(Math.min(configuredSeed, SEED_BUDGET_FRACTION * modelContextTokens));
    const effectiveMentions = Math.floor(Math.min(configuredMentions, MENTIONS_BUDGET_FRACTION * modelContextTokens));

    this.limits = {
      configuredRun,
      configuredSeed,
      configuredMentions,
      modelContextTokens,
      effectiveRun,
      effectiveSeed,
      effectiveMentions,
    };

    this.onBudgetChange = options?.onBudgetChange;
  }

  /**
   * Estimates token count from text using the canonical chars/4 formula.
   */
  public static estimateTokens(text: string): number {
    if (!text) {
      return 0;
    }
    return Math.ceil(text.length / 4);
  }

  /**
   * Generates a canonical deduplication cache key for readFile calls.
   */
  public static getReadFileKey(
    filePath: string,
    range?: { startLine: number; endLine: number }
  ): string {
    const normPath = filePath.toLowerCase().replace(/\\/g, '/');
    const rangePart = range ? `${range.startLine}-${range.endLine}` : 'all';
    return `readFile:${normPath}:${rangePart}`;
  }

  /**
   * Generates a canonical deduplication cache key for searchWorkspace calls.
   */
  public static getSearchKey(
    query: string,
    glob?: string,
    maxResults?: number
  ): string {
    const normQuery = query.toLowerCase().trim();
    const normGlob = (glob ?? '*').toLowerCase().trim();
    const limit = maxResults ?? 20;
    return `search:${normQuery}:${normGlob}:${limit}`;
  }

  /**
   * Returns a copy of the calculated budget limits.
   */
  public getLimits(): BudgetLimits {
    return { ...this.limits };
  }

  /**
   * Returns current cumulative tokens charged to the run budget.
   */
  public getUsedTokens(): number {
    return this.usedTokens;
  }

  /**
   * Returns the effective token limit for this run.
   */
  public getLimitTokens(): number {
    return this.limits.effectiveRun;
  }

  /**
   * Returns remaining tokens available before exhaustion.
   */
  public getRemainingTokens(): number {
    return Math.max(0, this.limits.effectiveRun - this.usedTokens);
  }

  /**
   * Returns true if cumulative token usage has reached or exceeded 100% of the effective run limit.
   */
  public isExhausted(): boolean {
    return this.usedTokens >= this.limits.effectiveRun;
  }

  /**
   * Returns true if cumulative token usage has reached or exceeded the 80% warning threshold (and not exhausted).
   */
  public isLow(): boolean {
    const warningThreshold = Math.floor(this.limits.effectiveRun * WARNING_THRESHOLD_RATIO);
    return this.usedTokens >= warningThreshold && !this.isExhausted();
  }

  /**
   * Creates an EngineEvent conforming to the contract v2.1.0 budget event shape.
   */
  public toEvent(): Extract<EngineEvent, { type: 'budget' }> {
    return {
      type: 'budget',
      usedTokens: this.usedTokens,
      limitTokens: this.limits.effectiveRun,
    };
  }

  /**
   * Charges raw tokens to the cumulative run budget and notifies listener.
   *
   * @param tokens - Number of tokens to charge
   * @returns Updated usedTokens count
   */
  public charge(tokens: number): number {
    if (tokens <= 0) {
      return this.usedTokens;
    }
    this.usedTokens += tokens;
    if (this.onBudgetChange) {
      this.onBudgetChange(this.usedTokens, this.limits.effectiveRun);
    }
    return this.usedTokens;
  }

  /**
   * Estimates tokens for a text string and charges them to the run budget.
   *
   * @param text - Text content to charge
   * @returns Tokens charged for this text
   */
  public chargeText(text: string): number {
    const tokens = RunBudget.estimateTokens(text);
    this.charge(tokens);
    return tokens;
  }

  /**
   * Charges seed context tokens against the run budget up to the effective seed limit.
   *
   * @param tokens - Seed context tokens to charge
   * @returns Actual tokens charged
   */
  public chargeSeed(tokens: number): number {
    const remaining = Math.max(0, this.limits.effectiveSeed - this.seedTokensCharged);
    const capped = Math.min(tokens, remaining);
    this.seedTokensCharged += capped;
    this.charge(capped);
    return capped;
  }

  /**
   * Charges mention tokens against the run budget up to the effective mentions limit.
   *
   * @param tokens - Mention tokens to charge
   * @returns Actual tokens charged
   */
  public chargeMentions(tokens: number): number {
    const remaining = Math.max(0, this.limits.effectiveMentions - this.mentionsTokensCharged);
    const capped = Math.min(tokens, remaining);
    this.mentionsTokensCharged += capped;
    this.charge(capped);
    return capped;
  }

  /**
   * Checks whether a query key was already recorded in this run.
   * If fresh, records the query in the seen cache.
   *
   * @param queryKey - Unique query signature
   * @returns Object indicating if duplicate and providing the standard deduplication notice
   */
  public checkDeduplication(queryKey: string): { isDuplicate: boolean; notice?: string } {
    if (this.seenQueries.has(queryKey)) {
      return { isDuplicate: true, notice: DEDUPLICATION_NOTICE };
    }
    this.seenQueries.add(queryKey);
    return { isDuplicate: false };
  }

  /**
   * Processes a tool query through deduplication and budget checks:
   * 1. If exhausted, returns exhaustion refusal immediately.
   * 2. If duplicate query, returns deduplication notice and charges only the notice tokens (~20 tokens).
   * 3. If fresh, calls the producer function, appends low-budget warning if >= 80%, and charges tokens.
   *
   * @param queryKey - Deduplication signature
   * @param executeQuery - Function producing the fresh tool result string
   * @returns Final result string and execution metadata
   */
  public async handleToolExecution(
    queryKey: string,
    executeQuery: () => Promise<string> | string
  ): Promise<{
    text: string;
    tokensCharged: number;
    isDuplicate: boolean;
    exhausted: boolean;
  }> {
    // 1. Refuse read tools when budget is exhausted
    if (this.isExhausted()) {
      return {
        text: BUDGET_EXHAUSTED_MESSAGE,
        tokensCharged: 0,
        isDuplicate: false,
        exhausted: true,
      };
    }

    // 2. Check deduplication for repeated identical queries
    const dedupe = this.checkDeduplication(queryKey);
    if (dedupe.isDuplicate) {
      const noticeTokens = this.chargeText(DEDUPLICATION_NOTICE);
      return {
        text: DEDUPLICATION_NOTICE,
        tokensCharged: noticeTokens,
        isDuplicate: true,
        exhausted: this.isExhausted(),
      };
    }

    // 3. Execute tool query
    const rawResult = await executeQuery();

    // 4. Append 80% low-budget warning if threshold is reached
    let finalText = rawResult;
    if (this.isLow()) {
      finalText = `${rawResult}\n\n[${LOW_BUDGET_WARNING}]`;
    }

    // 5. Charge tokens for the text entering the context
    const charged = this.chargeText(finalText);

    return {
      text: finalText,
      tokensCharged: charged,
      isDuplicate: false,
      exhausted: this.isExhausted(),
    };
  }

  /**
   * Resets the budget for a fresh run or a failover turn replay.
   * Clears used tokens, seed/mention counters, and the deduplication cache.
   */
  public reset(): void {
    this.usedTokens = 0;
    this.seedTokensCharged = 0;
    this.mentionsTokensCharged = 0;
    this.seenQueries.clear();
    if (this.onBudgetChange) {
      this.onBudgetChange(this.usedTokens, this.limits.effectiveRun);
    }
  }
}
