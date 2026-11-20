/**
 * resilience.test.ts -- Unit and hermetic integration tests for Resilience (Milestone E-09).
 *
 * Covers:
 * 1. ResilienceManager unit tests:
 *    - Duration parsing from composite & standard formats
 *    - Quota exceeded detection (message phrases & >60s retry times)
 *    - Backoff delay computation & positive jitter
 *    - Error classification across wire HTTP shapes, SSE turn.done error states,
 *      NetworkErrors, and wire fixtures (05-model-404.jsonl, 05-model-timeout.jsonl)
 * 2. Token redaction utility
 * 3. SessionOrchestrator deterministic outcome table tests (Rows 1 - 6b):
 *    - Row 1: Primary fails while streaming, nothing proposed -> retry with backoff, failover to fallback
 *    - Row 2: Primary fails after proposeEdit called -> proposals discarded ('failover'), records closed, failover
 *    - Row 3: Approval pause, all hunks rejected (0 applied) -> failover permitted on resume failure
 *    - Row 4: Approval pause, >=1 hunk applied -> failover replay prevented, run.failed explaining changes applied
 *    - Row 5: Primary and fallback both fail -> single run.failed naming both causes with token redacted
 *    - Row 6: User cancels during retry backoff -> timer cancelled, run.cancelled
 *    - Row 6b: User cancels during failover -> run.cancelled
 *    - Quota 429 -> immediate failover without retries
 *    - Short 429 -> retried with backoff
 *    - TrueForge down -> no failover, run.failed telling user to start TrueForge
 *    - Side-effects guard -> tool.call emitted skips retries and triggers failover
 *    - Inline instruction -> appended only when selectedText is provided
 */

import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  ResilienceManager,
  parseDurationSeconds,
  isQuotaExceeded,
  computeBackoffDelay,
  redactToken,
  isInvalidApiKeyError,
} from '../../src/engine/ResilienceManager.ts';
import {
  ForgeClient,
  HttpError,
  NetworkError,
  type RawEvent,
} from '../../src/engine/ForgeClient.ts';
import { SessionOrchestrator } from '../../src/engine/SessionOrchestrator.ts';
import type { EngineConfig } from '../../src/engine/config.ts';
import type { UiHost, EngineEvent } from '../../src/types/contract.ts';

function createMockConfig(): EngineConfig {
  return {
    setup: {
      baseUrl: 'http://127.0.0.1:8790',
      isLoopback: true,
      rejectedNonLoopback: false,
      agents: {
        primary: 'primary-agent',
        fallback: 'fallback-agent',
      },
      mcp: {
        name: 'test-mcp',
        perWorkspace: false,
        port: 8792,
        path: '/mcp',
        token: 'super-secret-mcp-token-xyz',
      },
      budgets: {
        seedTokens: 3000,
        mentionsTokens: 6000,
        runToolBudgetTokens: 30000,
        maxToolCalls: 40,
        maxRunSeconds: 300,
      },
      retry: {
        max: 3,
        baseDelayMs: 1000,
      },
    },
    models: {
      profiles: {
        primary: {
          agent: 'primary-agent',
          provider: 'test-provider',
          modelId: 'primary-model-id',
          kind: 'primary',
          modelContextTokens: 32000,
        },
        fallback: {
          agent: 'fallback-agent',
          provider: 'test-provider',
          modelId: 'fallback-model-id',
          kind: 'fallback',
          modelContextTokens: 32000,
        },
      },
    },
  };
}

function createMockHost(): UiHost {
  return {
    workspaceRoot: path.resolve(process.cwd()),
    isWorkspaceTrusted: () => true,
    context: {
      resolveMention: async () => null,
      seed: async () => [],
      search: async () => ({ hits: [], omitted: 0 }),
      findSymbol: async () => ({ symbols: [] }),
      repoMap: async () => ({ tree: '', truncated: false }),
    },
    snapshot: async (p: string) => ({
      path: p,
      exists: true,
      text: 'snapshot text',
      version: 1,
      isDirty: false,
      contentHash: 'hash',
    }),
    readFile: async (_p: string) => 'mock file content',
    runCommand: async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      killed: false,
    }),
    confirmCommand: async () => true,
  };
}

