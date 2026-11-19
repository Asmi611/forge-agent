/**
 * MCP Approval payload definitions (Milestone E-06).
 *
 * Defines the TrueForge user.tool_approval wire schema conforming to
 * fixtures/events/03-*.jsonl and docs/spike-report.md Q4/Q5.
 */

export interface UserToolApprovalPayload {
  status: 'allow' | 'deny';
  reason?: string;
}

/**
 * Wire item submitted to TrueForge for tool approval.
 * Submitted to POST /api/v1/sessions/{session_id}/turns/{turn_id}/events.
 */
export interface UserToolApprovalItem {
  type: 'user.tool_approval';
  thread_id: string;
  tool_call_id: string;
  approval: UserToolApprovalPayload;
}

/**
 * Creates an allow approval event item for a given tool call.
 *
 * @param toolCallId - TrueForge tool_call_id
 * @param threadId - Target thread ID (defaults to 'main')
 * @returns UserToolApprovalItem with allow status
 */
export function createAllowApproval(
  toolCallId: string,
  threadId = 'main'
): UserToolApprovalItem {
  return {
    type: 'user.tool_approval',
    thread_id: threadId,
    tool_call_id: toolCallId,
    approval: {
      status: 'allow',
    },
  };
}

/**
 * Creates a deny approval event item with a truthful rejection reason.
 *
 * @param toolCallId - TrueForge tool_call_id
 * @param reason - Diagnostic or human rejection explanation
 * @param threadId - Target thread ID (defaults to 'main')
 * @returns UserToolApprovalItem with deny status and reason
 */
export function createDenyApproval(
  toolCallId: string,
  reason: string,
  threadId = 'main'
): UserToolApprovalItem {
  return {
    type: 'user.tool_approval',
    thread_id: threadId,
    tool_call_id: toolCallId,
    approval: {
      status: 'deny',
      reason,
    },
  };
}
