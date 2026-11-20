/**
 * Unit tests for runCommand MCP tool (Milestone E-10b).
 *
 * Verifies all security guardrails: workspace trust gate, cwd containment,
 * terminal policy allowlist evaluation, confirm-tier prompting and denial,
 * output tail truncation, exit code lines, cancellation without throwing,
 * budget tracking/exhaustion, and secret/token redaction.
 */

import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import { handleRunCommand, type RunCommandArgs, type RunCommandExecutionContext } from '../../src/mcp/tools/runCommand.ts';
import { RunBudget, BUDGET_EXHAUSTED_MESSAGE, LOW_BUDGET_WARNING } from '../../src/engine/budget.ts';
import type { UiHost, CommandRequest, CommandResult, DocSnapshot, LineRange, ContextProvider, ResolvedMention, ContextItem } from '../../src/types/contract.ts';

/** Minimal stub ContextProvider for unit tests. */
class StubContextProvider implements ContextProvider {
  async resolveMention(_raw: string): Promise<ResolvedMention | null> {
    return null;
  }
  async seed(_prompt: string, _budgetTokens: number): Promise<ContextItem[]> {
    return [];
  }
  async search(_q: { query: string; glob?: string; maxResults?: number }): Promise<{ hits: { path: string; line: number; preview: string }[]; omitted: number }> {
    return { hits: [], omitted: 0 };
  }
  async findSymbol(_q: { name: string }): Promise<{ symbols: { name: string; path: string; line: number; kind: string }[] }> {
    return { symbols: [] };
  }
  async repoMap(_q: { dir?: string; depth?: number }): Promise<{ tree: string; truncated: boolean }> {
    return { tree: '', truncated: false };
  }
}

/** Configurable fake UiHost for hermetic testing without child processes. */
function createFakeHost(overrides?: Partial<UiHost>): UiHost {
  const root = path.resolve('/workspace/project');
  return {
    workspaceRoot: root,
    context: new StubContextProvider(),
    isWorkspaceTrusted: () => true,
    snapshot: async (p: string): Promise<DocSnapshot> => ({
      path: p,
      exists: true,
      text: '',
      version: 1,
      isDirty: false,
      contentHash: 'hash',
    }),
    readFile: async (_p: string, _range?: LineRange): Promise<string> => '',
    confirmCommand: async (_c: { display: string; reason: string }): Promise<boolean> => true,
    runCommand: async (_req: CommandRequest, _signal: AbortSignal): Promise<CommandResult> => ({
      exitCode: 0,
      stdout: 'all tests passed',
      stderr: '',
      truncated: false,
      timedOut: false,
      killed: false,
    }),
    ...overrides,
  };
}

