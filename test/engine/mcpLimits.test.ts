/**
 * Unit tests for MCP limits and truncation helpers (Milestone E-04).
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_SEARCH_HITS,
  MAX_PREVIEW_CHARS,
  MAX_READ_LINES,
  MAX_READ_TOKENS,
  MAX_COMMAND_OUTPUT_CHARS,
  MAX_FILE_BYTES,
  CHARS_PER_TOKEN,
  estimateTokens,
  truncateSearchHits,
  truncatePreview,
  truncateLines,
  truncateTail,
} from '../../src/mcp/limits.ts';

describe('mcp limits and truncation helpers', () => {
  describe('constants', () => {
    it('defines expected hard caps conforming to architecture spec', () => {
      expect(MAX_SEARCH_HITS).toBe(20);
      expect(MAX_PREVIEW_CHARS).toBe(160);
      expect(MAX_READ_LINES).toBe(200);
      expect(MAX_READ_TOKENS).toBe(1500);
      expect(MAX_COMMAND_OUTPUT_CHARS).toBe(6000);
      expect(MAX_FILE_BYTES).toBe(1024 * 1024);
      expect(CHARS_PER_TOKEN).toBe(4);
    });
  });

  describe('estimateTokens', () => {
    it('returns 0 for empty or null strings', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('estimates tokens as Math.ceil(chars / 4)', () => {
      expect(estimateTokens('a')).toBe(1);
      expect(estimateTokens('abcd')).toBe(1);
      expect(estimateTokens('abcde')).toBe(2);
      expect(estimateTokens('1234567890123456')).toBe(4);
      expect(estimateTokens('x'.repeat(6000))).toBe(1500);
    });
  });

  describe('truncateSearchHits', () => {
    it('returns all hits with 0 omitted when within maxHits', () => {
      const hits = Array.from({ length: 10 }, (_, i) => ({ id: i }));
      const result = truncateSearchHits(hits, 20);
      expect(result.hits).toHaveLength(10);
      expect(result.omitted).toBe(0);
    });

    it('caps hits at maxHits and reports omitted count', () => {
      const hits = Array.from({ length: 25 }, (_, i) => ({ id: i }));
      const result = truncateSearchHits(hits, 20);
      expect(result.hits).toHaveLength(20);
      expect(result.omitted).toBe(5);
      expect(result.hits[0].id).toBe(0);
      expect(result.hits[19].id).toBe(19);
    });

    it('handles empty hits array', () => {
      const result = truncateSearchHits([]);
      expect(result.hits).toHaveLength(0);
      expect(result.omitted).toBe(0);
    });
  });

  describe('truncatePreview', () => {
    it('returns preview as-is when within limit', () => {
      const short = 'def calculate_sum(a, b): return a + b';
      expect(truncatePreview(short, 160)).toBe(short);
    });

    it('flattens newlines and trims whitespace', () => {
      const multiline = 'line 1\n  line 2\r\nline 3';
      expect(truncatePreview(multiline)).toBe('line 1   line 2 line 3');
    });

    it('truncates preview exceeding maxChars with ellipsis to exact length', () => {
      const long = 'a'.repeat(200);
      const result = truncatePreview(long, 160);
      expect(result.length).toBe(160);
      expect(result.endsWith('...')).toBe(true);
      expect(result).toBe(`${'a'.repeat(157)}...`);
    });

    it('handles empty string', () => {
      expect(truncatePreview('')).toBe('');
    });
  });

  describe('truncateLines', () => {
    it('returns full text without truncation when well within line and token limits', () => {
      const content = 'line 1\nline 2\nline 3';
      const result = truncateLines(content, 200, 1500);
      expect(result.truncated).toBe(false);
      expect(result.text).toBe(content);
      expect(result.totalLines).toBe(3);
      expect(result.returnedLines).toBe(3);
      expect(result.tokens).toBe(estimateTokens(content));
    });

    it('truncates by line count when exceeding maxLines', () => {
      const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`);
      const text = lines.join('\n');
      const result = truncateLines(text, 200, 1500);

      expect(result.truncated).toBe(true);
      expect(result.totalLines).toBe(250);
      expect(result.returnedLines).toBe(200);
      const returnedLines = result.text.split('\n');
      expect(returnedLines).toHaveLength(200);
      expect(returnedLines[0]).toBe('line 1');
      expect(returnedLines[199]).toBe('line 200');
    });

    it('truncates by token limit when few lines exceed max token budget', () => {
      // 10 lines of 1000 chars = 10,000 chars (~2500 tokens > 1500 tokens limit)
      const lines = Array.from({ length: 10 }, (_, i) => `[${i}] ${'x'.repeat(1000)}`);
      const text = lines.join('\n');
      const result = truncateLines(text, 200, 1500);

      expect(result.truncated).toBe(true);
      expect(result.totalLines).toBe(10);
      expect(result.returnedLines).toBeLessThan(10);
      expect(result.tokens).toBeLessThanOrEqual(1500);
    });

    it('handles a single extremely long line exceeding token budget', () => {
      const hugeLine = 'z'.repeat(8000); // 2000 tokens > 1500 tokens
      const result = truncateLines(hugeLine, 200, 1500);

      expect(result.truncated).toBe(true);
      expect(result.totalLines).toBe(1);
      expect(result.tokens).toBeLessThanOrEqual(1500);
      expect(result.text).toContain('[line truncated]');
    });

    it('handles empty text', () => {
      const result = truncateLines('');
      expect(result.truncated).toBe(false);
      expect(result.totalLines).toBe(0);
      expect(result.returnedLines).toBe(0);
      expect(result.text).toBe('');
      expect(result.tokens).toBe(0);
    });

    it('handles CRLF line endings cleanly', () => {
      const crlfText = 'line 1\r\nline 2\r\nline 3';
      const result = truncateLines(crlfText, 2, 100);
      expect(result.truncated).toBe(true);
      expect(result.totalLines).toBe(3);
      expect(result.returnedLines).toBe(2);
      expect(result.text).toBe('line 1\nline 2');
    });
  });

  describe('truncateTail', () => {
    it('returns output as-is when under maxChars', () => {
      const output = 'Command completed successfully with 0 warnings.';
      const result = truncateTail(output, 6000);
      expect(result.truncated).toBe(false);
      expect(result.text).toBe(output);
      expect(result.originalLength).toBe(output.length);
    });

    it('keeps the tail (end of output) when exceeding maxChars and adds notice', () => {
      const head = 'a'.repeat(2000);
      const tail = 'b'.repeat(6000);
      const combined = `${head}${tail}`;

      const result = truncateTail(combined, 6000);
      expect(result.truncated).toBe(true);
      expect(result.originalLength).toBe(8000);
      expect(result.text.endsWith(tail)).toBe(true);
      expect(result.text).toContain('[... truncated, showing last 6000 characters ...]');
    });

    it('handles empty output string', () => {
      const result = truncateTail('');
      expect(result.truncated).toBe(false);
      expect(result.text).toBe('');
      expect(result.originalLength).toBe(0);
    });
  });
});