describe('ResilienceManager - Pure Unit Tests', () => {
  describe('parseDurationSeconds', () => {
    it('parses composite duration formats like 5h1m8.7s', () => {
      const parsed = parseDurationSeconds('Rate limit exceeded: retry in 5h1m8.7s');
      expect(parsed).toBeCloseTo(5 * 3600 + 1 * 60 + 8.7, 1);
    });

    it('parses hours and minutes composite like 1h30m', () => {
      const parsed = parseDurationSeconds('Quota exceeded. Try again in 1h30m.');
      expect(parsed).toBe(5400);
    });

    it('parses minutes and seconds like 2m10s', () => {
      const parsed = parseDurationSeconds('retry-after: 2m10s');
      expect(parsed).toBe(130);
    });

    it('parses decimal seconds like 65.5s', () => {
      const parsed = parseDurationSeconds('Please retry in 65.5s');
      expect(parsed).toBe(65.5);
    });

    it('parses integer seconds like 120s and plain numbers with retry-after', () => {
      expect(parseDurationSeconds('retry in 120s')).toBe(120);
      expect(parseDurationSeconds('retry-after: 45')).toBe(45);
      expect(parseDurationSeconds('wait: 30 seconds')).toBe(30);
    });

    it('returns null for non-duration strings or empty inputs', () => {
      expect(parseDurationSeconds('')).toBeNull();
      expect(parseDurationSeconds('Internal Server Error')).toBeNull();
      expect(parseDurationSeconds(null as unknown as string)).toBeNull();
    });
  });

  describe('isQuotaExceeded', () => {
    it('detects explicit quota phrases in error messages', () => {
      expect(isQuotaExceeded(429, 'You exceeded your current quota, please check your plan')).toBe(true);
      expect(isQuotaExceeded(429, 'Rate limit exceeded: 5 requests per day allowed')).toBe(true);
      expect(isQuotaExceeded(429, 'daily quota reached')).toBe(true);
      expect(isQuotaExceeded(429, 'Monthly quota exhausted')).toBe(true);
    });

    it('detects rate limits with duration > 60 seconds as quota exhaustion', () => {
      expect(isQuotaExceeded(429, 'Rate limit reached. Retry in 65s')).toBe(true);
      expect(isQuotaExceeded(429, 'Rate limit exceeded, retry in 5h1m8.7s')).toBe(true);
      expect(isQuotaExceeded(429, 'retry-after: 120')).toBe(true);
    });

    it('returns false for transient rate limits with duration <= 60 seconds', () => {
      expect(isQuotaExceeded(429, 'Rate limit reached. Please retry after 2s')).toBe(false);
      expect(isQuotaExceeded(429, 'Too many requests, wait: 10s')).toBe(false);
      expect(isQuotaExceeded(429, 'retry in 60s')).toBe(false);
    });
  });

  describe('computeBackoffDelay', () => {
    it('computes exact powers of 2 when jitter is false', () => {
      expect(computeBackoffDelay(1, 1000, false)).toBe(1000);
      expect(computeBackoffDelay(2, 1000, false)).toBe(2000);
      expect(computeBackoffDelay(3, 1000, false)).toBe(4000);
      expect(computeBackoffDelay(4, 1000, false)).toBe(8000);
    });

    it('adds uniform positive jitter up to +20%', () => {
      for (let i = 0; i < 50; i++) {
        const delay = computeBackoffDelay(1, 1000, true);
        expect(delay).toBeGreaterThanOrEqual(1000);
        expect(delay).toBeLessThanOrEqual(1200);
      }
    });
  });

  describe('redactToken', () => {
    it('replaces all occurrences of sensitive token with [REDACTED]', () => {
      const raw = 'Failed to connect using token secret-token-12345 to endpoint with secret-token-12345';
      expect(redactToken(raw, 'secret-token-12345')).toBe(
        'Failed to connect using token [REDACTED] to endpoint with [REDACTED]'
      );
    });

    it('returns original text if token is undefined or empty', () => {
      expect(redactToken('normal message', undefined)).toBe('normal message');
      expect(redactToken('normal message', '   ')).toBe('normal message');
    });
  });

  describe('isInvalidApiKeyError', () => {
    it('detects invalid api key phrases case-insensitively', () => {
      expect(isInvalidApiKeyError('API key not valid. Please pass a valid API key.')).toBe(true);
      expect(isInvalidApiKeyError('error: api key not valid')).toBe(true);
      expect(isInvalidApiKeyError('INVALID API KEY provided')).toBe(true);
      expect(isInvalidApiKeyError('Error code: API_KEY_INVALID')).toBe(true);
      expect(isInvalidApiKeyError('status: invalid_api_key')).toBe(true);
    });

    it('returns false for generic errors and bad parameters', () => {
      expect(isInvalidApiKeyError('invalid parameter: max_tokens')).toBe(false);
      expect(isInvalidApiKeyError('bad request: missing prompt')).toBe(false);
      expect(isInvalidApiKeyError('Internal server error')).toBe(false);
    });

    it('safely returns false for non-string, null, or undefined values without throwing', () => {
      expect(isInvalidApiKeyError(undefined)).toBe(false);
      expect(isInvalidApiKeyError(null)).toBe(false);
      expect(isInvalidApiKeyError(123)).toBe(false);
      expect(isInvalidApiKeyError({})).toBe(false);
      expect(isInvalidApiKeyError('')).toBe(false);
      expect(isInvalidApiKeyError('   ')).toBe(false);
    });
  });

  describe('classifyError wire shapes', () => {
    const resilience = new ResilienceManager();
    const baseUrl = 'http://127.0.0.1:8790';

    it('classifies fixture 05-model-404.jsonl as model error, non-retryable', () => {
      const fixturePath = path.resolve(process.cwd(), 'fixtures/events/05-model-404.jsonl');
      const lines = fs.readFileSync(fixturePath, 'utf8').trim().split('\n');
      const doneEvent = JSON.parse(lines[2]);
      const classified = resilience.classify(doneEvent.data.state.message, baseUrl);

      expect(classified.kind).toBe('model');
      expect(classified.retryable).toBe(false);
      expect(classified.isTrueForgeDown).toBe(false);
    });

    it('classifies fixture 05-model-timeout.jsonl as timeout error, retryable', () => {
      const fixturePath = path.resolve(process.cwd(), 'fixtures/events/05-model-timeout.jsonl');
      const lines = fs.readFileSync(fixturePath, 'utf8').trim().split('\n');
      const doneEvent = JSON.parse(lines[2]);
      const classified = resilience.classify(doneEvent.data.state.message, baseUrl);

      expect(classified.kind).toBe('timeout');
      expect(classified.retryable).toBe(true);
      expect(classified.isTrueForgeDown).toBe(false);
    });

    it('classifies TrueForge down when NetworkError is connection refused on baseUrl', () => {
      const cause = new Error('connect ECONNREFUSED 127.0.0.1:8790');
      const netErr = new NetworkError('ECONNREFUSED', cause, 'Request to POST /api/v1/sessions failed: fetch failed');
      const classified = resilience.classify(netErr, baseUrl);

      expect(classified.kind).toBe('unreachable');
      expect(classified.retryable).toBe(false);
      expect(classified.isTrueForgeDown).toBe(true);
      expect(classified.message).toContain('TrueForge is down');
      expect(classified.message).toContain('npx @truefoundry/trueforge@latest');
    });

    it('classifies transient NetworkError not targeting baseUrl as unreachable and retryable', () => {
      const cause = new Error('Connection reset by peer');
      const netErr = new NetworkError('ECONNRESET', cause, 'Network error [ECONNRESET]: Connection reset by peer');
      const classified = resilience.classify(netErr, baseUrl);

      expect(classified.kind).toBe('unreachable');
      expect(classified.retryable).toBe(true);
      expect(classified.isTrueForgeDown).toBe(false);
    });

    it('classifies HttpError 401 and 403 as auth and non-retryable', () => {
      const err401 = new HttpError(401, 'Unauthorized');
      const classified401 = resilience.classify(err401, baseUrl);
      expect(classified401.kind).toBe('auth');
      expect(classified401.retryable).toBe(false);

      const err403 = new HttpError(403, 'Forbidden');
      const classified403 = resilience.classify(err403, baseUrl);
      expect(classified403.kind).toBe('auth');
      expect(classified403.retryable).toBe(false);
    });

    it('classifies HttpError 400 with invalid API key as auth and non-retryable', () => {
      // Gemini provider error shape
      const gemini400 = new HttpError(400, 'API key not valid. Please pass a valid API key.');
      const classifiedGemini = resilience.classify(gemini400, baseUrl);
      expect(classifiedGemini.kind).toBe('auth');
      expect(classifiedGemini.retryable).toBe(false);
      expect(classifiedGemini.status).toBe(400);

      // Alternate provider phrasing
      const alt400 = new HttpError(400, 'Invalid API_KEY_INVALID provided');
      const classifiedAlt = resilience.classify(alt400, baseUrl);
      expect(classifiedAlt.kind).toBe('auth');
      expect(classifiedAlt.retryable).toBe(false);
    });

    it('keeps generic HttpError 400 (e.g. invalid parameter) as unknown and non-retryable', () => {
      const err400Param = new HttpError(400, 'Invalid argument: max_tokens must be positive');
      const classified = resilience.classify(err400Param, baseUrl);
      expect(classified.kind).toBe('unknown');
      expect(classified.retryable).toBe(false);
      expect(classified.status).toBe(400);
    });

    it('classifies string/turn.done error with invalid API key as auth and non-retryable', () => {
      const strErr = '[model error] 400 API key not valid. Please pass a valid API key.';
      const classified = resilience.classify(strErr, baseUrl);
      expect(classified.kind).toBe('auth');
      expect(classified.retryable).toBe(false);
    });

    it('keeps generic string error with 400 invalid parameter as unknown', () => {
      const strErr = '400 Invalid argument: max_tokens';
      const classified = resilience.classify(strErr, baseUrl);
      expect(classified.kind).toBe('unknown');
      expect(classified.retryable).toBe(false);
    });

    it('classifies HttpError 404 as model and non-retryable', () => {
      const err404 = new HttpError(404, 'Model not found');
      const classified404 = resilience.classify(err404, baseUrl);
      expect(classified404.kind).toBe('model');
      expect(classified404.retryable).toBe(false);
    });

    it('classifies HttpError 429 quota exhaustion as non-retryable rate_limit', () => {
      const err429 = new HttpError(429, 'You exceeded your current quota');
      const classified = resilience.classify(err429, baseUrl);
      expect(classified.kind).toBe('rate_limit');
      expect(classified.retryable).toBe(false);
    });

    it('classifies HttpError 429 transient as retryable rate_limit with retryAfterSeconds', () => {
      const err429 = new HttpError(429, 'Rate limit reached, retry in 5s');
      const classified = resilience.classify(err429, baseUrl);
      expect(classified.kind).toBe('rate_limit');
      expect(classified.retryable).toBe(true);
      expect(classified.retryAfterSeconds).toBe(5);
    });

    it('classifies HttpError 500, 502, 503 as model and retryable', () => {
      for (const status of [500, 502, 503]) {
        const err = new HttpError(status, 'Server error');
        const classified = resilience.classify(err, baseUrl);
        expect(classified.kind).toBe('model');
        expect(classified.retryable).toBe(true);
      }
    });

    it('classifies HttpError 408 and 504 as timeout and retryable', () => {
      for (const status of [408, 504]) {
        const err = new HttpError(status, 'Gateway timeout');
        const classified = resilience.classify(err, baseUrl);
        expect(classified.kind).toBe('timeout');
        expect(classified.retryable).toBe(true);
      }
    });
  });
});

