/**
 * ResilienceManager.ts -- Error classification, retry backoff, and failover policy (Milestone E-09).
 *
 * Implements deterministic error classification from real TrueForge wire shapes,
 * exponential backoff calculation with positive jitter, quota exceeded detection,
 * and failover decision logic per docs/01-ARCHITECTURE.md §6.
 */

import type { ForgeError } from '../types/contract.ts';
import { HttpError, NetworkError } from './ForgeClient.ts';

/**
 * Redacts any occurrence of the sensitive token from text strings.
 */
export function redactToken(text: string, token?: string): string {
  if (!token || token.trim().length === 0) {
    return text;
  }
  return text.split(token).join('[REDACTED]');
}

/**
 * Parses duration in seconds from human-readable duration strings.
 * Supports composite forms like "5h1m8.7s", "1h30m", "2m10s", "65.5s",
 * as well as plain seconds like "120s" or "retry after 90".
 * Returns null if no duration format is found.
 */
export function parseDurationSeconds(text: string): number | null {
  if (!text || typeof text !== 'string') {
    return null;
  }

  // Check for composite duration formats: e.g. 5h1m8.7s, 2h, 45m, 10.5s
  const compositeMatch = /(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+(?:\.\d+)?)m)?\s*(?:(\d+(?:\.\d+)?)s)\b/i.exec(text);
  if (compositeMatch && (compositeMatch[1] || compositeMatch[2] || compositeMatch[3])) {
    const hours = compositeMatch[1] ? parseFloat(compositeMatch[1]) : 0;
    const minutes = compositeMatch[2] ? parseFloat(compositeMatch[2]) : 0;
    const seconds = compositeMatch[3] ? parseFloat(compositeMatch[3]) : 0;
    const total = hours * 3600 + minutes * 60 + seconds;
    if (total > 0) return total;
  }

  // Check for hours-only or minutes-only e.g. "2h" or "30m"
  const hmMatch = /(?:(\d+(?:\.\d+)?)h(?:\s*(\d+(?:\.\d+)?)m)?|(\d+(?:\.\d+)?)m)\b/i.exec(text);
  if (hmMatch) {
    const h = hmMatch[1] ? parseFloat(hmMatch[1]) : 0;
    const m = (hmMatch[2] ? parseFloat(hmMatch[2]) : 0) || (hmMatch[3] ? parseFloat(hmMatch[3]) : 0);
    const total = h * 3600 + m * 60;
    if (total > 0) return total;
  }

  // Check for "retry in X [seconds]" or "retry after X"
  const plainSecMatch = /(?:retry(?:-after|\s+after|\s+in)?|wait|again in)[:\s]+(\d+(?:\.\d+)?)\s*(?:s|seconds|sec)?\b/i.exec(text);
  if (plainSecMatch && plainSecMatch[1]) {
    return parseFloat(plainSecMatch[1]);
  }

  return null;
}

/**
 * Checks whether an HTTP 429 response or error text indicates quota exhaustion.
 * Returns true if message mentions "exceeded your current quota", "per day", "daily",
 * or if a parsed retry-after duration exceeds 60 seconds.
 */
export function isQuotaExceeded(status?: number, message = ''): boolean {
  const lower = message.toLowerCase();
  if (
    lower.includes('exceeded your current quota') ||
    lower.includes('per day') ||
    lower.includes('daily quota') ||
    lower.includes('monthly quota')
  ) {
    return true;
  }

  if (status === 429 || lower.includes('429') || lower.includes('rate limit')) {
    const dur = parseDurationSeconds(message);
    if (dur !== null && dur > 60) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether an error message indicates an invalid or revoked API key safely without throwing.
 * Case-insensitive, safely handles undefined, null, or non-string inputs.
 */
export function isInvalidApiKeyError(message?: unknown): boolean {
  if (typeof message !== 'string' || message.trim().length === 0) {
    return false;
  }
  const lower = message.toLowerCase();
  return (
    lower.includes('api key not valid') ||
    lower.includes('invalid api key') ||
    lower.includes('api_key_invalid') ||
    lower.includes('invalid_api_key')
  );
}

/**
 * Result of error classification.
 */
export interface ClassifiedError extends ForgeError {
  isTrueForgeDown: boolean;
  status?: number;
  retryAfterSeconds?: number;
}

/**
 * Computes exponential backoff delay with optional uniform positive jitter.
 * delay = baseDelayMs * 2^(attempt - 1) + jitter (up to 20%)
 */
export function computeBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  jitter = true
): number {
  const factor = Math.pow(2, Math.max(0, attempt - 1));
  const base = baseDelayMs * factor;
  if (!jitter) {
    return base;
  }
  const randomJitter = Math.random() * (0.2 * base);
  return Math.round(base + randomJitter);
}

/**
 * Default sleep implementation bound to AbortSignal.
 */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error('AbortError'));
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new Error('AbortError'));
    };
    if (signal) {
      signal.addEventListener('abort', onAbort);
    }
  });
}

/**
 * Options for configuring ResilienceManager.
 */
export interface ResilienceOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  clock?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  jitter?: boolean;
}

/**
 * ResilienceManager coordinates error classification, retry timing, and failover policy.
 */
export class ResilienceManager {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly clock: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly jitter: boolean;

