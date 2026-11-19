/**
 * MCP Tool: proposeEdit (Milestone E-05).
 *
 * Approval-gated proposal handler returning truthful sentences per docs/01-ARCHITECTURE.md §4.1.
 * Acts as a no-write acknowledgement by resolving human review decisions from DecisionStore.
 */

import { z } from 'zod';
import type { ToolExecutionContext, ToolCallResult } from '../limits.ts';
import type { DecisionStore } from '../../engine/ProposalStore.ts';
import type { LineRange } from '../../types/contract.ts';

/** Tool name matching the frozen contract. */
export const PROPOSE_EDIT_TOOL_NAME = 'proposeEdit';

/** Tool description conforming to two-line format with usage hint. */
export const PROPOSE_EDIT_TOOL_DESCRIPTION =
  'Propose search/replace edits to an existing workspace file (approval-gated).\nUse when modifying existing code after reviewing its content.';

/** Frozen contract input schema for proposeEdit. */
export const proposeEditInputSchema = z.object({
  path: z.string().min(1).describe('Workspace-relative path of the file to edit'),
  edits: z
    .array(
      z.object({
        oldText: z.string().describe('Exact text to be replaced (must match uniquely)'),
        newText: z.string().describe('Replacement text to splice into the file'),
      })
    )
    .describe('List of search/replace edits against the current document'),
  rationale: z.string().describe('Reason for proposing these changes'),
});

export type ProposeEditInput = z.infer<typeof proposeEditInputSchema>;

export interface ProposeEditCallOptions {
  toolCallId?: string;
  threadId?: string;
  inlineRange?: LineRange;
}

/**
 * Handles proposeEdit tool execution.
 *
 * Validates inline range guards (rejecting edits starting >5 lines outside selected range),
 * resolves human review decisions from the DecisionStore, and returns truthful acknowledgment
 * strings conforming to docs/01-ARCHITECTURE.md §4.1.
 *
 * @param args - Tool arguments matching proposeEdit schema
 * @param ctx - Tool execution context
 * @param decisionStore - Optional DecisionStore instance (or passed via ctx)
 * @param callOptions - Optional call identity and inline mode parameters
 * @returns ToolCallResult with truthful acknowledgment text
 */
export async function handleProposeEdit(
  args: ProposeEditInput,
  ctx: ToolExecutionContext,
  decisionStore?: DecisionStore,
  callOptions?: ProposeEditCallOptions
): Promise<ToolCallResult> {
  const store = decisionStore ?? (ctx as { decisionStore?: DecisionStore }).decisionStore;
  const opts = callOptions ?? (ctx as { callOptions?: ProposeEditCallOptions }).callOptions;

  // 1. Inline mode guard: reject any edit whose lines start >5 lines outside selected range
  if (opts?.inlineRange && ctx.host) {
    const range = opts.inlineRange;
    try {
      const snapshot = await ctx.host.snapshot(args.path);
      const textLines = snapshot.text.split(/\r?\n/);
      for (const edit of args.edits) {
        const firstLine = edit.oldText.split(/\r?\n/)[0];
        const matchLineIdx = textLines.findIndex((line) => line.includes(firstLine));
        if (matchLineIdx !== -1) {
          const editLine = matchLineIdx + 1; // 1-based line number
          if (editLine < range.startLine - 5 || editLine > range.endLine + 5) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Edit starts >5 lines outside the selected range (lines ${range.startLine}–${range.endLine}). Rejected by inline mode guard.`,
                },
              ],
              isError: true,
            };
          }
        }
      }
    } catch {
      // If snapshot fails, proceed to store resolution
    }
  }

  // 2. Decision resolution
  if (!store) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: DecisionStore not configured for proposeEdit',
        },
      ],
      isError: true,
    };
  }

  const lookupResult = store.lookup({
    toolCallId: opts?.toolCallId,
    threadId: opts?.threadId,
    toolName: PROPOSE_EDIT_TOOL_NAME,
    path: args.path,
    payload: args.edits,
  });

  if (!lookupResult.ok) {
    return {
      content: [
        {
          type: 'text',
          text: `Error resolving review decision: ${lookupResult.error}`,
        },
      ],
      isError: true,
    };
  }

  const record = lookupResult.record;
  const normPath = record.path;

  if (record.decision.status === 'allow') {
    const totalCount = record.decision.totalCount ?? args.edits.length;
    const acceptedCount = record.decision.acceptedCount ?? totalCount;
    const rejectedHunkIds = record.decision.rejectedHunkIds ?? [];

    if (rejectedHunkIds.length > 0) {
      const msg = `Applied ${acceptedCount} of ${totalCount} hunks to ${normPath} (rejected: ${rejectedHunkIds.join(', ')}). The file on disk now contains only the accepted hunks. Re-read before editing again.`;
      return { content: [{ type: 'text', text: msg }] };
    }

    const msg = `Applied ${totalCount} of ${totalCount} hunks to ${normPath}. The file on disk now contains only the accepted hunks. Re-read before editing again.`;
    return { content: [{ type: 'text', text: msg }] };
  }

  const denyMsg = record.decision.summary ?? `User rejected all changes to ${normPath}`;
  return {
    content: [{ type: 'text', text: denyMsg }],
    isError: true,
  };
}
