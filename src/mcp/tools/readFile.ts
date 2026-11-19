/**
 * MCP Tool: readFile (Milestone E-04).
 *
 * Exposes file text reading with line/token caps (200 lines / 1500 tokens),
 * secret denylist, path traversal protection, and binary rejection.
 */

import { z } from 'zod';
import {
  MAX_READ_LINES,
  MAX_READ_TOKENS,
  truncateLines,
  type ToolExecutionContext,
  type ToolCallResult,
} from '../limits.ts';
import { validatePath, checkFileSecurity } from '../secretGuard.ts';
import {
  RunBudget,
  DEDUPLICATION_NOTICE,
  LOW_BUDGET_WARNING,
  BUDGET_EXHAUSTED_MESSAGE,
} from '../../engine/budget.ts';

/** Tool name matching the frozen contract. */
export const READ_FILE_TOOL_NAME = 'readFile';

/** Input schema for readFile tool. */
export const readFileInputSchema = z.object({
  path: z.string().min(1).describe('Workspace-relative path of the file to read'),
  range: z
    .object({
      startLine: z.number().int().positive().describe('1-based starting line number'),
      endLine: z.number().int().positive().describe('1-based ending line number (inclusive)'),
    })
    .optional()
    .describe('Optional line range to read (prefer ranges for large files)'),
});

/** Tool description conforming to two-line format with usage hint. */
export const READ_FILE_TOOL_DESCRIPTION =
  'Read text content of a workspace file or specific line range.\nUse when examining code, definitions, or configuration before proposing changes.';

/**
 * Handles readFile tool execution.
 *
 * @param args - Tool arguments matching readFile schema
 * @param ctx - Tool execution context containing host and optional budget
 * @returns Tool result with text content
 */
export async function handleReadFile(
  args: z.infer<typeof readFileInputSchema>,
  ctx: ToolExecutionContext
): Promise<ToolCallResult> {
  // 1. Refuse if budget is already exhausted
  if (ctx.budget?.isExhausted()) {
    return {
      content: [{ type: 'text', text: BUDGET_EXHAUSTED_MESSAGE }],
      isError: true,
    };
  }

  // 2. Validate range bounds if provided
  if (args.range && args.range.startLine > args.range.endLine) {
    return {
      content: [
        {
          type: 'text',
          text: `Invalid line range: startLine (${args.range.startLine}) cannot be greater than endLine (${args.range.endLine}).`,
        },
      ],
      isError: true,
    };
  }

  // 3. Validate path containment and secret denylist
  const pathCheck = validatePath(ctx.host.workspaceRoot, args.path);
  if (!pathCheck.ok || !pathCheck.resolvedPath || !pathCheck.relativePath) {
    return {
      content: [{ type: 'text', text: `Path validation failed: ${pathCheck.reason}` }],
      isError: true,
    };
  }

  // 4. Validate file security posture (size < 1MB, non-directory, non-binary)
  const fileCheck = checkFileSecurity(ctx.host.workspaceRoot, pathCheck.resolvedPath);
  if (!fileCheck.ok) {
    return {
      content: [{ type: 'text', text: `File access rejected: ${fileCheck.reason}` }],
      isError: true,
    };
  }

  // 5. Check deduplication for identical repeat read
  const queryKey = RunBudget.getReadFileKey(pathCheck.relativePath, args.range);
  if (ctx.budget) {
    const dedupe = ctx.budget.checkDeduplication(queryKey);
    if (dedupe.isDuplicate) {
      ctx.budget.chargeText(DEDUPLICATION_NOTICE);
      return {
        content: [{ type: 'text', text: DEDUPLICATION_NOTICE }],
      };
    }
  }

  // 6. Read file from host
  let rawContent: string;
  try {
    rawContent = await ctx.host.readFile(pathCheck.relativePath, args.range);
  } catch (err: unknown) {
    const message = (err as Error).message ?? String(err);
    return {
      content: [{ type: 'text', text: `Failed to read file '${pathCheck.relativePath}': ${message}` }],
      isError: true,
    };
  }

  // 7. Apply line and token caps (200 lines / 1500 tokens)
  const truncation = truncateLines(rawContent, MAX_READ_LINES, MAX_READ_TOKENS);

  let formattedResult = truncation.text;
  if (truncation.truncated) {
    const header = `[File '${pathCheck.relativePath}': returning ${truncation.returnedLines} of ${truncation.totalLines} lines (truncated to 200 lines / 1500 tokens)]\n\n`;
    formattedResult = `${header}${truncation.text}`;
  }

  // 8. Append low budget warning if threshold reached
  if (ctx.budget?.isLow()) {
    formattedResult = `${formattedResult}\n\n[${LOW_BUDGET_WARNING}]`;
  }

  // 9. Charge budget
  ctx.budget?.chargeText(formattedResult);

  return {
    content: [{ type: 'text', text: formattedResult }],
  };
}
