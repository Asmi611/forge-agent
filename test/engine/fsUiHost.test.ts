/**
 * Unit and integration tests for FsUiHost and its integration with engine-cli.
 *
 * Verifies real file system reads, line range slicing, path traversal defense,
 * document snapshot hashing, MockUiHost preservation, and engine-cli host resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { FsUiHost } from '../../src/engine/FsUiHost.ts';
import { MockUiHost } from '../../src/mocks/MockUiHost.ts';
import { runCli } from '../../scripts/engine-cli.ts';
import type { UiHost } from '../../src/types/contract.ts';
import type { EngineConfig } from '../../src/engine/config.ts';
import type { McpToolServer } from '../../src/mcp/McpToolServer.ts';

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
        port: 8880,
        path: '/mcp',
        perWorkspace: false,
        token: 'test-token',
      },
      budgets: {
        seedTokens: 1000,
        mentionsTokens: 500,
        runToolBudgetTokens: 10000,
        maxToolCalls: 10,
        maxRunSeconds: 60,
      },
      retry: {
        max: 3,
        baseDelayMs: 100,
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

describe('FsUiHost', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fs-ui-host-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore temp dir cleanup errors
    }
  });

  describe('Constructor & Workspace Validation', () => {
    it('initializes with a valid workspace root and marks workspace as trusted', () => {
      const host = new FsUiHost(tempDir);
      expect(host.workspaceRoot).toBe(path.resolve(tempDir));
      expect(host.isWorkspaceTrusted()).toBe(true);
      expect(host.context).toBeDefined();
    });

    it('throws if workspace root is empty or whitespace', () => {
      expect(() => new FsUiHost('')).toThrow('FsUiHost: workspaceRoot must be a non-empty string');
      // @ts-expect-error - testing invalid argument type
      expect(() => new FsUiHost(null)).toThrow('FsUiHost: workspaceRoot must be a non-empty string');
    });
  });

  describe('readFile()', () => {
    it('reads the complete content of an existing file when no range is provided', async () => {
      const filePath = path.join(tempDir, 'sample.txt');
      const expectedText = 'line 1\nline 2\nline 3\nline 4\nline 5';
      fs.writeFileSync(filePath, expectedText, 'utf-8');

      const host = new FsUiHost(tempDir);
      const content = await host.readFile('sample.txt');
      expect(content).toBe(expectedText);
    });

    it('reads a 1-based line range correctly', async () => {
      const filePath = path.join(tempDir, 'multiline.txt');
      const lines = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

      const host = new FsUiHost(tempDir);
      const slice = await host.readFile('multiline.txt', { startLine: 2, endLine: 4 });
      expect(slice).toBe('beta\ngamma\ndelta');
    });

    it('reads a single line range correctly', async () => {
      const filePath = path.join(tempDir, 'single.txt');
      fs.writeFileSync(filePath, 'one\ntwo\nthree', 'utf-8');

      const host = new FsUiHost(tempDir);
      const line1 = await host.readFile('single.txt', { startLine: 1, endLine: 1 });
      expect(line1).toBe('one');
      const line2 = await host.readFile('single.txt', { startLine: 2, endLine: 2 });
      expect(line2).toBe('two');
    });

    it('clamps endLine if it exceeds the total line count', async () => {
      const filePath = path.join(tempDir, 'short.txt');
      fs.writeFileSync(filePath, 'first\nsecond', 'utf-8');

      const host = new FsUiHost(tempDir);
      const result = await host.readFile('short.txt', { startLine: 1, endLine: 100 });
      expect(result).toBe('first\nsecond');
    });

    it('returns empty string if startLine is beyond the file line count', async () => {
      const filePath = path.join(tempDir, 'short.txt');
      fs.writeFileSync(filePath, 'first\nsecond', 'utf-8');

      const host = new FsUiHost(tempDir);
      const result = await host.readFile('short.txt', { startLine: 10, endLine: 20 });
      expect(result).toBe('');
    });

    it('throws if startLine is greater than endLine', async () => {
      const filePath = path.join(tempDir, 'test.txt');
      fs.writeFileSync(filePath, 'some content', 'utf-8');

      const host = new FsUiHost(tempDir);
      await expect(host.readFile('test.txt', { startLine: 5, endLine: 2 })).rejects.toThrow(
        'Invalid line range: startLine (5) cannot be greater than endLine (2)'
      );
    });

    it('handles Windows-style relative paths with backslashes', async () => {
      const subDir = path.join(tempDir, 'subfolder');
      fs.mkdirSync(subDir);
      const filePath = path.join(subDir, 'nested.txt');
      fs.writeFileSync(filePath, 'nested content', 'utf-8');

      const host = new FsUiHost(tempDir);
      const content = await host.readFile('subfolder\\nested.txt');
      expect(content).toBe('nested content');
    });

    it('rejects paths that resolve outside the workspace root', async () => {
      const host = new FsUiHost(tempDir);
      await expect(host.readFile('../secret.txt')).rejects.toThrow(
        `resolves outside workspace root`
      );
      await expect(host.readFile(path.join(tempDir, '..', 'external.txt'))).rejects.toThrow(
        `resolves outside workspace root`
      );
    });

    it('rejects directory paths with a descriptive error', async () => {
      const subDir = path.join(tempDir, 'somedir');
      fs.mkdirSync(subDir);

      const host = new FsUiHost(tempDir);
      await expect(host.readFile('somedir')).rejects.toThrow(
        "is a directory, not a file"
      );
    });

    it('rejects non-existent files with a descriptive error', async () => {
      const host = new FsUiHost(tempDir);
      await expect(host.readFile('nonexistent.txt')).rejects.toThrow(
        "File not found: 'nonexistent.txt'"
      );
    });

    it('rejects empty paths or null-byte paths', async () => {
      const host = new FsUiHost(tempDir);
      await expect(host.readFile('')).rejects.toThrow('Path argument cannot be empty');
      await expect(host.readFile('   ')).rejects.toThrow('Path argument cannot be empty');
      await expect(host.readFile('bad\0path.txt')).rejects.toThrow('Path contains illegal null byte character');
    });
  });

  describe('snapshot()', () => {
    it('returns a valid DocSnapshot with LF-normalized SHA-256 for an existing file', async () => {
      const filePath = path.join(tempDir, 'doc.txt');
      const textWithCrlf = 'line1\r\nline2\r\nline3\r\n';
      fs.writeFileSync(filePath, textWithCrlf, 'utf-8');

      const host = new FsUiHost(tempDir);
      const snapshot = await host.snapshot('doc.txt');

      expect(snapshot.exists).toBe(true);
      expect(snapshot.path).toBe('doc.txt');
      expect(snapshot.text).toBe(textWithCrlf);
      expect(snapshot.version).toBe(1);
      expect(snapshot.isDirty).toBe(false);

      // Verify SHA-256 is calculated on LF-normalized content
      const lfNormalized = textWithCrlf.replace(/\r\n/g, '\n');
      const expectedHash = crypto.createHash('sha256').update(lfNormalized).digest('hex');
      expect(snapshot.contentHash).toBe(expectedHash);
    });

    it('returns exists:false with all-zeros hash for non-existent file', async () => {
      const host = new FsUiHost(tempDir);
      const snapshot = await host.snapshot('missing.txt');

      expect(snapshot.exists).toBe(false);
      expect(snapshot.path).toBe('missing.txt');
      expect(snapshot.text).toBe('');
      expect(snapshot.version).toBeNull();
      expect(snapshot.isDirty).toBe(false);
      expect(snapshot.contentHash).toBe('0'.repeat(64));
    });

    it('returns exists:false for a directory path', async () => {
      const subDir = path.join(tempDir, 'dirOnly');
      fs.mkdirSync(subDir);

      const host = new FsUiHost(tempDir);
      const snapshot = await host.snapshot('dirOnly');
      expect(snapshot.exists).toBe(false);
      expect(snapshot.contentHash).toBe('0'.repeat(64));
    });

    it('returns exists:false for path outside workspace', async () => {
      const host = new FsUiHost(tempDir);
      const snapshot = await host.snapshot('../external.txt');
      expect(snapshot.exists).toBe(false);
      expect(snapshot.contentHash).toBe('0'.repeat(64));
    });
  });

  describe('context (FsContextProvider)', () => {
    it('generates a directory tree via repoMap ignoring hidden files and node_modules', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'));
      fs.writeFileSync(path.join(tempDir, 'src', 'index.ts'), '// index');
      fs.mkdirSync(path.join(tempDir, 'node_modules'));
      fs.writeFileSync(path.join(tempDir, 'node_modules', 'dep.js'), '// dep');
      fs.writeFileSync(path.join(tempDir, '.hidden.txt'), 'secret');
      fs.writeFileSync(path.join(tempDir, 'root.txt'), 'hello');

      const host = new FsUiHost(tempDir);
      const map = await host.context.repoMap({});

      expect(map.tree).toContain('src/');
      expect(map.tree).toContain('index.ts');
      expect(map.tree).toContain('root.txt');
      expect(map.tree).not.toContain('node_modules');
      expect(map.tree).not.toContain('.hidden.txt');
      expect(map.truncated).toBe(false);
    });

    it('returns empty repoMap for non-existent or out-of-boundary directory', async () => {
      const host = new FsUiHost(tempDir);
      const map = await host.context.repoMap({ dir: 'does_not_exist' });
      expect(map.tree).toBe('');
      expect(map.truncated).toBe(false);

      const outsideMap = await host.context.repoMap({ dir: '../outside' });
      expect(outsideMap.tree).toBe('');
      expect(outsideMap.truncated).toBe(false);
    });

    it('returns safe default results for unsupported context methods in CLI mode', async () => {
      const host = new FsUiHost(tempDir);
      expect(await host.context.resolveMention('mention')).toBeNull();
      expect(await host.context.seed('prompt', 1000)).toEqual([]);
      expect(await host.context.search({ query: 'test' })).toEqual({ hits: [], omitted: 0 });
      expect(await host.context.findSymbol({ name: 'Foo' })).toEqual({ symbols: [] });
    });
  });

  describe('runCommand() & confirmCommand() Safety Guardrails', () => {
    it('refuses command execution with non-zero exit code and error in stderr (never reports false success)', async () => {
      const host = new FsUiHost(tempDir);
      const cmdResult = await host.runCommand({
        file: 'echo',
        args: ['hello'],
        timeoutMs: 1000,
        maxOutputChars: 1000,
      });

      // Must never falsely report success
      expect(cmdResult.exitCode).toBe(1);
      expect(cmdResult.exitCode).not.toBe(0);
      expect(cmdResult.stdout).toBe('');
      expect(cmdResult.stderr).toContain('Command execution is not supported in standalone CLI mode (FsUiHost)');
      expect(cmdResult.truncated).toBe(false);
      expect(cmdResult.timedOut).toBe(false);
      expect(cmdResult.killed).toBe(false);
    });

    it('reports killed: true when signal was already aborted', async () => {
      const host = new FsUiHost(tempDir);
      const abortCtrl = new AbortController();
      abortCtrl.abort();

      const cmdResult = await host.runCommand(
        {
          file: 'pytest',
          args: ['tests'],
          timeoutMs: 1000,
          maxOutputChars: 1000,
        },
        abortCtrl.signal
      );

      expect(cmdResult.exitCode).toBe(1);
      expect(cmdResult.killed).toBe(true);
    });

    it('never automatically or silently approves confirm-tier commands (confirmCommand returns false)', async () => {
      const host = new FsUiHost(tempDir);

      // Confirm-tier command test
      const testConfirmed = await host.confirmCommand({ display: 'npm test', reason: 'run unit tests' });
      expect(testConfirmed).toBe(false);
      expect(testConfirmed).not.toBe(true);

      // Pytest confirm command test
      const pytestConfirmed = await host.confirmCommand({ display: 'pytest tests/test_app.py', reason: 'run pytest' });
      expect(pytestConfirmed).toBe(false);

      // Arbitrary command test
      const anyConfirmed = await host.confirmCommand({ display: 'git status', reason: 'check status' });
      expect(anyConfirmed).toBe(false);
    });
  });

  describe('MockUiHost Preservation', () => {
    it('verifies MockUiHost continues to work as expected without changes', async () => {
      const mockHost = new MockUiHost(tempDir);
      expect(mockHost.isWorkspaceTrusted()).toBe(true);

      // Range returns synthetic lines
      const rangeContent = await mockHost.readFile('any/file.txt', { startLine: 1, endLine: 3 });
      expect(rangeContent).toBe('mock line 1\nmock line 2\nmock line 3');

      // Undefined range returns empty string in MockUiHost
      const emptyContent = await mockHost.readFile('any/file.txt');
      expect(emptyContent).toBe('');

      // Snapshot returns mock values
      const snapshot = await mockHost.snapshot('any/file.txt');
      expect(snapshot.exists).toBe(false);
      expect(snapshot.contentHash).toBe('0'.repeat(64));
      expect(snapshot.version).toBeNull();
    });
  });

  describe('engine-cli Host Resolution', () => {
    it('uses FsUiHost by default when deps.host is not injected', async () => {
      let passedHost: UiHost | undefined;

      const code = await runCli(['--forgeDir', 'forge', 'cli host test'], {
        config: createMockConfig(),
        healthCheck: async () => ({ ok: true }),
        startToolServer: async (opts) => {
          passedHost = opts.host;
          return {
            url: 'http://127.0.0.1:8799/mcp',
            port: 8799,
            token: 'test-token',
            server: null as unknown as McpToolServer,
            stop: async () => {},
          };
        },
        engine: {
          runInline: async function* () {},
          runAgent: async function* () {
            yield { type: 'run.completed' as const, summary: 'cli finished' };
          },
          cancel: async () => {},
          reviewDone: async () => {},
          switchModel: async () => {},
          activeModel: () => 'forge-primary',
        },
        stdout: () => {},
        stderr: () => {},
        workspaceRoot: tempDir,
      });

      expect(code).toBe(0);
      expect(passedHost).toBeDefined();
      expect(passedHost).toBeInstanceOf(FsUiHost);
      expect(passedHost?.workspaceRoot).toBe(path.resolve(tempDir));
    });

    it('respects an injected host when deps.host is explicitly provided', async () => {
      let passedHost: UiHost | undefined;
      const customMockHost = new MockUiHost(tempDir);

      const code = await runCli(['--forgeDir', 'forge', 'custom host test'], {
        host: customMockHost,
        config: createMockConfig(),
        healthCheck: async () => ({ ok: true }),
        startToolServer: async (opts) => {
          passedHost = opts.host;
          return {
            url: 'http://127.0.0.1:8799/mcp',
            port: 8799,
            token: 'test-token',
            server: null as unknown as McpToolServer,
            stop: async () => {},
          };
        },
        engine: {
          runInline: async function* () {},
          runAgent: async function* () {
            yield { type: 'run.completed' as const, summary: 'cli finished' };
          },
          cancel: async () => {},
          reviewDone: async () => {},
          switchModel: async () => {},
          activeModel: () => 'forge-primary',
        },
        stdout: () => {},
        stderr: () => {},
        workspaceRoot: tempDir,
      });

      expect(code).toBe(0);
      expect(passedHost).toBe(customMockHost);
      expect(passedHost).toBeInstanceOf(MockUiHost);
    });
  });
});