describe('SessionOrchestrator - Deterministic Outcome Table (V2.3.5)', () => {
  it('Row 1: Primary fails while streaming, nothing proposed yet -> retries with backoff, fails over to fallback, and replays turn input', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    let sessionCalls = 0;
    vi.spyOn(client, 'createSession').mockImplementation(async (agentName) => {
      sessionCalls++;
      return agentName === 'primary-agent' ? 'sess-primary-1' : 'sess-fallback-1';
    });

    let turnAttempt = 0;
    const replayInputs: unknown[][] = [];
    vi.spyOn(client, 'createTurn').mockImplementation((sessionId, input) => {
      turnAttempt++;
      replayInputs.push(input as unknown[]);

      if (sessionId === 'sess-primary-1') {
        // Stream fails with 500
        async function* failingStream() {
          yield {
            id: '1',
            event: 'message',
            data: { type: 'model.message.delta', id: 'm1', content: 'partial text' },
            rawData: '',
          } as RawEvent;
          throw new HttpError(500, 'Model 500 error');
        }
        return failingStream();
      }

      // Fallback succeeds
      async function* fallbackStream() {
        yield {
          id: '1',
          event: 'message',
          data: { type: 'model.message.delta', id: 'm2', content: 'fallback response' },
          rawData: '',
        } as RawEvent;
        yield {
          id: '2',
          event: 'message',
          data: {
            type: 'turn.done',
            id: 't_done',
            state: { status: 'done', output: 'All done on fallback' },
          },
          rawData: '',
        } as RawEvent;
      }
      return fallbackStream();
    });

    const sleepCalls: number[] = [];
    const mockSleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    const resilienceManager = new ResilienceManager({
      maxRetries: 3,
      baseDelayMs: 100,
      sleep: mockSleep,
      jitter: false,
    });

    const orchestrator = new SessionOrchestrator(host, client, config, {
      resilienceManager,
      sleep: mockSleep,
      jitter: false,
    });

    const events: EngineEvent[] = [];
    for await (const ev of orchestrator.runAgent({ prompt: 'test row 1', mentions: [] })) {
      events.push(ev);
    }

    // Verify retries occurred on primary (3 retries = 100, 200, 400 ms)
    expect(sleepCalls).toEqual([100, 200, 400]);

    // Verify retry events emitted
    const retryEvents = events.filter((e) => e.type === 'retry');
    expect(retryEvents.length).toBe(3);

    // Verify failover event emitted before fallback streamed
    const failoverIdx = events.findIndex((e) => e.type === 'failover');
    expect(failoverIdx).toBeGreaterThan(0);
    const failoverEv = events[failoverIdx] as { type: 'failover'; from: string; to: string; reason: string };
    expect(failoverEv.from).toBe('primary-agent');
    expect(failoverEv.to).toBe('fallback-agent');
    expect(failoverEv.reason).toBe('model');

    // Verify budget event was re-emitted on failover
    expect(events[failoverIdx + 1]?.type).toBe('budget');

    // Verify turn completed on fallback
    const lastEvent = events[events.length - 1];
    expect(lastEvent).toEqual({
      type: 'run.completed',
      summary: 'All done on fallback',
    });

    // Verify original turn input was replayed on fallback
    expect(replayInputs.length).toBe(5); // 1 initial + 3 retries on primary + 1 on fallback
    expect(replayInputs[4]).toEqual(replayInputs[0]);
  });

  it('Row 2: Primary fails after proposeEdit called but before review pause -> discards proposals (failover) and replays on fallback', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    const orchestrator = new SessionOrchestrator(host, client, config, {
      sleep: async () => {},
      jitter: false,
    });

    vi.spyOn(client, 'createSession').mockImplementation(async (agentName) => {
      return agentName === 'primary-agent' ? 'sess-primary-2' : 'sess-fallback-2';
    });

    vi.spyOn(client, 'createTurn').mockImplementation((sessionId) => {
      if (sessionId === 'sess-primary-2') {
        async function* streamWithEdit() {
          // Register proposal in active run's ProposalStore
          const ctxBridge = (
            orchestrator as unknown as { activeContext: { approvalBridge: { getProposalStore: () => any } } }
          ).activeContext.approvalBridge;
          ctxBridge.getProposalStore().addOrGroup(
            {
              callId: 'call_pe',
              path: 'src/row2.ts',
              isNewFile: false,
              base: { contentHash: 'hash', version: 1, wasDirty: false },
              originalContent: 'before\n',
              proposedContent: 'after\n',
              rationale: 'row 2 edit',
            },
            'proposeEdit',
            [{ oldText: 'before', newText: 'after' }]
          );

          yield {
            id: '1',
            event: 'message',
            data: {
              type: 'model.message.delta',
              id: 'msg_pe',
              finish_reason: 'tool_calls',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_pe',
                  type: 'function',
                  function: {
                    name: 'proposeEdit',
                    arguments: JSON.stringify({
                      path: 'src/row2.ts',
                      edits: [{ oldText: 'before', newText: 'after' }],
                      rationale: 'row 2 edit',
                    }),
                  },
                },
              ],
            },
            rawData: '',
          } as RawEvent;
          // Fail before approval pause is shown
          throw new HttpError(500, 'Crash after proposeEdit');
        }
        return streamWithEdit();
      }

      // Fallback succeeds
      async function* fallbackStream() {
        yield {
          id: '2',
          event: 'message',
          data: {
            type: 'turn.done',
            id: 't_done2',
            state: { status: 'done', output: 'Done on fallback' },
          },
          rawData: '',
        } as RawEvent;
      }
      return fallbackStream();
    });

    const events: EngineEvent[] = [];
    const runPromise = (async () => {
      for await (const ev of orchestrator.runAgent({ prompt: 'test row 2', mentions: [] })) {
        events.push(ev);
      }
    })();

    await runPromise;

    // Verify proposal.discarded with reason 'failover' was emitted
    const discardedEv = events.find((e) => e.type === 'proposal.discarded') as {
      type: 'proposal.discarded';
      proposalId: string;
      reason: string;
    };
    expect(discardedEv).toBeDefined();
    expect(discardedEv.reason).toBe('failover');

    // Verify failover event was emitted
    expect(events.some((e) => e.type === 'failover')).toBe(true);

    // Verify run finished successfully on fallback
    expect(events[events.length - 1]).toEqual({
      type: 'run.completed',
      summary: 'Done on fallback',
    });
  });

  it('Row 3: Turn pauses for review, user rejects all hunks (0 applied), approval submitted, stream resumes and fails -> fails over to fallback', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockImplementation(async (agentName) => {
      return agentName === 'primary-agent' ? 'sess-primary-3' : 'sess-fallback-3';
    });

    vi.spyOn(client, 'submitApprovals').mockResolvedValue({ eventIds: ['ev-3'] });

    vi.spyOn(client, 'createTurn').mockImplementation((sessionId) => {
      if (sessionId === 'sess-primary-3') {
        async function* streamWithReview() {
          yield {
            id: '1',
            event: 'message',
            data: {
              type: 'model.message.delta',
              id: 'msg_r3',
              finish_reason: 'tool_calls',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_r3',
                  type: 'function',
                  function: {
                    name: 'createFile',
                    arguments: JSON.stringify({ path: 'src/r3.ts', content: 'hello', rationale: 'r3' }),
                  },
                },
              ],
            },
            rawData: '',
          } as RawEvent;
          yield {
            id: '2',
            event: 'message',
            data: {
              type: 'tool.approval_required',
              id: 'appr_r3',
              thread_id: 'main',
              tool_calls: [{ id: 'call_r3', source_event_id: 'msg_r3' }],
            },
            rawData: '',
          } as RawEvent;
          // Stream resumes after approval submit and throws error
          throw new HttpError(500, 'Failure during resumed streaming');
        }
        return streamWithReview();
      }

      // Fallback succeeds
      async function* fallbackStream() {
        yield {
          id: '3',
          event: 'message',
          data: {
            type: 'turn.done',
            id: 't_done3',
            state: { status: 'done', output: 'Recovered on fallback' },
          },
          rawData: '',
        } as RawEvent;
      }
      return fallbackStream();
    });

    const orchestrator = new SessionOrchestrator(host, client, config, {
      sleep: async () => {},
      jitter: false,
    });

    const events: EngineEvent[] = [];
    const runPromise = (async () => {
      for await (const ev of orchestrator.runAgent({ prompt: 'test row 3', mentions: [] })) {
        events.push(ev);
        if (ev.type === 'review.required') {
          // User rejects all hunks (applied: false)
          await orchestrator.reviewDone({
            batchId: ev.batchId,
            proposals: [
              {
                proposalId: ev.proposalIds[0],
                decisions: { '0': 'rejected' },
                applied: false,
              },
            ],
          });
        }
      }
    })();

    await runPromise;

    // Verify failover happened because 0 hunks were applied
    expect(events.some((e) => e.type === 'failover')).toBe(true);
    expect(events[events.length - 1]).toEqual({
      type: 'run.completed',
      summary: 'Recovered on fallback',
    });
  });

  it('Row 4: Turn pauses for review, >=1 hunk applied to disk, stream resumes and fails -> NO replay, exactly one run.failed explaining changes applied', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('sess-primary-4');
    vi.spyOn(client, 'submitApprovals').mockResolvedValue({ eventIds: ['ev-4'] });

    vi.spyOn(client, 'createTurn').mockImplementation(() => {
      async function* streamWithAppliedHunk() {
        yield {
          id: '1',
          event: 'message',
          data: {
            type: 'model.message.delta',
            id: 'msg_r4',
            finish_reason: 'tool_calls',
            tool_calls: [
              {
                index: 0,
                id: 'call_r4',
                type: 'function',
                function: {
                  name: 'createFile',
                  arguments: JSON.stringify({ path: 'src/r4.ts', content: 'applied content', rationale: 'r4' }),
                },
              },
            ],
          },
          rawData: '',
        } as RawEvent;
        yield {
          id: '2',
          event: 'message',
          data: {
            type: 'tool.approval_required',
            id: 'appr_r4',
            thread_id: 'main',
            tool_calls: [{ id: 'call_r4', source_event_id: 'msg_r4' }],
          },
          rawData: '',
        } as RawEvent;
        // Resume stream encounters failure
        throw new HttpError(500, 'Crash after applied hunks');
      }
      return streamWithAppliedHunk();
    });

    const orchestrator = new SessionOrchestrator(host, client, config, {
      sleep: async () => {},
      jitter: false,
    });

    const events: EngineEvent[] = [];
    const runPromise = (async () => {
      for await (const ev of orchestrator.runAgent({ prompt: 'test row 4', mentions: [] })) {
        events.push(ev);
        if (ev.type === 'review.required') {
          // User accepted and applied a hunk (applied: true)
          await orchestrator.reviewDone({
            batchId: ev.batchId,
            proposals: [
              {
                proposalId: ev.proposalIds[0],
                decisions: { '0': 'accepted' },
                applied: true,
              },
            ],
          });
        }
      }
    })();

    await runPromise;

    // Verify NO failover event was emitted
    expect(events.some((e) => e.type === 'failover')).toBe(false);

    // Verify terminal event is run.failed with clear explanation and retryable: false
    const lastEvent = events[events.length - 1] as {
      type: 'run.failed';
      error: { kind: string; message: string; retryable: boolean };
    };
    expect(lastEvent.type).toBe('run.failed');
    expect(lastEvent.error.message).toContain('Changes already applied to workspace');
    expect(lastEvent.error.message).toContain('failover replay disabled');
    expect(lastEvent.error.retryable).toBe(false);
  });

  it('Row 5: Primary and fallback both fail -> exactly one run.failed naming both causes with sensitive tokens redacted', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    const secretToken = config.setup.mcp.token!; // 'super-secret-mcp-token-xyz'

    vi.spyOn(client, 'createSession').mockImplementation(async (agentName) => {
      return agentName === 'primary-agent' ? 'sess-primary-5' : 'sess-fallback-5';
    });

    vi.spyOn(client, 'createTurn').mockImplementation((sessionId) => {
      if (sessionId === 'sess-primary-5') {
        async function* primaryFailing() {
          throw new HttpError(500, `Primary failed with token ${secretToken}`);
        }
        return primaryFailing();
      }

      async function* fallbackFailing() {
        throw new HttpError(502, `Fallback bad gateway with token ${secretToken}`);
      }
      return fallbackFailing();
    });

    const orchestrator = new SessionOrchestrator(host, client, config, {
      sleep: async () => {},
      jitter: false,
    });

    const events: EngineEvent[] = [];
    for await (const ev of orchestrator.runAgent({ prompt: 'test row 5', mentions: [] })) {
      events.push(ev);
    }

    // Verify failover happened once
    expect(events.filter((e) => e.type === 'failover').length).toBe(1);

    // Verify exactly one terminal event: run.failed
    const failedEvents = events.filter((e) => e.type === 'run.failed') as {
      type: 'run.failed';
      error: { kind: string; message: string; retryable: boolean };
    }[];
    expect(failedEvents.length).toBe(1);

    const errorMsg = failedEvents[0].error.message;
    // Names both agents and causes
    expect(errorMsg).toContain('primary-agent');
    expect(errorMsg).toContain('fallback-agent');
    expect(errorMsg).toContain('Primary failed with token');
    expect(errorMsg).toContain('Fallback bad gateway');

    // Token MUST be redacted, never in raw form
    expect(errorMsg).not.toContain(secretToken);
    expect(errorMsg).toContain('[REDACTED]');
  });

  it('Row 6: User cancels during retry back-off -> sleep timer aborted, emits run.cancelled, workspace untouched', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('sess-cancel-6');

    vi.spyOn(client, 'createTurn').mockImplementation(() => {
      async function* stream() {
        throw new HttpError(500, 'Temporary 500 error');
      }
      return stream();
    });

    let orchestratorRef: SessionOrchestrator | null = null;

    const mockSleep = async (_ms: number, signal?: AbortSignal) => {
      // Simulate user cancelling during the backoff delay
      if (orchestratorRef) {
        await orchestratorRef.cancel();
      }
      if (signal?.aborted) {
        throw new Error('AbortError');
      }
    };

    const orchestrator = new SessionOrchestrator(host, client, config, {
      sleep: mockSleep,
      jitter: false,
    });
    orchestratorRef = orchestrator;

    const events: EngineEvent[] = [];
    for await (const ev of orchestrator.runAgent({ prompt: 'test row 6', mentions: [] })) {
      events.push(ev);
    }

    // Verify retry was emitted before cancel
    expect(events.some((e) => e.type === 'retry')).toBe(true);

    // Verify run finished with run.cancelled
    expect(events[events.length - 1]).toEqual({ type: 'run.cancelled' });
  });

  it('Row 6b: User cancels during failover -> emits run.cancelled', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockImplementation(async (agentName) => {
      if (agentName === 'fallback-agent') {
        // Cancel right during fallback session creation
        await orchestrator.cancel();
      }
      return 'sess-6b';
    });

    vi.spyOn(client, 'createTurn').mockImplementation(() => {
      async function* stream() {
        // Non-retryable model error triggers immediate failover
        throw new HttpError(404, 'Model 404');
      }
      return stream();
    });

    const orchestrator = new SessionOrchestrator(host, client, config, {
      sleep: async () => {},
      jitter: false,
    });

    const events: EngineEvent[] = [];
    for await (const ev of orchestrator.runAgent({ prompt: 'test row 6b', mentions: [] })) {
      events.push(ev);
    }

    expect(events.some((e) => e.type === 'failover')).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: 'run.cancelled' });
  });

  it('Quota 429 case: 429 with quota phrase or duration > 60s fails over immediately without retries', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockImplementation(async (agentName) => {
      return agentName === 'primary-agent' ? 'sess-primary-quota' : 'sess-fallback-quota';
    });

    vi.spyOn(client, 'createTurn').mockImplementation((sessionId) => {
      if (sessionId === 'sess-primary-quota') {
        async function* quotaStream() {
          throw new HttpError(429, 'Rate limit exceeded: 5 requests per day allowed');
        }
        return quotaStream();
      }

      async function* fallbackStream() {
        yield {
          id: '1',
          event: 'message',
          data: {
            type: 'turn.done',
            id: 'td_q',
            state: { status: 'done', output: 'Fallback after quota' },
          },
          rawData: '',
        } as RawEvent;
      }
      return fallbackStream();
    });

    const orchestrator = new SessionOrchestrator(host, client, config, {
      sleep: async () => {},
      jitter: false,
    });

    const events: EngineEvent[] = [];
    for await (const ev of orchestrator.runAgent({ prompt: 'test quota', mentions: [] })) {
      events.push(ev);
    }

    // Zero retry events must be emitted
    expect(events.some((e) => e.type === 'retry')).toBe(false);

    // Failover event with reason 'rate_limit'
    const failover = events.find((e) => e.type === 'failover') as { type: 'failover'; reason: string };
    expect(failover).toBeDefined();
    expect(failover.reason).toBe('rate_limit');

    // Run completed on fallback
    expect(events[events.length - 1]).toEqual({
      type: 'run.completed',
      summary: 'Fallback after quota',
    });
  });

  it('Short 429 case: transient rate limit retries with backoff', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('sess-short-429');

    let attempt = 0;
    vi.spyOn(client, 'createTurn').mockImplementation(() => {
      attempt++;
      if (attempt === 1) {
        async function* transient429() {
          throw new HttpError(429, 'Too many requests, retry after 2s');
        }
        return transient429();
      }

      async function* okStream() {
        yield {
          id: '1',
          event: 'message',
          data: {
            type: 'turn.done',
            id: 'td_short',
            state: { status: 'done', output: 'Success after short 429' },
          },
          rawData: '',
        } as RawEvent;
      }
      return okStream();
    });

    const orchestrator = new SessionOrchestrator(host, client, config, {
      sleep: async () => {},
      jitter: false,
    });

    const events: EngineEvent[] = [];
    for await (const ev of orchestrator.runAgent({ prompt: 'test short 429', mentions: [] })) {
      events.push(ev);
    }

    // Retried and did NOT fail over
    expect(events.some((e) => e.type === 'retry')).toBe(true);
    expect(events.some((e) => e.type === 'failover')).toBe(false);
    expect(events[events.length - 1]).toEqual({
      type: 'run.completed',
      summary: 'Success after short 429',
    });
  });

  it('TrueForge down case: NetworkError to baseUrl on session creation -> no failover, tells user to start TrueForge', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    const cause = new Error('connect ECONNREFUSED 127.0.0.1:8790');
    vi.spyOn(client, 'createSession').mockRejectedValue(
      new NetworkError('ECONNREFUSED', cause, 'Request to POST /api/v1/sessions failed: fetch failed')
    );

    const orchestrator = new SessionOrchestrator(host, client, config, {
      sleep: async () => {},
      jitter: false,
    });

    const events: EngineEvent[] = [];
    for await (const ev of orchestrator.runAgent({ prompt: 'test down', mentions: [] })) {
      events.push(ev);
    }

    // No retries and no failover
    expect(events.some((e) => e.type === 'retry')).toBe(false);
    expect(events.some((e) => e.type === 'failover')).toBe(false);

    // Exactly one run.failed telling user to start TrueForge
    const lastEvent = events[events.length - 1] as {
      type: 'run.failed';
      error: { kind: string; message: string; retryable: boolean };
    };
    expect(lastEvent.type).toBe('run.failed');
    expect(lastEvent.error.kind).toBe('unreachable');
    expect(lastEvent.error.message).toContain('TrueForge is down');
    expect(lastEvent.error.message).toContain('npx @truefoundry/trueforge@latest');
    expect(lastEvent.error.retryable).toBe(false);
  });

  it('Side-effects guard: tool.call emitted in current attempt skips retries and triggers immediate failover', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockImplementation(async (agentName) => {
      return agentName === 'primary-agent' ? 'sess-primary-sidefx' : 'sess-fallback-sidefx';
    });

    vi.spyOn(client, 'createTurn').mockImplementation((sessionId) => {
      if (sessionId === 'sess-primary-sidefx') {
        async function* streamWithToolCall() {
          // tool.call emitted
          yield {
            id: '1',
            event: 'message',
            data: {
              type: 'model.message.delta',
              id: 'msg_tc',
              finish_reason: 'tool_calls',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_rf',
                  type: 'function',
                  function: {
                    name: 'readFile',
                    arguments: JSON.stringify({ path: 'src/file.ts' }),
                  },
                },
              ],
            },
            rawData: '',
          } as RawEvent;
          // Crash with retryable 500
          throw new HttpError(500, 'Crash after tool.call');
        }
        return streamWithToolCall();
      }

      async function* fallbackStream() {
        yield {
          id: '2',
          event: 'message',
          data: {
            type: 'turn.done',
            id: 'td_sidefx',
            state: { status: 'done', output: 'Done on fallback' },
          },
          rawData: '',
        } as RawEvent;
      }
      return fallbackStream();
    });

    const orchestrator = new SessionOrchestrator(host, client, config, {
      sleep: async () => {},
      jitter: false,
    });

    const events: EngineEvent[] = [];
    for await (const ev of orchestrator.runAgent({ prompt: 'test side-effects', mentions: [] })) {
      events.push(ev);
    }

    // Because a tool.call was emitted, retry is SKIPPED (0 retry events)
    expect(events.some((e) => e.type === 'retry')).toBe(false);

    // Failover occurs immediately
    expect(events.some((e) => e.type === 'failover')).toBe(true);
    expect(events[events.length - 1]).toEqual({
      type: 'run.completed',
      summary: 'Done on fallback',
    });
  });

  it('Inline instruction: appended only when non-empty selectedText is provided', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockResolvedValue('sess-inline');

    const recordedPrompts: string[] = [];
    vi.spyOn(client, 'createTurn').mockImplementation((_sessId, input) => {
      const items = input as Array<{ type: string; content?: string }>;
      const userMsg = items.find((i) => i.type === 'user.message');
      if (userMsg && userMsg.content) {
        recordedPrompts.push(userMsg.content);
      }
      async function* stream() {
        yield {
          id: '1',
          event: 'message',
          data: {
            type: 'turn.done',
            id: 'td_inline',
            state: { status: 'done' },
          },
          rawData: '',
        } as RawEvent;
      }
      return stream();
    });

    const orchestrator = new SessionOrchestrator(host, client, config, {
      sleep: async () => {},
      jitter: false,
    });

    // 1. With non-empty selected text
    for await (const _ev of orchestrator.runInline({
      prompt: 'Refactor this',
      path: 'src/inline.ts',
      selectedText: 'const x = 1;',
      range: { startLine: 1, endLine: 1 },
    })) {
      // consume
    }

    expect(recordedPrompts[0]).toContain('Refactor this');
    expect(recordedPrompts[0]).toContain(
      'The selected code is provided, propose the edit directly with proposeEdit, then finish; do not search, read files, or run any command or tests.'
    );

    // 2. With empty selected text
    for await (const _ev of orchestrator.runInline({
      prompt: 'Refactor nothing',
      path: 'src/inline.ts',
      selectedText: '   ',
      range: { startLine: 1, endLine: 1 },
    })) {
      // consume
    }

    expect(recordedPrompts[1]).toContain('Refactor nothing');
    expect(recordedPrompts[1]).not.toContain('The selected code is provided');
    expect(recordedPrompts[1]).not.toContain('propose the edit directly with proposeEdit, then finish');

    // 3. In agent-mode (no selection)
    for await (const _ev of orchestrator.runAgent({
      prompt: 'Agent mode prompt',
      mentions: [],
    })) {
      // consume
    }

    expect(recordedPrompts[2]).toContain('Agent mode prompt');
    expect(recordedPrompts[2]).not.toContain('The selected code is provided');
    expect(recordedPrompts[2]).not.toContain('propose the edit directly with proposeEdit, then finish');
  });

  it('fails over immediately with reason auth and 0 retries when primary encounters HTTP 400 invalid API key', async () => {
    const config = createMockConfig();
    const host = createMockHost();
    const client = new ForgeClient(config.setup);

    vi.spyOn(client, 'createSession').mockImplementation(async (agentName) => {
      return agentName === 'primary-agent' ? 'sess-primary-auth' : 'sess-fallback-auth';
    });

    const sleepCalls: number[] = [];
    const mockSleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    vi.spyOn(client, 'createTurn').mockImplementation((sessionId) => {
      if (sessionId === 'sess-primary-auth') {
        // Primary fails with Gemini HTTP 400 invalid API key error
        async function* failingStream() {
          throw new HttpError(400, 'API key not valid. Please pass a valid API key.');
        }
        return failingStream();
      }

      // Fallback succeeds
      async function* fallbackStream() {
        yield {
          id: '1',
          event: 'message',
          data: {
            type: 'turn.done',
            id: 'td_fb_auth',
            state: { status: 'done', output: 'Succeeded on fallback model' },
          },
          rawData: '',
        } as RawEvent;
      }
      return fallbackStream();
    });

    const orchestrator = new SessionOrchestrator(host, client, config, {
      sleep: mockSleep,
      jitter: false,
    });

    const events: EngineEvent[] = [];
    for await (const ev of orchestrator.runAgent({ prompt: 'test invalid api key failover', mentions: [] })) {
      events.push(ev);
    }

    // Must NOT retry: 0 sleep calls, 0 retry events
    expect(sleepCalls).toHaveLength(0);
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(0);

    // Failover event emitted with exact reason 'auth'
    const failoverEv = events.find((e) => e.type === 'failover') as {
      type: 'failover';
      from: string;
      to: string;
      reason: string;
    };
    expect(failoverEv).toBeDefined();
    expect(failoverEv.from).toBe('primary-agent');
    expect(failoverEv.to).toBe('fallback-agent');
    expect(failoverEv.reason).toBe('auth');

    // Run completes on fallback
    expect(events[events.length - 1]).toEqual({
      type: 'run.completed',
      summary: 'Succeeded on fallback model',
    });
  });
});
