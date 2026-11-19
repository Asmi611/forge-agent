/**
 * MCP Tool: createFile (Milestone E-05).
 *
 * Approval-gated proposal handler returning truthful sentences per docs/01-ARCHITECTURE.md §4.1.
 * Acts as a no-write acknowledgement by resolving human review decisions from DecisionStore.
 */

import { z } from 'zod';
import type { ToolExecutionContext, ToolCallResult } from '../limits.ts';
import type { DecisionStore } from '../../engine/ProposalStore.ts';

/** Tool name matching the frozen contract. */
export const CREATE_FILE_TOOL_NAME = 'createFile';

/** Tool description conforming to two-line format with usage hint. */
export const CREATE_FILE_TOOL_DESCRIPTION =
  'Propose creating a new workspace file with initial content (approval-gated).\nUse when adding a new source file, test, or document.';

/** Frozen contract input schema for createFile. */
export const createFileInputSchema = z.object({
  path: z.string().min(1).describe('Workspace-relative path of the new file to create'),
  content: z.string().describe('Complete initial content of the new file'),
  rationale: z.string().describe('Reason for creating the file'),
});

export type CreateFileInput = z.infer<typeof createFileInputSchema>;

export interface CreateFileCallOptions {
  toolCallId?: string;
  threadId?: string;
}

/**
 * Handles createFile tool execution.
 *
 * Resolves human review decisions from the DecisionStore and returns truthful acknowledgment
 * strings conforming to docs/01-ARCHITECTURE.md §4.1.
 *
 * @param args - Tool arguments matching createFile schema
 * @param ctx - Tool execution context
 * @param decisionStore - Optional DecisionStore instance (or passed via ctx)
 * @param callOptions - Optional call identity parameters
 * @returns ToolCallResult with truthful acknowledgment text
 */
export async function handleCreateFile(
  args: CreateFileInput,
  ctx: ToolExecutionContext,
  decisionStore?: DecisionStore,
  callOptions?: CreateFileCallOptions
): Promise<ToolCallResult> {
  const store = decisionStore ?? (ctx as { decisionStore?: DecisionStore }).decisionStore;
  const opts = callOptions ?? (ctx as { callOptions?: CreateFileCallOptions }).callOptions;

  if (!store) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: DecisionStore not configured for createFile',
        },
      ],
      isError: true,
    };
  }

  const lookupResult = store.lookup({
    toolCallId: opts?.toolCallId,
    threadId: opts?.threadId,
    toolName: CREATE_FILE_TOOL_NAME,
    path: args.path,
    payload: args.content,
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
    const byteCount =
      record.decision.byteCount ?? Buffer.byteLength(args.content, 'utf-8');
    const msg = `Created ${normPath} with ${byteCount} bytes. The file on disk now contains the initial content.`;
    return { content: [{ type: 'text', text: msg }] };
  }

  const denyMsg = record.decision.summary ?? `User rejected creation of ${normPath}`;
  return {
    content: [{ type: 'text', text: denyMsg }],
    isError: true,
  };
}
