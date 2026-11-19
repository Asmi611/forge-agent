/**
 * MCP Tool: repoMap (Milestone E-04).
 *
 * Exposes compact directory tree inspection capped at 1500 tokens.
 */

import { z } from 'zod';
import {
  MAX_REPO_MAP_TOKENS,
  CHARS_PER_TOKEN,
  type ToolExecutionContext,
  type ToolCallResult,
} from '../limits.ts';
import { validatePath } from '../secretGuard.ts';
import {
  DEDUPLICATION_NOTICE,
  LOW_BUDGET_WARNING,
  BUDGET_EXHAUSTED_MESSAGE,
} from '../../engine/budget.ts';

/** Tool name matching the frozen contract. */
export const REPO_MAP_TOOL_NAME = 'repoMap';

/** Input schema for repoMap tool. */
export const repoMapInputSchema = z.object({
  dir: z.string().optional().describe('Workspace directory to inspect (defaults to workspace root)'),
  depth: z.number().int().positive().optional().describe('Maximum directory depth to traverse (optional)'),
});

/** Tool description conforming to two-line format with usage hint. */
export const REPO_MAP_TOOL_DESCRIPTION =
  'Compact directory tree of the repository.\nUse when exploring the overall project structure or locating top-level directories.';

/**
 * Handles repoMap tool execution.
 *
 * @param args - Tool arguments matching repoMap schema
 * @param ctx - Tool execution context containing host and optional budget
 * @returns Tool result with text content
 */
export async function handleRepoMap(
  args: z.infer<typeof repoMapInputSchema>,
  ctx: ToolExecutionContext
): Promise<ToolCallResult> {
  // 1. Refuse if budget is already exhausted
  if (ctx.budget?.isExhausted()) {
    return {
      content: [{ type: 'text', text: BUDGET_EXHAUSTED_MESSAGE }],
      isError: true,
    };
  }

  // 2. Validate directory path if specified
  if (args.dir) {
    const pathCheck = validatePath(ctx.host.workspaceRoot, args.dir);
    if (!pathCheck.ok) {
      return {
        content: [{ type: 'text', text: `Directory validation failed: ${pathCheck.reason}` }],
        isError: true,
      };
    }
  }

  // 3. Check deduplication
  const queryKey = `repoMap:${args.dir ?? '.'}:${args.depth ?? 'default'}`;
  if (ctx.budget) {
    const dedupe = ctx.budget.checkDeduplication(queryKey);
    if (dedupe.isDuplicate) {
      ctx.budget.chargeText(DEDUPLICATION_NOTICE);
      return {
        content: [{ type: 'text', text: DEDUPLICATION_NOTICE }],
      };
    }
  }

  // 4. Query host context provider
  let tree: string;
  try {
    const result = await ctx.host.context.repoMap({
      dir: args.dir,
      depth: args.depth,
    });
    tree = result.tree;
  } catch (err: unknown) {
    const message = (err as Error).message ?? String(err);
    return {
      content: [{ type: 'text', text: `Failed to generate repository map: ${message}` }],
      isError: true,
    };
  }

  // 5. Enforce 1500 tokens limit (6000 characters)
  const maxChars = MAX_REPO_MAP_TOKENS * CHARS_PER_TOKEN;
  let finalText = tree || '(empty repository structure)';
  if (finalText.length > maxChars) {
    finalText = `${finalText.slice(0, maxChars - 40)}\n... [repoMap truncated at 1500 tokens]`;
  }

  // 6. Append low budget warning if threshold reached
  if (ctx.budget?.isLow()) {
    finalText = `${finalText}\n\n[${LOW_BUDGET_WARNING}]`;
  }

  // 7. Charge budget
  ctx.budget?.chargeText(finalText);

  return {
    content: [{ type: 'text', text: finalText }],
  };
}