  constructor(opts?: ResilienceOptions) {
    this.maxRetries = opts?.maxRetries ?? 3;
    this.baseDelayMs = opts?.baseDelayMs ?? 1000;
    this.clock = opts?.clock ?? (() => Date.now());
    this.sleep = opts?.sleep ?? defaultSleep;
    this.jitter = opts?.jitter ?? true;
  }

  /**
   * Deterministically classifies an encountered error into a contract ClassifiedError.
   *
   * @param err - Unknown error caught during session or turn execution
   * @param baseUrl - Optional TrueForge baseUrl to detect if TrueForge itself is down
   */
  public classify(err: unknown, baseUrl?: string): ClassifiedError {
    // 1. Direct NetworkError from our client to TrueForge baseUrl
    if (err instanceof NetworkError) {
      const isBaseRefused =
        baseUrl &&
        (err.message.includes(baseUrl) ||
          err.message.includes('ECONNREFUSED') ||
          err.message.includes('fetch failed'));

      if (isBaseRefused) {
        return {
          kind: 'unreachable',
          message:
            'TrueForge is down. Start TrueForge: npx @truefoundry/trueforge@latest (default http://localhost:8790)',
          retryable: false,
          isTrueForgeDown: true,
        };
      }

      return {
        kind: 'unreachable',
        message: err.message,
        retryable: true,
        isTrueForgeDown: false,
      };
    }

    // 2. HTTP wire response errors
    if (err instanceof HttpError) {
      const status = err.status;

      if (status === 401 || status === 403 || (status === 400 && isInvalidApiKeyError(err.message))) {
        return {
          kind: 'auth',
          message: err.message,
          retryable: false,
          isTrueForgeDown: false,
          status,
        };
      }

      if (status === 404) {
        return {
          kind: 'model',
          message: err.message,
          retryable: false,
          isTrueForgeDown: false,
          status,
        };
      }

      if (status === 429) {
        const isQuota = isQuotaExceeded(429, err.message);
        const retryAfter = parseDurationSeconds(err.message);
        return {
          kind: 'rate_limit',
          message: err.message,
          retryable: !isQuota,
          isTrueForgeDown: false,
          status,
          ...(retryAfter !== null ? { retryAfterSeconds: retryAfter } : {}),
        };
      }

      if (status === 408 || status === 504) {
        return {
          kind: 'timeout',
          message: err.message,
          retryable: true,
          isTrueForgeDown: false,
          status,
        };
      }

      if (status >= 500 && status <= 599) {
        return {
          kind: 'model',
          message: err.message,
          retryable: true,
          isTrueForgeDown: false,
          status,
        };
      }

      return {
        kind: 'unknown',
        message: err.message,
        retryable: false,
        isTrueForgeDown: false,
        status,
      };
    }

    // 3. String errors or turn.done state error messages
    const msg = typeof err === 'string'
      ? err
      : (err && typeof (err as Error).message === 'string')
      ? (err as Error).message
      : String(err ?? 'Unknown error');
    const lower = msg.toLowerCase();

    // Model-side text inside turn.done is NOT TrueForge down (Fact: TrueForge is streaming to us)
    if (lower.includes('404') || lower.includes('does not exist or you do not have access')) {
      return {
        kind: 'model',
        message: msg,
        retryable: false,
        isTrueForgeDown: false,
      };
    }

    if (
      lower.includes('401') ||
      lower.includes('403') ||
      lower.includes('unauthorized') ||
      lower.includes('forbidden') ||
      isInvalidApiKeyError(msg)
    ) {
      return {
        kind: 'auth',
        message: msg,
        retryable: false,
        isTrueForgeDown: false,
      };
    }

    if (lower.includes('429') || lower.includes('rate limit')) {
      const isQuota = isQuotaExceeded(429, msg);
      const retryAfter = parseDurationSeconds(msg);
      return {
        kind: 'rate_limit',
        message: msg,
        retryable: !isQuota,
        isTrueForgeDown: false,
        ...(retryAfter !== null ? { retryAfterSeconds: retryAfter } : {}),
      };
    }

    if (
      lower.includes('timeout') ||
      lower.includes('timed out') ||
      lower.includes('headers timeout') ||
      lower.includes('etimedout') ||
      lower.includes('504')
    ) {
      return {
        kind: 'timeout',
        message: msg,
        retryable: true,
        isTrueForgeDown: false,
      };
    }

    if (
      lower.includes('500') ||
      lower.includes('502') ||
      lower.includes('503') ||
      lower.includes('internal server error') ||
      lower.includes('service unavailable') ||
      lower.includes('[model error]')
    ) {
      return {
        kind: 'model',
        message: msg,
        retryable: true,
        isTrueForgeDown: false,
      };
    }

    if (err instanceof Error && err.name === 'AbortError') {
      return {
        kind: 'unreachable',
        message: 'Request timed out or connection was aborted',
        retryable: true,
        isTrueForgeDown: false,
      };
    }

    return {
      kind: 'unknown',
      message: msg,
      retryable: false,
      isTrueForgeDown: false,
    };
  }

  /**
   * Computes the backoff delay in milliseconds for a specific retry attempt (1-based).
   */
  public getDelay(attempt: number): number {
    return computeBackoffDelay(attempt, this.baseDelayMs, this.jitter);
  }
}
