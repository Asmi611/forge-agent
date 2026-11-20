/**
 * MCP Tool: runCommand (Milestones E-10a / E-10b).
 *
 * Exposes allowed command execution to the TrueForge agent loop within
 * strict security bounds: workspace trust verification, terminal policy
 * tier evaluation, user confirmation for confirm-tier commands, execution
 * via host.runCommand (execFile, shell: false), output tail truncation
 * (6000 chars), budget tracking, and secret/credential redaction.
 */

import * as path from 'node:path';
import { z } from 'zod';
import {
  COMMAND_TIMEOUT_MS,
  MAX_COMMAND_OUTPUT_CHARS,
  truncateTail,
  type ToolExecutionContext,
  type ToolCallResult,
} from '../limits.ts';
import { evaluate } from '../terminalPolicy.ts';
import { redactSecrets } from '../secretGuard.ts';
import {
  LOW_BUDGET_WARNING,
  BUDGET_EXHAUSTED_MESSAGE,
} from '../../engine/budget.ts';

/** Tool name matching the frozen contract. */
export const RUN_COMMAND_TOOL_NAME = 'runCommand';

/** Input schema for runCommand tool conforming to contract v2.1.0 ToolArgs['runCommand']. */
export const runCommandInputSchema = z.object({
  file: z.string().min(1).describe('Executable name without path separators (e.g. pytest, npm)'),
  args: z.array(z.string()).describe('Array of command line arguments'),
  cwd: z.string().optional().describe('Workspace directory to execute command in'),
});

export type RunCommandArgs = z.infer<typeof runCommandInputSchema>;

/** Tool description conforming to standard format with usage hints. */
export const RUN_COMMAND_TOOL_DESCRIPTION =
  'Execute an allowed terminal command within policy tiers.\nUse when running test suites or checking git status after changes.';

/** Execution context for runCommand extending standard ToolExecutionContext with optional abort signal. */
export interface RunCommandExecutionContext extends ToolExecutionContext {
  signal?: AbortSignal;
}

/**
 * Handles runCommand MCP tool execution.
 *
 * @param args - Validated arguments containing file, args, and optional cwd
 * @param ctx - Execution context providing UiHost, optional RunBudget, and optional AbortSignal
 * @returns Standard MCP tool call result containing output text and exit status
 */
