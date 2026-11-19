/**
 * MCP Tool: reportContext (Milestone E-04).
 *
 * Exposes agent reporting of context items relied upon (capped at 20 items).
 * Per card E-04, this tool remains available even when context exploration budget is exhausted.
 */

import { z } from 'zod';
import {
  MAX_REPORT_CONTEXT_ITEMS,
  type ToolExecutionContext,
  type ToolCallResult,
} from '../limits.ts';

/** Tool name matching the frozen contract. */
export const REPORT_CONTEXT_TOOL_NAME = 'reportContext';

/** Input schema for reportContext tool. */
export const reportContextInputSchema = z.object({
  items: z
    .array(
      z.object({
        path: z.string().min(1).describe('Workspace-relative path of the file relied upon'),
        reason: z.string().min(1).describe('One-line reason why this file was relevant'),
      })
    )
    .describe('List of files and reasons the agent relied on before proposing changes'),
});

/** Tool description conforming to two-line format with usage hint. */
export const REPORT_CONTEXT_TOOL_DESCRIPTION =
  'Report the list of workspace files relied upon and the reason for each.\nUse once after exploring and before proposing edits or creating files.';

/**
 * Handles reportContext tool execution.
 *
 * @param args - Tool arguments matching reportContext schema
 * @param ctx - Tool execution context containing host and optional budget
 * @returns Tool result with text content
 */
export async function handleReportContext(
  args: z.infer<typeof reportContextInputSchema>,
  ctx: ToolExecutionContext
): Promise<ToolCallResult> {
  const rawItems = args.items ?? [];

  if (rawItems.length === 0) {
    const emptyMsg = 'Context reported: 0 items provided.';
    ctx.budget?.chargeText(emptyMsg);
    return {
      content: [{ type: 'text', text: emptyMsg }],
    };
  }

  // Cap items at MAX_REPORT_CONTEXT_ITEMS (20)
  const cappedItems = rawItems.slice(0, MAX_REPORT_CONTEXT_ITEMS);
  const omitted = rawItems.length - cappedItems.length;

  const lines = [
    `Context reported: ${cappedItems.length} file(s) recorded.`,
    ...cappedItems.map((item) => `- ${item.path.replace(/\\/g, '/')}: ${item.reason.trim()}`),
  ];

  if (omitted > 0) {
    lines.push(`... (${omitted} additional item(s) omitted; maximum is 20)`);
  }

  const finalText = lines.join('\n');

  // Charge tokens for context report acknowledgement
  ctx.budget?.chargeText(finalText);

  return {
    content: [{ type: 'text', text: finalText }],
  };
}
