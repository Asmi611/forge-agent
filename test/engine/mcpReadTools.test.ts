/**
 * Comprehensive unit tests for read tool handlers (Milestone E-04).
 *
 * Verifies repoMap, searchWorkspace, findSymbol, readFile, and reportContext handlers:
 * path validation, secret denial, output caps, secret redaction, deduplication,
 * budget warnings/exhaustion, and backend error handling.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { UiHost } from '../../src/types/contract.ts';
import { RunBudget, DEDUPLICATION_NOTICE, LOW_BUDGET_WARNING, BUDGET_EXHAUSTED_MESSAGE } from '../../src/engine/budget.ts';
import { handleRepoMap } from '../../src/mcp/tools/repoMap.ts';
import { handleSearchWorkspace } from '../../src/mcp/tools/searchWorkspace.ts';
import { handleFindSymbol } from '../../src/mcp/tools/findSymbol.ts';
import { handleReadFile } from '../../src/mcp/tools/readFile.ts';
import { handleReportContext } from '../../src/mcp/tools/reportContext.ts';

describe('MCP Read Tools Handlers', () => {
  let tempDir: string;
  let workspaceRoot: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-read-tools-'));
    workspaceRoot = path.join(tempDir, 'workspace');

    fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, 'docs'), { recursive: true });

    // Safe files
    fs.writeFileSync(path.join(workspaceRoot, 'src', 'main.ts'), 'export const app = "forge";\n', 'utf-8');
    fs.writeFileSync(path.join(workspaceRoot, 'README.md'), '# Documentation\n', 'utf-8');

    // Secret file
    fs.writeFileSync(path.join(workspaceRoot, '.env'), 'API_SECRET=supersecret\n', 'utf-8');
    fs.writeFileSync(path.join(workspaceRoot, 'cert.pem'), 'CERT\n', 'utf-8');

    // Large file (>1MB)
    const largeBuf = Buffer.alloc(1024 * 1024 + 50, 0x61);
    fs.writeFileSync(path.join(workspaceRoot, 'large.txt'), largeBuf);

    // Binary file
    fs.writeFileSync(path.join(workspaceRoot, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

    // Long file (>200 lines)
    const longLines = Array.from({ length: 250 }, (_, i) => `// Line number ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(workspaceRoot, 'src', 'long.ts'), longLines, 'utf-8');
  });

  afterAll(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  function createTestHost(overrides?: Partial<UiHost>): UiHost {
    return {
      workspaceRoot,
      isWorkspaceTrusted: () => true,
      context: {
        resolveMention: async () => null,
        seed: async () => [],
        search: async () => ({ hits: [], omitted: 0 }),
        findSymbol: async () => ({ symbols: [] }),
        repoMap: async () => ({ tree: 'src/\n  main.ts\nREADME.md', truncated: false }),
        ...overrides?.context,
      },
      snapshot: async (p: string) => ({
        path: p,
        exists: true,
        text: '',
        version: null,
        isDirty: false,
        contentHash: 'hash',
      }),
      readFile: async (p: string, range?: { startLine: number; endLine: number }) => {
        const full = path.join(workspaceRoot, p);
        const text = fs.readFileSync(full, 'utf-8');
        if (!range) {
          return text;
        }
        const lines = text.split(/\r?\n/);
        return lines.slice(range.startLine - 1, range.endLine).join('\n');
      },
      runCommand: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false,
        killed: false,
      }),
      confirmCommand: async () => true,
      ...overrides,
    };
  }

  describe('repoMap', () => {
    it('returns repository structure from host context provider', async () => {
      const host = createTestHost();
      const budget = new RunBudget();

      const result = await handleRepoMap({}, { host, budget });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('src/');
      expect(result.content[0].text).toContain('main.ts');
      expect(budget.getUsedTokens()).toBeGreaterThan(0);
    });

    it('rejects directory traversal in dir argument', async () => {
      const host = createTestHost();
      const result = await handleRepoMap({ dir: '../outside' }, { host });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Directory validation failed');
    });

    it('deduplicates identical repeat calls', async () => {
      const host = createTestHost();
      const budget = new RunBudget();

      const first = await handleRepoMap({ dir: 'src' }, { host, budget });
      expect(first.content[0].text).toContain('src/');

      const second = await handleRepoMap({ dir: 'src' }, { host, budget });
      expect(second.content[0].text).toBe(DEDUPLICATION_NOTICE);
    });

    it('appends low budget warning when budget is >= 80%', async () => {
      const host = createTestHost();
      const budget = new RunBudget({ configuredRunLimit: 1000, modelContextTokens: 100000 });
      budget.charge(850); // 85%

      const result = await handleRepoMap({}, { host, budget });
      expect(result.content[0].text).toContain(LOW_BUDGET_WARNING);
    });

    it('refuses execution when budget is 100% exhausted', async () => {
      const host = createTestHost();
      const budget = new RunBudget({ configuredRunLimit: 1000, modelContextTokens: 100000 });
      budget.charge(1000);

      const result = await handleRepoMap({}, { host, budget });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(BUDGET_EXHAUSTED_MESSAGE);
    });

    it('handles backend context provider failures gracefully', async () => {
      const host = createTestHost({
        context: {
          resolveMention: async () => null,
          seed: async () => [],
          search: async () => ({ hits: [], omitted: 0 }),
          findSymbol: async () => ({ symbols: [] }),
          repoMap: async () => {
            throw new Error('Disk read timeout');
          },
        },
      });

      const result = await handleRepoMap({}, { host });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to generate repository map: Disk read timeout');
    });
  });

  describe('searchWorkspace', () => {
    it('returns formatted search hits with preview length limits and secret redaction', async () => {
      const fakeKey = 'sk-' + '1234567890abcdef1234567890';
      const host = createTestHost({
        context: {
          resolveMention: async () => null,
          seed: async () => [],
          search: async () => ({
            hits: [
              {
                path: 'src/main.ts',
                line: 1,
                preview: `const apiKey = "${fakeKey}"; // secret`,
              },
            ],
            omitted: 0,
          }),
          findSymbol: async () => ({ symbols: [] }),
          repoMap: async () => ({ tree: '', truncated: false }),
        },
      });

      const result = await handleSearchWorkspace({ query: 'apiKey' }, { host });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('src/main.ts:1:');
      // Verify redaction
      expect(result.content[0].text).not.toContain(fakeKey);
      expect(result.content[0].text).toContain('[REDACTED_API_KEY]');
    });

    it('filters out secret files from search results', async () => {
      const host = createTestHost({
        context: {
          resolveMention: async () => null,
          seed: async () => [],
          search: async () => ({
            hits: [
              { path: '.env', line: 1, preview: 'SECRET=123' },
              { path: 'src/main.ts', line: 5, preview: 'const safe = true;' },
            ],
            omitted: 0,
          }),
          findSymbol: async () => ({ symbols: [] }),
          repoMap: async () => ({ tree: '', truncated: false }),
        },
      });

      const result = await handleSearchWorkspace({ query: 'SECRET' }, { host });
      expect(result.content[0].text).not.toContain('.env');
      expect(result.content[0].text).toContain('src/main.ts:5: const safe = true;');
    });

    it('caps results at 20 hits and reports omitted count', async () => {
      const hits = Array.from({ length: 30 }, (_, i) => ({
        path: `src/file_${i}.ts`,
        line: 10,
        preview: `match ${i}`,
      }));

      const host = createTestHost({
        context: {
          resolveMention: async () => null,
          seed: async () => [],
          search: async () => ({ hits, omitted: 5 }),
          findSymbol: async () => ({ symbols: [] }),
          repoMap: async () => ({ tree: '', truncated: false }),
        },
      });

      const result = await handleSearchWorkspace({ query: 'match' }, { host });
      expect(result.content[0].text).toContain('src/file_0.ts:10:');
      expect(result.content[0].text).toContain('src/file_19.ts:10:');
      expect(result.content[0].text).not.toContain('src/file_20.ts:10:');
      // 10 omitted from capping + 5 omitted from backend = 15 omitted
      expect(result.content[0].text).toContain('... (15 more match(es) omitted)');
    });

    it('returns friendly message on empty results', async () => {
      const host = createTestHost();
      const result = await handleSearchWorkspace({ query: 'nonExistentTerm' }, { host });
      expect(result.content[0].text).toContain("No matches found for query 'nonExistentTerm'.");
    });

    it('rejects empty query', async () => {
      const host = createTestHost();
      const result = await handleSearchWorkspace({ query: '   ' }, { host });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Search query cannot be empty');
    });

    it('deduplicates identical repeat searches', async () => {
      const host = createTestHost();
      const budget = new RunBudget();

      await handleSearchWorkspace({ query: 'term' }, { host, budget });
      const repeat = await handleSearchWorkspace({ query: 'term' }, { host, budget });
      expect(repeat.content[0].text).toBe(DEDUPLICATION_NOTICE);
    });

    it('refuses search when budget is exhausted', async () => {
      const host = createTestHost();
      const budget = new RunBudget({ configuredRunLimit: 1000, modelContextTokens: 100000 });
      budget.charge(1000);

      const result = await handleSearchWorkspace({ query: 'term' }, { host, budget });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(BUDGET_EXHAUSTED_MESSAGE);
    });
  });

  describe('findSymbol', () => {
    it('returns matching symbol definitions with kind, path, and line', async () => {
      const host = createTestHost({
        context: {
          resolveMention: async () => null,
          seed: async () => [],
          search: async () => ({ hits: [], omitted: 0 }),
          findSymbol: async () => ({
            symbols: [
              { name: 'UserService', path: 'src/user.ts', line: 12, kind: 'class' },
              { name: 'getUser', path: 'src/user.ts', line: 45, kind: 'function' },
            ],
          }),
          repoMap: async () => ({ tree: '', truncated: false }),
        },
      });

      const result = await handleFindSymbol({ name: 'User' }, { host });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('UserService (class) at src/user.ts:12');
      expect(result.content[0].text).toContain('getUser (function) at src/user.ts:45');
    });

    it('enforces top 10 symbol limit and reports omitted count', async () => {
      const symbols = Array.from({ length: 15 }, (_, i) => ({
        name: `Symbol_${i}`,
        path: `src/mod_${i}.ts`,
        line: i + 1,
        kind: 'const',
      }));

      const host = createTestHost({
        context: {
          resolveMention: async () => null,
          seed: async () => [],
          search: async () => ({ hits: [], omitted: 0 }),
          findSymbol: async () => ({ symbols }),
          repoMap: async () => ({ tree: '', truncated: false }),
        },
      });

      const result = await handleFindSymbol({ name: 'Symbol' }, { host });
      expect(result.content[0].text).toContain('Symbol_0 (const) at src/mod_0.ts:1');
      expect(result.content[0].text).toContain('Symbol_9 (const) at src/mod_9.ts:10');
      expect(result.content[0].text).not.toContain('Symbol_10 (const)');
      expect(result.content[0].text).toContain('... (5 more symbol(s) omitted)');
    });

    it('filters out secret files from symbol results', async () => {
      const host = createTestHost({
        context: {
          resolveMention: async () => null,
          seed: async () => [],
          search: async () => ({ hits: [], omitted: 0 }),
          findSymbol: async () => ({
            symbols: [
              { name: 'SecretConfig', path: '.env', line: 1, kind: 'variable' },
              { name: 'SafeConfig', path: 'src/main.ts', line: 5, kind: 'variable' },
            ],
          }),
          repoMap: async () => ({ tree: '', truncated: false }),
        },
      });

      const result = await handleFindSymbol({ name: 'Config' }, { host });
      expect(result.content[0].text).not.toContain('.env');
      expect(result.content[0].text).toContain('SafeConfig (variable) at src/main.ts:5');
    });

    it('returns friendly message when no symbols found', async () => {
      const host = createTestHost();
      const result = await handleFindSymbol({ name: 'missing' }, { host });
      expect(result.content[0].text).toContain("No symbols found matching 'missing'.");
    });

    it('deduplicates identical repeat symbol queries', async () => {
      const host = createTestHost();
      const budget = new RunBudget();

      await handleFindSymbol({ name: 'myFunc' }, { host, budget });
      const repeat = await handleFindSymbol({ name: 'myFunc' }, { host, budget });
      expect(repeat.content[0].text).toBe(DEDUPLICATION_NOTICE);
    });

    it('refuses symbol lookup when budget is exhausted', async () => {
      const host = createTestHost();
      const budget = new RunBudget({ configuredRunLimit: 1000, modelContextTokens: 100000 });
      budget.charge(1000);

      const result = await handleFindSymbol({ name: 'myFunc' }, { host, budget });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(BUDGET_EXHAUSTED_MESSAGE);
    });
  });

  describe('readFile', () => {
    it('reads full file content when within line and token caps', async () => {
      const host = createTestHost();
      const budget = new RunBudget();

      const result = await handleReadFile({ path: 'src/main.ts' }, { host, budget });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('export const app = "forge";');
    });

    it('reads specific line ranges accurately', async () => {
      const host = createTestHost();
      const result = await handleReadFile(
        { path: 'src/long.ts', range: { startLine: 10, endLine: 12 } },
        { host }
      );

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('// Line number 10');
      expect(result.content[0].text).toContain('// Line number 12');
      expect(result.content[0].text).not.toContain('// Line number 13');
    });

    it('truncates content exceeding 200 lines with informative header', async () => {
      const host = createTestHost();
      const result = await handleReadFile({ path: 'src/long.ts' }, { host });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('truncated to 200 lines');
      expect(result.content[0].text).toContain('// Line number 1');
      expect(result.content[0].text).toContain('// Line number 200');
      expect(result.content[0].text).not.toContain('// Line number 201');
    });

    it('rejects path traversal attempting to escape workspace root', async () => {
      const host = createTestHost();
      const result = await handleReadFile({ path: '../outside.txt' }, { host });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Path validation failed');
      expect(result.content[0].text).toContain('resolves outside workspace root');
    });

    it('rejects secret files (.env, cert.pem)', async () => {
      const host = createTestHost();
      const resEnv = await handleReadFile({ path: '.env' }, { host });
      expect(resEnv.isError).toBe(true);
      expect(resEnv.content[0].text).toContain('Access to secret file');

      const resPem = await handleReadFile({ path: 'cert.pem' }, { host });
      expect(resPem.isError).toBe(true);
      expect(resPem.content[0].text).toContain('Access to secret file');
    });

    it('rejects binary files (.png)', async () => {
      const host = createTestHost();
      const result = await handleReadFile({ path: 'image.png' }, { host });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('File access rejected');
      expect(result.content[0].text).toContain('binary');
    });

    it('rejects files exceeding 1 MB limit', async () => {
      const host = createTestHost();
      const result = await handleReadFile({ path: 'large.txt' }, { host });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('File access rejected');
      expect(result.content[0].text).toContain('exceeds maximum size limit');
    });

    it('rejects non-existent file', async () => {
      const host = createTestHost();
      const result = await handleReadFile({ path: 'src/missing.ts' }, { host });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('File not found');
    });

    it('rejects invalid range where startLine > endLine', async () => {
      const host = createTestHost();
      const result = await handleReadFile(
        { path: 'src/main.ts', range: { startLine: 10, endLine: 5 } },
        { host }
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid line range');
    });

    it('deduplicates identical repeat reads of same path and range', async () => {
      const host = createTestHost();
      const budget = new RunBudget();

      await handleReadFile({ path: 'src/main.ts' }, { host, budget });
      const repeat = await handleReadFile({ path: 'src/main.ts' }, { host, budget });
      expect(repeat.content[0].text).toBe(DEDUPLICATION_NOTICE);
    });

    it('refuses readFile when budget is exhausted', async () => {
      const host = createTestHost();
      const budget = new RunBudget({ configuredRunLimit: 1000, modelContextTokens: 100000 });
      budget.charge(1000);

      const result = await handleReadFile({ path: 'src/main.ts' }, { host, budget });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(BUDGET_EXHAUSTED_MESSAGE);
    });
  });

  describe('reportContext', () => {
    it('acknowledges reported context items with count and list', async () => {
      const host = createTestHost();
      const budget = new RunBudget();

      const items = [
        { path: 'src/main.ts', reason: 'Defines main entrypoint' },
        { path: 'README.md', reason: 'Describes architecture' },
      ];

      const result = await handleReportContext({ items }, { host, budget });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Context reported: 2 file(s) recorded.');
      expect(result.content[0].text).toContain('- src/main.ts: Defines main entrypoint');
      expect(result.content[0].text).toContain('- README.md: Describes architecture');
      expect(budget.getUsedTokens()).toBeGreaterThan(0);
    });

    it('handles empty items array gracefully', async () => {
      const host = createTestHost();
      const result = await handleReportContext({ items: [] }, { host });
      expect(result.content[0].text).toContain('Context reported: 0 items provided.');
    });

    it('caps reported items at 20 and reports omitted count', async () => {
      const host = createTestHost();
      const items = Array.from({ length: 25 }, (_, i) => ({
        path: `src/file_${i}.ts`,
        reason: `Reason ${i}`,
      }));

      const result = await handleReportContext({ items }, { host });
      expect(result.content[0].text).toContain('Context reported: 20 file(s) recorded.');
      expect(result.content[0].text).toContain('- src/file_0.ts: Reason 0');
      expect(result.content[0].text).toContain('- src/file_19.ts: Reason 19');
      expect(result.content[0].text).not.toContain('- src/file_20.ts');
      expect(result.content[0].text).toContain('... (5 additional item(s) omitted; maximum is 20)');
    });

    it('remains available and charges tokens even when budget is exhausted', async () => {
      const host = createTestHost();
      const budget = new RunBudget({ configuredRunLimit: 1000, modelContextTokens: 100000 });
      budget.charge(1000); // 100% exhausted

      // reportContext is explicitly allowed per Card E-04 when budget is exhausted
      const result = await handleReportContext(
        { items: [{ path: 'src/main.ts', reason: 'Key entrypoint' }] },
        { host, budget }
      );

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Context reported: 1 file(s) recorded.');
    });
  });
});