export async function handleRunCommand(
  args: RunCommandArgs,
  ctx: RunCommandExecutionContext
): Promise<ToolCallResult> {
  // 1. Refuse if run budget is already exhausted
  if (ctx.budget?.isExhausted()) {
    return {
      content: [{ type: 'text', text: BUDGET_EXHAUSTED_MESSAGE }],
      isError: true,
    };
  }

  // 2. Cancellation check before starting
  if (ctx.signal?.aborted) {
    return {
      content: [{ type: 'text', text: 'Command stopped before execution.' }],
      isError: true,
    };
  }

  // 3. Workspace Trust Gate (contract §4 / docs/03 T12)
  if (!ctx.host.isWorkspaceTrusted()) {
    return {
      content: [
        {
          type: 'text',
          text: 'Commands are disabled because this workspace is not trusted. Please trust the workspace in VS Code to run commands.',
        },
      ],
      isError: true,
    };
  }

  // 4. Validate cwd containment inside workspaceRoot (reject escapes and absolute paths)
  if (args.cwd !== undefined && args.cwd !== '' && args.cwd !== '.') {
    const normCwd = args.cwd.replace(/\\/g, '/');
    if (
      normCwd.includes('..') ||
      path.isAbsolute(args.cwd) ||
      /^[a-zA-Z]:/.test(args.cwd)
    ) {
      return {
        content: [
          {
            type: 'text',
            text: `Working directory '${args.cwd}' is invalid. Working directory must be inside workspace root without traversal.`,
          },
        ],
        isError: true,
      };
    }

    const resolvedCwd = path.resolve(ctx.host.workspaceRoot, args.cwd);
    const relative = path.relative(ctx.host.workspaceRoot, resolvedCwd);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return {
        content: [
          {
            type: 'text',
            text: `Working directory '${args.cwd}' escapes workspace root. Commands must run inside the workspace.`,
          },
        ],
        isError: true,
      };
    }
  }

  // 5. Evaluate terminal policy (pure security allowlist)
  const evaluation = evaluate({
    file: args.file,
    args: args.args,
    cwd: args.cwd,
  });

  if (evaluation.tier === 'deny') {
    return {
      content: [
        {
          type: 'text',
          text: `Command denied by terminal safety policy (this is an automatic security rule, not a user decision): ${evaluation.reason}`,
        },
      ],
      isError: true,
    };
  }

  // 6. User confirmation if policy tier is 'confirm'
  if (evaluation.tier === 'confirm') {
    let allowed = false;
    try {
      allowed = await ctx.host.confirmCommand({
        display: evaluation.normalizedDisplay,
        reason: evaluation.reason,
      });
    } catch {
      allowed = false;
    }

    if (!allowed) {
      return {
        content: [
          {
            type: 'text',
            text: 'the user did not allow this command',
          },
        ],
        isError: true,
      };
    }
  }

  // 7. Cancellation check before host dispatch
  if (ctx.signal?.aborted) {
    return {
      content: [{ type: 'text', text: 'Command stopped before execution.' }],
      isError: true,
    };
  }

  // 8. Execute via host.runCommand (argv-level, shell: false, execFile)
  const controller = new AbortController();
  if (ctx.signal) {
    if (ctx.signal.aborted) {
      controller.abort();
    } else {
      ctx.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  let commandResult: {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
    timedOut: boolean;
    killed: boolean;
  };

  try {
    commandResult = await ctx.host.runCommand(
      {
        file: args.file,
        args: args.args,
        cwd: args.cwd,
        timeoutMs: COMMAND_TIMEOUT_MS,
        maxOutputChars: MAX_COMMAND_OUTPUT_CHARS,
      },
      controller.signal
    );
  } catch (err: unknown) {
    const message = (err as Error).message ?? String(err);
    return {
      content: [
        {
          type: 'text',
          text: `Command execution failed: ${message}`,
        },
      ],
      isError: true,
    };
  }

  // 9. Format command output and include exit code line
  const exitCodeStr = commandResult.exitCode !== null ? String(commandResult.exitCode) : 'none';
  const exitCodeLine = `exit code: ${exitCodeStr}`;

  const outputParts: string[] = [];
  if (commandResult.stdout) {
    outputParts.push(commandResult.stdout);
  }
  if (commandResult.stderr) {
    outputParts.push(commandResult.stderr);
  }

  let rawOutput = outputParts.join('\n');
  if (commandResult.timedOut) {
    rawOutput = `[Command timed out after ${COMMAND_TIMEOUT_MS}ms]\n${rawOutput}`;
  }
  if (commandResult.killed) {
    rawOutput = `[Command was terminated]\n${rawOutput}`;
  }

  // Tail-cap output to MAX_COMMAND_OUTPUT_CHARS
  const truncation = truncateTail(rawOutput, MAX_COMMAND_OUTPUT_CHARS);
  let formattedText = truncation.text ? `${truncation.text}\n${exitCodeLine}` : exitCodeLine;

  // Redact secrets and credentials
  formattedText = redactSecrets(formattedText);

  // Redact any active MCP token if set in environment
  if (process.env.FORGE_MCP_TOKEN && process.env.FORGE_MCP_TOKEN.trim().length > 0) {
    formattedText = formattedText.split(process.env.FORGE_MCP_TOKEN).join('[REDACTED_TOKEN]');
  }

  // 10. Append low-budget warning if threshold reached
  if (ctx.budget?.isLow()) {
    formattedText = `${formattedText}\n\n[${LOW_BUDGET_WARNING}]`;
  }

  // 11. Charge budget
  ctx.budget?.chargeText(formattedText);

  // 12. Return tool result (isError if non-zero exit code or killed or timed out)
  const isError = commandResult.exitCode !== 0 || commandResult.timedOut || commandResult.killed;

  return {
    content: [{ type: 'text', text: formattedText }],
    ...(isError ? { isError: true } : {}),
  };
}
