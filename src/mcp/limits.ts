/**
 * Limits and truncation helpers for MCP tool server (Milestone E-04).
 *
 * Enforces output boundaries, line/token caps, and preview truncation
 * per docs/01-ARCHITECTURE.md §3 and docs/04-CONTEXT-ENGINE.md.
 */

import type { UiHost } from '../types/contract.ts';
import type { RunBudget } from '../engine/budget.ts';

/** Execution context supplied to MCP tool handlers. */
export interface ToolExecutionContext {
  host: UiHost;
  budget?: RunBudget;
}

/** Standard MCP tool call result shape with text content blocks. */
export interface ToolCallResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** Maximum results returned by searchWorkspace. */
export const MAX_SEARCH_HITS = 20;

/** Maximum character length of each search match preview line. */
export const MAX_PREVIEW_CHARS = 160;

/** Maximum lines returned by readFile. */
export const MAX_READ_LINES = 200;

/** Maximum estimated tokens returned by readFile. */
export const MAX_READ_TOKENS = 1500;

/** Maximum estimated tokens for compact repoMap tree. */
export const MAX_REPO_MAP_TOKENS = 1500;

/** Maximum items accepted by reportContext. */
export const MAX_REPORT_CONTEXT_ITEMS = 20;

/** Maximum character length kept in runCommand output (tail retained). */
export const MAX_COMMAND_OUTPUT_CHARS = 6000;

/** Default command execution timeout in milliseconds (60 seconds). */
export const COMMAND_TIMEOUT_MS = 60000;

/** Maximum file size in bytes for tool inspection (1 MB). */
export const MAX_FILE_BYTES = 1024 * 1024;

/** Documented character-to-token ratio (chars / 4). */
export const CHARS_PER_TOKEN = 4;

/**
 * Estimates token count from text length using standard chars/4 formula.
 *
 * @param text - Input string to measure
 * @returns Estimated token count (minimum 0)
 */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Truncates an array of search results to MAX_SEARCH_HITS and calculates omitted count.
 *
 * @param hits - Full list of search hits
 * @param maxHits - Optional override for maximum hits (defaults to MAX_SEARCH_HITS)
 * @returns Object with capped hits and omitted count
 */
export function truncateSearchHits<T>(
  hits: T[],
  maxHits = MAX_SEARCH_HITS
): { hits: T[]; omitted: number } {
  if (hits.length <= maxHits) {
    return { hits: [...hits], omitted: 0 };
  }
  return {
    hits: hits.slice(0, maxHits),
    omitted: hits.length - maxHits,
  };
}

/**
 * Truncates a search preview line to MAX_PREVIEW_CHARS, appending ellipsis if shortened.
 *
 * @param preview - Raw preview string
 * @param maxChars - Optional override for max characters (defaults to MAX_PREVIEW_CHARS)
 * @returns Truncated preview line
 */
export function truncatePreview(
  preview: string,
  maxChars = MAX_PREVIEW_CHARS
): string {
  if (!preview) {
    return '';
  }
  const clean = preview.replace(/\r?\n/g, ' ').trim();
  if (clean.length <= maxChars) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, maxChars - 3))}...`;
}

/**
 * Result of line-based and token-based text truncation for readFile.
 */
export interface TruncatedLinesResult {
  text: string;
  truncated: boolean;
  totalLines: number;
  returnedLines: number;
  tokens: number;
}

/**
 * Truncates file text to line and token caps, reporting truncation metadata.
 *
 * @param text - Original file content
 * @param maxLines - Maximum allowed lines (defaults to MAX_READ_LINES)
 * @param maxTokens - Maximum allowed tokens (defaults to MAX_READ_TOKENS)
 * @returns Truncated text with line counts and token metrics
 */
export function truncateLines(
  text: string,
  maxLines = MAX_READ_LINES,
  maxTokens = MAX_READ_TOKENS
): TruncatedLinesResult {
  if (!text) {
    return {
      text: '',
      truncated: false,
      totalLines: 0,
      returnedLines: 0,
      tokens: 0,
    };
  }

  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  let truncated = false;
  let candidateLines = lines;

  if (candidateLines.length > maxLines) {
    candidateLines = candidateLines.slice(0, maxLines);
    truncated = true;
  }

  let joined = candidateLines.join('\n');
  if (joined.length > maxChars) {
    truncated = true;
    // Progressively back off lines until under character/token budget
    while (candidateLines.length > 1 && joined.length > maxChars) {
      candidateLines.pop();
      joined = candidateLines.join('\n');
    }

    // If even a single line exceeds maxChars, truncate that line directly
    if (joined.length > maxChars) {
      joined = `${joined.slice(0, Math.max(0, maxChars - 32))}\n... [line truncated]`;
    }
  }

  return {
    text: joined,
    truncated,
    totalLines,
    returnedLines: candidateLines.length,
    tokens: estimateTokens(joined),
  };
}

/**
 * Truncates output keeping the tail (most recent output), prepending a truncation marker.
 *
 * @param output - Raw command or tool output
 * @param maxChars - Maximum characters to retain (defaults to MAX_COMMAND_OUTPUT_CHARS)
 * @returns Tail-truncated output string and truncation flag
 */
export function truncateTail(
  output: string,
  maxChars = MAX_COMMAND_OUTPUT_CHARS
): { text: string; truncated: boolean; originalLength: number } {
  if (!output || output.length <= maxChars) {
    return {
      text: output ?? '',
      truncated: false,
      originalLength: output ? output.length : 0,
    };
  }

  const tail = output.slice(output.length - maxChars);
  const notice = `[... truncated, showing last ${maxChars} characters ...]\n`;
  return {
    text: `${notice}${tail}`,
    truncated: true,
    originalLength: output.length,
  };
}
