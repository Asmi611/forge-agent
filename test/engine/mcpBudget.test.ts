/**
 * Unit tests for RunBudget context token accounting and deduplication (Milestone E-04).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  RunBudget,
  DEFAULT_RUN_BUDGET_TOKENS,
  DEFAULT_SEED_TOKENS,
  DEFAULT_MENTIONS_TOKENS,
  DEFAULT_MODEL_CONTEXT_TOKENS,
  RUN_BUDGET_FRACTION,
  SEED_BUDGET_FRACTION,
  MENTIONS_BUDGET_FRACTION,
  DEDUPLICATION_NOTICE,
  LOW_BUDGET_WARNING,
  BUDGET_EXHAUSTED_MESSAGE,
} from '../../src/engine/budget.ts';

describe('RunBudget', () => {
  describe('constants', () => {
    it('defines expected fraction constants', () => {
      expect(RUN_BUDGET_FRACTION).toBe(0.25);
      expect(SEED_BUDGET_FRACTION).toBe(0.05);
      expect(MENTIONS_BUDGET_FRACTION).toBe(0.05);
    });
  });

  describe('initialization and scaling', () => {
    it('uses default limits with standard 128k model context', () => {
      const budget = new RunBudget();
      const limits = budget.getLimits();

      expect(limits.configuredRun).toBe(DEFAULT_RUN_BUDGET_TOKENS);
      expect(limits.configuredSeed).toBe(DEFAULT_SEED_TOKENS);
      expect(limits.configuredMentions).toBe(DEFAULT_MENTIONS_TOKENS);
      expect(limits.modelContextTokens).toBe(DEFAULT_MODEL_CONTEXT_TOKENS);

      // min(30000, 0.25 * 128000 = 32000) = 30000
      expect(limits.effectiveRun).toBe(30000);
      // min(3000, 0.05 * 128000 = 6400) = 3000
      expect(limits.effectiveSeed).toBe(3000);
      // min(6000, 0.05 * 128000 = 6400) = 6000
      expect(limits.effectiveMentions).toBe(6000);

      expect(budget.getUsedTokens()).toBe(0);
      expect(budget.getLimitTokens()).toBe(30000);
      expect(budget.getRemainingTokens()).toBe(30000);
      expect(budget.isExhausted()).toBe(false);
      expect(budget.isLow()).toBe(false);
    });

    it('scales down effective limits for a small local model (e.g. 8000 context window)', () => {
      const budget = new RunBudget({
        configuredRunLimit: 30000,
        configuredSeedLimit: 3000,
        configuredMentionsLimit: 6000,
        modelContextTokens: 8000,
      });
      const limits = budget.getLimits();

      // min(30000, 0.25 * 8000 = 2000) = 2000
      expect(limits.effectiveRun).toBe(2000);
      // min(3000, 0.05 * 8000 = 400) = 400
      expect(limits.effectiveSeed).toBe(400);
      // min(6000, 0.05 * 8000 = 400) = 400
      expect(limits.effectiveMentions).toBe(400);

      expect(budget.getLimitTokens()).toBe(2000);
      expect(budget.getRemainingTokens()).toBe(2000);
    });

    it('scales down effective limits for a 16000 context window model', () => {
      const budget = new RunBudget({
        modelContextTokens: 16000,
      });
      const limits = budget.getLimits();

      // 0.25 * 16000 = 4000
      expect(limits.effectiveRun).toBe(4000);
      // 0.05 * 16000 = 800
      expect(limits.effectiveSeed).toBe(800);
      expect(limits.effectiveMentions).toBe(800);
    });
  });

  describe('token estimation', () => {
    it('estimates tokens as Math.ceil(chars / 4)', () => {
      expect(RunBudget.estimateTokens('')).toBe(0);
      expect(RunBudget.estimateTokens('abcd')).toBe(1);
      expect(RunBudget.estimateTokens('abcde')).toBe(2);
      expect(RunBudget.estimateTokens('1234567890123456')).toBe(4);
    });
  });

  describe('charging seed and mentions', () => {
    it('charges seed context tokens up to effective seed limit', () => {
      const budget = new RunBudget({
        configuredSeedLimit: 3000,
        modelContextTokens: 8000, // effective seed limit = 400
      });

      const charged = budget.chargeSeed(300);
      expect(charged).toBe(300);
      expect(budget.getUsedTokens()).toBe(300);

      // Attempt to charge more than remaining effective seed
      const secondCharge = budget.chargeSeed(200);
      expect(secondCharge).toBe(100); // capped at remaining 100 to reach 400
      expect(budget.getUsedTokens()).toBe(400);
    });

    it('charges mentions tokens up to effective mentions limit', () => {
      const budget = new RunBudget({
        configuredMentionsLimit: 6000,
        modelContextTokens: 8000, // effective mentions limit = 400
      });

      const charged = budget.chargeMentions(500);
      expect(charged).toBe(400); // capped at effective limit of 400
      expect(budget.getUsedTokens()).toBe(400);
    });
  });

  describe('deduplication of repeat queries', () => {
    it('generates consistent cache keys for readFile', () => {
      const key1 = RunBudget.getReadFileKey('src/main.ts');
      const key2 = RunBudget.getReadFileKey('SRC\\MAIN.TS');
      expect(key1).toBe('readFile:src/main.ts:all');
      expect(key2).toBe('readFile:src/main.ts:all');

      const rangeKey = RunBudget.getReadFileKey('src/main.ts', { startLine: 10, endLine: 20 });
      expect(rangeKey).toBe('readFile:src/main.ts:10-20');
    });

    it('generates consistent cache keys for searchWorkspace', () => {
      const key1 = RunBudget.getSearchKey('findMe', '*.ts', 10);
      const key2 = RunBudget.getSearchKey('  findme ', '*.TS', 10);
      expect(key1).toBe('search:findme:*.ts:10');
      expect(key2).toBe('search:findme:*.ts:10');
    });

    it('returns duplicate notice for repeated identical queries and charges only notice tokens', async () => {
      const budget = new RunBudget();
      const queryKey = RunBudget.getReadFileKey('src/utils.ts');
      let executionCount = 0;

      const producer = async () => {
        executionCount++;
        return 'export function calculate(): number { return 42; }';
      };

      // 1. First execution: fresh
      const first = await budget.handleToolExecution(queryKey, producer);
      expect(first.isDuplicate).toBe(false);
      expect(first.text).toContain('calculate');
      expect(executionCount).toBe(1);
      const initialTokens = budget.getUsedTokens();
      expect(initialTokens).toBeGreaterThan(10);

      // 2. Second execution with identical key: deduplicated
      const second = await budget.handleToolExecution(queryKey, producer);
      expect(second.isDuplicate).toBe(true);
      expect(second.text).toBe(DEDUPLICATION_NOTICE);
      expect(executionCount).toBe(1); // Producer was NOT executed again!

      const noticeTokens = RunBudget.estimateTokens(DEDUPLICATION_NOTICE);
      expect(budget.getUsedTokens()).toBe(initialTokens + noticeTokens);
    });

    it('executes fresh query when arguments differ', async () => {
      const budget = new RunBudget();
      let count = 0;
      const producer = async () => {
        count++;
        return 'result';
      };

      const keyA = RunBudget.getReadFileKey('src/a.ts');
      const keyB = RunBudget.getReadFileKey('src/b.ts');

      await budget.handleToolExecution(keyA, producer);
      await budget.handleToolExecution(keyB, producer);

      expect(count).toBe(2);
    });
  });

  describe('thresholds: 80% low-budget warning and 100% exhaustion', () => {
    it('appends budget low warning when token usage reaches 80%', async () => {
      // effectiveRun = 1000 tokens; warning threshold = 800 tokens
      const budget = new RunBudget({
        configuredRunLimit: 1000,
        modelContextTokens: 100000,
      });

      // Charge 850 tokens (85% > 80%)
      budget.charge(850);
      expect(budget.isLow()).toBe(true);
      expect(budget.isExhausted()).toBe(false);

      const res = await budget.handleToolExecution('search:test:*:20', async () => 'found 1 hit');
      expect(res.text).toContain('found 1 hit');
      expect(res.text).toContain(LOW_BUDGET_WARNING);
    });

    it('refuses read tools when budget reaches 100% exhaustion', async () => {
      // effectiveRun = 1000 tokens
      const budget = new RunBudget({
        configuredRunLimit: 1000,
        modelContextTokens: 100000,
      });

      budget.charge(1000);
      expect(budget.isExhausted()).toBe(true);
      expect(budget.isLow()).toBe(false); // isLow is false once exhausted

      let toolExecuted = false;
      const res = await budget.handleToolExecution('readFile:src/a.ts:all', async () => {
        toolExecuted = true;
        return 'file content';
      });

      expect(toolExecuted).toBe(false);
      expect(res.exhausted).toBe(true);
      expect(res.tokensCharged).toBe(0);
      expect(res.text).toBe(BUDGET_EXHAUSTED_MESSAGE);
    });
  });

  describe('reset behavior', () => {
    it('resets used tokens, counters, and query deduplication cache', async () => {
      const budget = new RunBudget({ configuredRunLimit: 1000 });
      const queryKey = 'readFile:src/code.ts:all';

      budget.chargeSeed(200);
      budget.chargeMentions(200);
      await budget.handleToolExecution(queryKey, async () => 'content');

      expect(budget.getUsedTokens()).toBeGreaterThan(400);

      // Verify deduplication is active
      const dupCheck = budget.checkDeduplication(queryKey);
      expect(dupCheck.isDuplicate).toBe(true);

      // Reset budget (e.g. for failover turn replay)
      budget.reset();

      expect(budget.getUsedTokens()).toBe(0);
      expect(budget.getRemainingTokens()).toBe(1000);
      expect(budget.isExhausted()).toBe(false);

      // Query can now be executed fresh again
      const postResetCheck = budget.checkDeduplication(queryKey);
      expect(postResetCheck.isDuplicate).toBe(false);
    });
  });

  describe('event generation and change callbacks', () => {
    it('notifies onBudgetChange callback on charge and reset', () => {
      const callback = vi.fn();
      const budget = new RunBudget({
        configuredRunLimit: 5000,
        modelContextTokens: 100000,
        onBudgetChange: callback,
      });

      budget.charge(150);
      expect(callback).toHaveBeenCalledWith(150, 5000);

      budget.chargeText('1234567890123456'); // 16 chars = 4 tokens
      expect(callback).toHaveBeenCalledWith(154, 5000);

      budget.reset();
      expect(callback).toHaveBeenCalledWith(0, 5000);
    });

    it('generates contract-compliant budget event', () => {
      const budget = new RunBudget({
        configuredRunLimit: 10000,
        modelContextTokens: 100000,
      });
      budget.charge(2500);

      const event = budget.toEvent();
      expect(event).toEqual({
        type: 'budget',
        usedTokens: 2500,
        limitTokens: 10000,
      });
    });
  });
});
