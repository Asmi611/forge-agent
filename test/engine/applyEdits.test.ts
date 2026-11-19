/**
 * Unit tests for applyEdits (Milestone E-05).
 *
 * Verifies EOL-insensitive matching, preservation of mixed CRLF/LF line endings
 * outside edits via Buffer.compare, exact 1-match requirement, error hints for 0 matches,
 * ambiguity detection for >1 matches, and overlapping edit rejection.
 */

import { describe, expect, it } from 'vitest';
import { applyEdits } from '../../src/engine/applyEdits.ts';

describe('applyEdits', () => {
  it('applies a single search/replace edit', () => {
    const original = 'function add(a, b) {\n  return a + b;\n}\n';
    const edits = [
      {
        oldText: 'return a + b;',
        newText: 'return a + b + 1;',
      },
    ];

    const result = applyEdits(original, edits, 'src/math.ts');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('function add(a, b) {\n  return a + b + 1;\n}\n');
    }
  });

  it('applies a pure insertion into a file', () => {
    const original = 'const x = 1;\nconst z = 3;\n';
    const edits = [
      {
        oldText: 'const z = 3;',
        newText: 'const y = 2;\nconst z = 3;',
      },
    ];

    const result = applyEdits(original, edits, 'src/vars.ts');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('const x = 1;\nconst y = 2;\nconst z = 3;\n');
    }
  });

  it('applies a pure deletion from a file', () => {
    const original = 'const a = 1;\nconst deprecated = true;\nconst b = 2;\n';
    const edits = [
      {
        oldText: 'const deprecated = true;\n',
        newText: '',
      },
    ];

    const result = applyEdits(original, edits, 'src/vars.ts');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('const a = 1;\nconst b = 2;\n');
    }
  });

  it('applies multiple non-overlapping edits across different sections', () => {
    const original = 'header\n\nbody1\n\nbody2\n\nfooter\n';
    const edits = [
      { oldText: 'body1', newText: 'updatedBody1' },
      { oldText: 'footer', newText: 'newFooter' },
    ];

    const result = applyEdits(original, edits, 'src/doc.txt');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('header\n\nupdatedBody1\n\nbody2\n\nnewFooter\n');
    }
  });

  it('matches EOL-insensitively when original has LF and oldText has LF', () => {
    const original = 'line1\nline2\nline3\n';
    const edits = [{ oldText: 'line2\n', newText: 'lineTwo\n' }];

    const result = applyEdits(original, edits);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('line1\nlineTwo\nline3\n');
    }
  });

  it('matches EOL-insensitively when original has CRLF and oldText has LF', () => {
    const original = 'line1\r\nline2\r\nline3\r\n';
    const edits = [{ oldText: 'line2\n', newText: 'lineTwo\n' }];

    const result = applyEdits(original, edits);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('line1\r\nlineTwo\r\nline3\r\n');
      expect(result.text.includes('\r\n')).toBe(true);
    }
  });

  it('preserves untouched bytes byte-identically in mixed CRLF/LF files', () => {
    // Prefix has CRLF endings, suffix has LF endings
    const prefix = 'const a = 1;\r\nconst b = 2;\r\n';
    const target = 'const middle = 100;\r\n';
    const suffix = 'const c = 3;\nconst d = 4;\n';
    const original = prefix + target + suffix;

    const edits = [
      {
        oldText: 'const middle = 100;\n',
        newText: 'const middle = 200;\n',
      },
    ];

    const result = applyEdits(original, edits, 'src/mixed.ts');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const origBuf = Buffer.from(original, 'utf-8');
      const resBuf = Buffer.from(result.text, 'utf-8');

      // Prefix before the edit must be 100% byte-identical
      const origPrefix = origBuf.subarray(0, Buffer.byteLength(prefix, 'utf-8'));
      const resPrefix = resBuf.subarray(0, Buffer.byteLength(prefix, 'utf-8'));
      expect(Buffer.compare(origPrefix, resPrefix)).toBe(0);

      // Suffix after the edit must be 100% byte-identical
      const origSuffix = origBuf.subarray(origBuf.length - Buffer.byteLength(suffix, 'utf-8'));
      const resSuffix = resBuf.subarray(resBuf.length - Buffer.byteLength(suffix, 'utf-8'));
      expect(Buffer.compare(origSuffix, resSuffix)).toBe(0);
    }
  });

  it('supports unicode multibyte characters and emojis', () => {
    const original = 'const greeting = "こんにちは世界 🚀";\nconst count = 42;\n';
    const edits = [
      {
        oldText: '"こんにちは世界 🚀"',
        newText: '"こんばんは世界 ✨"',
      },
    ];

    const result = applyEdits(original, edits, 'src/i18n.ts');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('const greeting = "こんばんは世界 ✨";\nconst count = 42;\n');
    }
  });

  it('returns ok: false with line range hint when oldText matches 0 times', () => {
    const original = 'line1\nline2\nline3\nline4\nline5\n';
    const edits = [
      {
        oldText: 'nonExistentLine\n',
        newText: 'newLine\n',
      },
    ];

    const result = applyEdits(original, edits, 'src/target.ts');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('oldText matched 0 times in src/target.ts');
      expect(result.reason).toContain('re-read lines');
      expect(result.hint).toBeDefined();
      expect(result.hint?.startLine).toBeGreaterThanOrEqual(1);
    }
  });

  it('returns ok: false when oldText matches more than once (ambiguous match)', () => {
    const original = 'item\nitem\nitem\n';
    const edits = [
      {
        oldText: 'item',
        newText: 'uniqueItem',
      },
    ];

    const result = applyEdits(original, edits, 'src/list.ts');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('oldText matched 3 times in src/list.ts; ambiguous match');
    }
  });

  it('returns ok: false when edits overlap in the document', () => {
    const original = 'const name = "forge-agent";\n';
    const edits = [
      {
        oldText: 'name = "forge-agent"',
        newText: 'name = "forge"',
      },
      {
        oldText: '"forge-agent"',
        newText: '"trueforge"',
      },
    ];

    const result = applyEdits(original, edits, 'src/config.ts');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('Edits overlap in src/config.ts');
    }
  });

  it('returns ok: false when oldText is empty', () => {
    const original = 'const a = 1;\n';
    const edits = [{ oldText: '', newText: 'const b = 2;\n' }];

    const result = applyEdits(original, edits, 'src/app.ts');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('oldText must not be empty in src/app.ts');
    }
  });

  it('returns ok: false when more than 20 edits are provided', () => {
    const original = 'line\n';
    const edits = Array.from({ length: 21 }, (_, i) => ({
      oldText: `line${i}`,
      newText: `newLine${i}`,
    }));

    const result = applyEdits(original, edits);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('Too many edits: 21 provided, maximum is 20');
    }
  });
});