describe('runCommand MCP Tool (Milestone E-10b)', () => {
  // 1. Untrusted workspace gate
  describe('Workspace Trust Gate', () => {
    it('refuses execution when workspace is untrusted with clear error and no host calls', async () => {
      const confirmSpy = vi.fn().mockResolvedValue(true);
      const runSpy = vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        truncated: false,
        timedOut: false,
        killed: false,
      });

      const host = createFakeHost({
        isWorkspaceTrusted: () => false,
        confirmCommand: confirmSpy,
        runCommand: runSpy,
      });

      const ctx: RunCommandExecutionContext = { host };
      const args: RunCommandArgs = { file: 'pytest', args: ['tests/test_cli.py', '-q'] };

      const result = await handleRunCommand(args, ctx);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Commands are disabled because this workspace is not trusted');
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(runSpy).not.toHaveBeenCalled();
    });
  });

  // 2. CWD containment & path traversal checks
  describe('CWD Containment', () => {
    it('rejects relative path traversal escaping workspace root without calling host', async () => {
      const runSpy = vi.fn();
      const host = createFakeHost({ runCommand: runSpy });
      const ctx: RunCommandExecutionContext = { host };

      const args: RunCommandArgs = {
        file: 'pytest',
        args: ['tests/test_cli.py', '-q'],
        cwd: '../external',
      };

      const result = await handleRunCommand(args, ctx);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Working directory '../external' is invalid");
      expect(runSpy).not.toHaveBeenCalled();
    });

    it('rejects absolute paths outside workspace root without calling host', async () => {
      const runSpy = vi.fn();
      const host = createFakeHost({ runCommand: runSpy });
      const ctx: RunCommandExecutionContext = { host };

      const args: RunCommandArgs = {
        file: 'pytest',
        args: ['tests/test_cli.py', '-q'],
        cwd: '/etc/forbidden',
      };

      const result = await handleRunCommand(args, ctx);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Working directory '/etc/forbidden' is invalid");
      expect(runSpy).not.toHaveBeenCalled();
    });

    it('allows valid subdirectories within workspace root', async () => {
      const runSpy = vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: 'passed',
        stderr: '',
        truncated: false,
        timedOut: false,
        killed: false,
      });
      const host = createFakeHost({ runCommand: runSpy });
      const ctx: RunCommandExecutionContext = { host };

      const args: RunCommandArgs = {
        file: 'pytest',
        args: ['tests/test_cli.py', '-q'],
        cwd: 'packages/subpkg',
      };

      const result = await handleRunCommand(args, ctx);

      expect(result.isError).toBeFalsy();
      expect(runSpy).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: 'packages/subpkg' }),
        expect.any(Object)
      );
    });
  });

  // 3. Terminal policy denial
  describe('Terminal Policy Enforcement', () => {
    it('denies forbidden commands with safety rule explanation and allowed commands list', async () => {
      const confirmSpy = vi.fn();
      const runSpy = vi.fn();
      const host = createFakeHost({ confirmCommand: confirmSpy, runCommand: runSpy });
      const ctx: RunCommandExecutionContext = { host };

      const args: RunCommandArgs = { file: 'rm', args: ['-rf', '/'] };
      const result = await handleRunCommand(args, ctx);

      expect(result.isError).toBe(true);
      // Explains it is an automatic safety rule, not user decision
      expect(result.content[0].text).toContain('Command denied by terminal safety policy (this is an automatic security rule, not a user decision)');
      // Lists permitted commands
      expect(result.content[0].text).toContain('Permitted commands are:');
      expect(result.content[0].text).toContain('pytest');
      expect(result.content[0].text).toContain('git status');
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(runSpy).not.toHaveBeenCalled();
    });

    it('denies commands with shell injection metacharacters', async () => {
      const host = createFakeHost();
      const ctx: RunCommandExecutionContext = { host };

      const args: RunCommandArgs = { file: 'git', args: ['status', '; rm -rf /'] };
      const result = await handleRunCommand(args, ctx);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Command denied by terminal safety policy');
      expect(result.content[0].text).toContain('forbidden shell characters');
    });
  });

  // 4. Human confirmation gate (confirm-deny, allow-once, allow-for-run)
  describe('Human Confirmation Gate', () => {
    it('returns exact confirm-deny message when user denies confirmation', async () => {
      const confirmSpy = vi.fn().mockResolvedValue(false);
      const runSpy = vi.fn();
      const host = createFakeHost({ confirmCommand: confirmSpy, runCommand: runSpy });
      const ctx: RunCommandExecutionContext = { host };

      const args: RunCommandArgs = { file: 'pytest', args: ['tests/test_cli.py', '-q'] };
      const result = await handleRunCommand(args, ctx);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('the user did not allow this command');
      expect(confirmSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          display: 'pytest tests/test_cli.py -q',
        })
      );
      expect(runSpy).not.toHaveBeenCalled();
    });

    it('executes command when user allows once (allow-once)', async () => {
      const confirmSpy = vi.fn().mockResolvedValue(true);
      const runSpy = vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: '1 passed in 0.05s',
        stderr: '',
        truncated: false,
        timedOut: false,
        killed: false,
      });

      const host = createFakeHost({ confirmCommand: confirmSpy, runCommand: runSpy });
      const ctx: RunCommandExecutionContext = { host };

      const args: RunCommandArgs = { file: 'pytest', args: ['tests/test_cli.py', '-q'] };
      const result = await handleRunCommand(args, ctx);

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('1 passed in 0.05s');
      expect(result.content[0].text).toContain('exit code: 0');
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(runSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          file: 'pytest',
          args: ['tests/test_cli.py', '-q'],
          timeoutMs: 60000,
          maxOutputChars: 6000,
        }),
        expect.any(Object)
      );
    });

    it('supports host remembering Allow for this run across multiple invocations', async () => {
      let allowedForRun = false;
      let promptCount = 0;

      const host = createFakeHost({
        confirmCommand: async () => {
          if (allowedForRun) {
            return true;
          }
          promptCount++;
          allowedForRun = true; // User clicked "Allow for this run"
          return true;
        },
        runCommand: async (req: CommandRequest) => ({
          exitCode: 0,
          stdout: `${req.file} finished ok`,
          stderr: '',
          truncated: false,
          timedOut: false,
          killed: false,
        }),
      });

      const ctx: RunCommandExecutionContext = { host };

      // Command 1: Prompts user and sets allowedForRun
      const res1 = await handleRunCommand({ file: 'pytest', args: ['tests/test_one.py', '-q'] }, ctx);
      expect(res1.isError).toBeFalsy();
      expect(promptCount).toBe(1);

      // Command 2: Re-uses allowedForRun state without prompting
      const res2 = await handleRunCommand({ file: 'pytest', args: ['tests/test_two.py', '-q'] }, ctx);
      expect(res2.isError).toBeFalsy();
      expect(promptCount).toBe(1);
    });

    it('runs safe read-only auto tier commands without prompting confirmation', async () => {
      const confirmSpy = vi.fn();
      const runSpy = vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: '## main',
        stderr: '',
        truncated: false,
        timedOut: false,
        killed: false,
      });

      const host = createFakeHost({ confirmCommand: confirmSpy, runCommand: runSpy });
      const ctx: RunCommandExecutionContext = { host };

      const args: RunCommandArgs = { file: 'git', args: ['status', '-sb'] };
      const result = await handleRunCommand(args, ctx);

      expect(result.isError).toBeFalsy();
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain('## main');
      expect(result.content[0].text).toContain('exit code: 0');
    });
  });

  // 5. Output capping & formatting (exit code line, tail cap)
  describe('Output Capping and Formatting', () => {
    it('always appends exit code line even when output is empty', async () => {
      const host = createFakeHost({
        runCommand: async () => ({
          exitCode: 0,
          stdout: '',
          stderr: '',
          truncated: false,
          timedOut: false,
          killed: false,
        }),
      });

      const ctx: RunCommandExecutionContext = { host };
      const result = await handleRunCommand({ file: 'git', args: ['status'] }, ctx);

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('exit code: 0');
    });

    it('preserves non-zero exit code line and marks isError true', async () => {
      const host = createFakeHost({
        runCommand: async () => ({
          exitCode: 1,
          stdout: 'FAILED tests/test_cli.py::test_entrypoint',
          stderr: 'AssertionError: expected 1 got 0',
          truncated: false,
          timedOut: false,
          killed: false,
        }),
      });

      const ctx: RunCommandExecutionContext = { host };
      const result = await handleRunCommand({ file: 'pytest', args: ['tests/test_cli.py', '-q'] }, ctx);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('FAILED tests/test_cli.py::test_entrypoint');
      expect(result.content[0].text).toContain('AssertionError: expected 1 got 0');
      expect(result.content[0].text).toContain('exit code: 1');
    });

    it('caps output to last 6000 characters (tail retained) when output is huge', async () => {
      const largeOutput = 'line-prefix-' + 'x'.repeat(10000) + '-END_OF_OUTPUT';
      const host = createFakeHost({
        runCommand: async () => ({
          exitCode: 0,
          stdout: largeOutput,
          stderr: '',
          truncated: false,
          timedOut: false,
          killed: false,
        }),
      });

      const ctx: RunCommandExecutionContext = { host };
      const result = await handleRunCommand({ file: 'git', args: ['status'] }, ctx);

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('[... truncated, showing last 6000 characters ...]');
      expect(result.content[0].text).toContain('-END_OF_OUTPUT');
      expect(result.content[0].text).toContain('exit code: 0');
      expect(result.content[0].text.length).toBeLessThan(7000);
    });

    it('notes timeout in output when command times out', async () => {
      const host = createFakeHost({
        runCommand: async () => ({
          exitCode: null,
          stdout: 'partial test run',
          stderr: '',
          truncated: false,
          timedOut: true,
          killed: true,
        }),
      });

      const ctx: RunCommandExecutionContext = { host };
      const result = await handleRunCommand({ file: 'pytest', args: ['tests/test_cli.py'] }, ctx);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('[Command timed out after 60000ms]');
      expect(result.content[0].text).toContain('exit code: none');
    });
  });

  // 6. Cancellation and exception handling (never throw)
  describe('Cancellation and Exception Resilience', () => {
    it('returns clean tool result when signal is aborted before execution', async () => {
      const controller = new AbortController();
      controller.abort();

      const runSpy = vi.fn();
      const host = createFakeHost({ runCommand: runSpy });
      const ctx: RunCommandExecutionContext = { host, signal: controller.signal };

      const result = await handleRunCommand({ file: 'git', args: ['status'] }, ctx);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Command stopped before execution.');
      expect(runSpy).not.toHaveBeenCalled();
    });

    it('catches host.runCommand rejection and returns clean error result without throwing', async () => {
      const host = createFakeHost({
        runCommand: async () => {
          throw new Error('spawn ENOENT: command not found');
        },
      });

      const ctx: RunCommandExecutionContext = { host };
      const result = await handleRunCommand({ file: 'git', args: ['status'] }, ctx);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Command execution failed: spawn ENOENT: command not found');
    });
  });

  // 7. Secret and token scrubbing
  describe('Secret and Token Redaction', () => {
    it('redacts sensitive credentials and tokens in command output', async () => {
      // Build fake credentials using string concatenation per Rule 7
      const fakeApiKey = 's' + 'k-1234567890abcdef1234567890';
      const fakeGoogleKey = 'A' + 'IzaSyD1234567890abcdef1234567890abcde';
      const fakeToken = 'secret-token-xyz-12345';

      const origToken = process.env.FORGE_MCP_TOKEN;
      process.env.FORGE_MCP_TOKEN = fakeToken;

      try {
        const host = createFakeHost({
          runCommand: async () => ({
            exitCode: 0,
            stdout: `api_key = "${fakeApiKey}", token = ${fakeToken}, gkey = ${fakeGoogleKey}`,
            stderr: '',
            truncated: false,
            timedOut: false,
            killed: false,
          }),
        });

        const ctx: RunCommandExecutionContext = { host };
        const result = await handleRunCommand({ file: 'git', args: ['status'] }, ctx);

        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).not.toContain(fakeApiKey);
        expect(result.content[0].text).not.toContain(fakeGoogleKey);
        expect(result.content[0].text).not.toContain(fakeToken);
        expect(result.content[0].text).toContain('[REDACTED_API_KEY]');
        expect(result.content[0].text).toContain('[REDACTED_TOKEN]');
      } finally {
        process.env.FORGE_MCP_TOKEN = origToken;
      }
    });
  });

  // 8. RunBudget tracking and exhaustion
  describe('Budget Tracking and Exhaustion', () => {
    it('refuses execution when budget is already exhausted', async () => {
      const budget = new RunBudget({ configuredRunLimit: 100 });
      budget.charge(100); // 100% used -> exhausted

      const runSpy = vi.fn();
      const host = createFakeHost({ runCommand: runSpy });
      const ctx: RunCommandExecutionContext = { host, budget };

      const result = await handleRunCommand({ file: 'git', args: ['status'] }, ctx);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(BUDGET_EXHAUSTED_MESSAGE);
      expect(runSpy).not.toHaveBeenCalled();
    });

    it('charges output tokens and appends low budget warning when threshold reached', async () => {
      const budget = new RunBudget({ configuredRunLimit: 1000 });
      budget.charge(820); // >= 80% -> low budget

      const host = createFakeHost({
        runCommand: async () => ({
          exitCode: 0,
          stdout: 'simple output',
          stderr: '',
          truncated: false,
          timedOut: false,
          killed: false,
        }),
      });

      const ctx: RunCommandExecutionContext = { host, budget };
      const result = await handleRunCommand({ file: 'git', args: ['status'] }, ctx);

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain(LOW_BUDGET_WARNING);
      expect(budget.getUsedTokens()).toBeGreaterThan(820);
    });
  });
});
