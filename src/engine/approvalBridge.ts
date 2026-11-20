/**
 * ApprovalBridge -- pause, review, and approval coordination (Milestone E-06).
 *
 * Implements the approval lifecycle per docs/01-ARCHITECTURE.md §4:
 * - Snapshots files and computes hunks via applyEdits.
 * - Handles edit-match errors with precise denial reasons and retries (max 2 per file).
 * - Emits proposal.created and review.required.
 * - Manages cancellable review wait with 2-hour timeout.
 * - Stores review decisions into DecisionStore before submitting approvals.
 * - Fans out decisions to all callIds in grouped proposals.
 * - Closes denied records upon denial submission.
 */

import * as crypto from 'node:crypto';
import type {
  UiHost,
  EngineEvent,
  ReviewResult,
  FileProposal,
} from '../types/contract.ts';
import { applyEdits, type EditItem } from './applyEdits.ts';
import {
  ProposalStore,
  DecisionStore,
  computeArgsHash,
} from './ProposalStore.ts';
import type { PauseInfo } from './eventMapper.ts';
import {
  type UserToolApprovalItem,
  createAllowApproval,
  createDenyApproval,
} from '../mcp/approval.ts';

/** Review wait timeout cap (2 hours) per docs/01-ARCHITECTURE.md §4. */
export const REVIEW_WAIT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

interface TrackedProposal {
  proposal: FileProposal;
  toolName: string;
  payload: unknown;
  threadId: string;
}

export interface PauseResolution {
  approvals: UserToolApprovalItem[];
}

/**
 * Coordinates approval pauses, human review batches, and resume approval submissions.
 */
export class ApprovalBridge {
  private readonly host: UiHost;
  private readonly proposalStore: ProposalStore;
  private readonly decisionStore: DecisionStore;

  // Retry counts per path, scoped to this run context
  private readonly retryCounts = new Map<string, number>();

  // Tracks whether at least one accepted hunk was successfully applied in this run
  public anyHunkApplied = false;

  private activeSessionId: string | null = null;
  private activeBatchId: string | null = null;
  private readonly activeProposals = new Map<string, TrackedProposal>();
  private preDeniedApprovals: UserToolApprovalItem[] = [];

  private pendingReviewResolve: ((approvals: UserToolApprovalItem[]) => void) | null = null;
  private pendingReviewReject: ((err: Error) => void) | null = null;
  private reviewTimeoutTimer: NodeJS.Timeout | null = null;
  private isCancelled = false;

  constructor(
    host: UiHost,
    proposalStore?: ProposalStore,
    decisionStore?: DecisionStore
  ) {
    this.host = host;
    this.proposalStore = proposalStore ?? new ProposalStore();
    this.decisionStore = decisionStore ?? new DecisionStore();
  }

  /** Gets the DecisionStore instance bound to this bridge. */
  public getDecisionStore(): DecisionStore {
    return this.decisionStore;
  }

  /** Gets the ProposalStore instance bound to this bridge. */
  public getProposalStore(): ProposalStore {
    return this.proposalStore;
  }

  /** Gets the current retry count for a given workspace-relative path. */
  public getRetryCount(path: string): number {
    return this.retryCounts.get(path) ?? 0;
  }

  /**
   * Handles a turn pause by snapshotting, verifying edits, creating proposals,
   * emitting review.required, and awaiting human review via reviewDone.
   *
   * @param pauses - Approval pauses yielded by eventMapper
   * @param sessionId - Active TrueForge session ID
   * @param turnId - Active TrueForge turn ID
   * @param signal - Run cancellation AbortSignal
   * @param emitEvent - Callback delivering EngineEvents to the run queue
   * @returns Approvals to submit to TrueForge
   */
  public async handlePause(
    pauses: PauseInfo[],
    sessionId: string,
    _turnId: string,
    signal: AbortSignal,
    emitEvent: (ev: EngineEvent) => void
  ): Promise<PauseResolution> {
    this.activeSessionId = sessionId;
    this.decisionStore.setActiveSession(sessionId);
    this.preDeniedApprovals = [];
    this.activeProposals.clear();

    const createdProposals: FileProposal[] = [];

    for (const pause of pauses) {
      if (pause.toolName === 'proposeEdit') {
        const rawArgs = pause.args as { path?: string; edits?: EditItem[]; rationale?: string };
        const path = rawArgs.path ?? '';
        const edits = Array.isArray(rawArgs.edits) ? rawArgs.edits : [];
        const rationale = rawArgs.rationale ?? '';

        const snapshot = await this.host.snapshot(path);
        const applyRes = applyEdits(snapshot.text, edits, path);

        if (!applyRes.ok) {
          // Increment retry count for this file in this run
          const currentCount = (this.retryCounts.get(path) ?? 0) + 1;
          this.retryCounts.set(path, currentCount);

          if (currentCount >= 2) {
            emitEvent({
              type: 'proposal.discarded',
              proposalId: `discard-${pause.callId}`,
              reason: 'error',
            });
          }

          // Pre-deny this call without UI review
          const preDenyReason = `Technical failure: edit matching failed against current file (not a user rejection): ${applyRes.reason}. Re-read the file and propose again only if needed.`;
          const denyItem = createDenyApproval(pause.callId, preDenyReason, pause.threadId);
          this.preDeniedApprovals.push(denyItem);

          // Record in DecisionStore (closed when deny is submitted)
          const argsHash = computeArgsHash('proposeEdit', path, edits);
          this.decisionStore.record({
            sessionId,
            threadId: pause.threadId,
            toolCallId: pause.callId,
            toolName: 'proposeEdit',
            path,
            argsHash,
            decision: { status: 'deny', summary: preDenyReason },
          });
          continue;
        }

        // Edit match succeeded: reset retry count for this path
        this.retryCounts.set(path, 0);

        const propRes = this.proposalStore.addOrGroup(
          {
            callId: pause.callId,
            path,
            isNewFile: false,
            base: {
              contentHash: snapshot.contentHash,
              version: snapshot.version,
              wasDirty: snapshot.isDirty,
            },
            originalContent: snapshot.text,
            proposedContent: applyRes.text,
            rationale,
          },
          'proposeEdit',
          edits
        );

        if (propRes.ok) {
          if (!propRes.grouped) {
            emitEvent({ type: 'proposal.created', proposal: propRes.proposal });
            createdProposals.push(propRes.proposal);
          }
          this.activeProposals.set(propRes.proposal.id, {
            proposal: propRes.proposal,
            toolName: 'proposeEdit',
            payload: edits,
            threadId: pause.threadId,
          });
        }
      } else if (pause.toolName === 'createFile') {
        const rawArgs = pause.args as { path?: string; content?: string; rationale?: string };
        const path = rawArgs.path ?? '';
        const content = rawArgs.content ?? '';
        const rationale = rawArgs.rationale ?? '';

        const propRes = this.proposalStore.addOrGroup(
          {
            callId: pause.callId,
            path,
            isNewFile: true,
            base: {
              contentHash: '',
              version: null,
              wasDirty: false,
            },
            originalContent: '',
            proposedContent: content,
            rationale,
          },
          'createFile',
          content
        );

        if (propRes.ok) {
          if (!propRes.grouped) {
            emitEvent({ type: 'proposal.created', proposal: propRes.proposal });
            createdProposals.push(propRes.proposal);
          }
          this.activeProposals.set(propRes.proposal.id, {
            proposal: propRes.proposal,
            toolName: 'createFile',
            payload: content,
            threadId: pause.threadId,
          });
        }
      }
    }

    // If no proposals require human review (e.g. all were pre-denied)
    if (this.activeProposals.size === 0) {
      for (const item of this.preDeniedApprovals) {
        this.decisionStore.closeRecord(item.tool_call_id, item.approval.reason);
      }
      return { approvals: [...this.preDeniedApprovals] };
    }

    // Await human review completion via reviewDone()
    const batchId = `batch-${crypto.randomUUID()}`;
    this.activeBatchId = batchId;

    const approvals = await new Promise<UserToolApprovalItem[]>((resolve, reject) => {
      this.pendingReviewResolve = resolve;
      this.pendingReviewReject = reject;

      this.reviewTimeoutTimer = setTimeout(() => {
        this.clearReviewWait();
        reject(new Error('Review wait timed out after 2 hours'));
      }, REVIEW_WAIT_TIMEOUT_MS);

      if (signal.aborted) {
        this.cancel(emitEvent);
      } else {
        signal.addEventListener('abort', () => this.cancel(emitEvent), { once: true });
      }

      emitEvent({
        type: 'review.required',
        batchId,
        proposalIds: Array.from(this.activeProposals.keys()),
      });
    });

    return { approvals };
  }

  /**
   * Delivers review decisions from the editor UI.
   * Records decisions in DecisionStore, closes denied records, and resolves the wait.
   *
   * @param result - Review decisions per proposal
   */
  public reviewDone(result: ReviewResult): void {
    if (this.isCancelled) {
      return;
    }

    if (!this.activeBatchId || result.batchId !== this.activeBatchId) {
      // Ignore stale or unknown batchId calls
      return;
    }

    const reviewedApprovals: UserToolApprovalItem[] = [];

    for (const item of result.proposals) {
      const tracked = this.activeProposals.get(item.proposalId);
      if (!tracked) {
        continue;
      }

      const proposal = tracked.proposal;
      const acceptedCount = Object.values(item.decisions).filter((s) => s === 'accepted').length;
      const totalCount = Object.keys(item.decisions).length || proposal.hunks.length;
      const rejectedHunkIds = Object.entries(item.decisions)
        .filter(([, s]) => s === 'rejected')
        .map(([id]) => id);

      const isAllowed = item.applied && acceptedCount >= 1;
      if (isAllowed) {
        this.anyHunkApplied = true;
      }

      let denyReason: string | undefined;
      if (!isAllowed) {
        if (item.failure?.kind === 'stale') {
          const detail = item.failure.message || 'File changed since proposal';
          denyReason = `Technical failure (file changed on disk, not a user rejection): ${detail}. Re-read the file and propose again only if needed.`;
        } else if (item.failure?.kind === 'apply_failed' || item.failure?.kind === 'restore_failed') {
          const detail = item.failure.message || 'Apply failed to write accepted hunks';
          denyReason = `Technical failure applying changes (not a user rejection): ${detail}. Re-read the file and propose again only if needed.`;
        } else {
          denyReason = proposal.isNewFile
            ? `User rejected creation of ${proposal.path}`
            : `User rejected all changes to ${proposal.path}`;
        }
      }

      const argsHash = computeArgsHash(tracked.toolName, proposal.path, tracked.payload);

      // Fan out decision to every callId folded into this proposal
      for (const callId of proposal.callIds) {
        const threadId = tracked.threadId;

        // Store decision in DecisionStore BEFORE approvals are sent
        this.decisionStore.record({
          sessionId: this.activeSessionId!,
          threadId,
          toolCallId: callId,
          toolName: tracked.toolName,
          path: proposal.path,
          argsHash,
          decision: isAllowed
            ? {
                status: 'allow',
                acceptedCount,
                totalCount,
                rejectedHunkIds,
                byteCount: proposal.isNewFile
                  ? Buffer.byteLength(proposal.proposedContent, 'utf-8')
                  : undefined,
              }
            : {
                status: 'deny',
                summary: denyReason,
              },
        });

        if (isAllowed) {
          reviewedApprovals.push(createAllowApproval(callId, threadId));
        } else {
          this.decisionStore.closeRecord(callId, denyReason);
          reviewedApprovals.push(createDenyApproval(callId, denyReason!, threadId));
        }
      }
    }

    // Close pre-denied records as their denials are now being sent
    for (const item of this.preDeniedApprovals) {
      this.decisionStore.closeRecord(item.tool_call_id, item.approval.reason);
    }

    const allApprovals = [...reviewedApprovals, ...this.preDeniedApprovals];
    const resolve = this.pendingReviewResolve;
    this.clearReviewWait();

    if (resolve) {
      resolve(allApprovals);
    }
  }

  /**
   * Cancels any pending review wait, discards active proposals, and resets state.
   */
  public cancel(emitEvent?: (ev: EngineEvent) => void): void {
    if (this.isCancelled) {
      return;
    }
    this.isCancelled = true;

    if (this.activeBatchId && emitEvent) {
      for (const tracked of this.activeProposals.values()) {
        emitEvent({
          type: 'proposal.discarded',
          proposalId: tracked.proposal.id,
          reason: 'cancelled',
        });
      }
    }

    const reject = this.pendingReviewReject;
    this.clearReviewWait();

    if (reject) {
      reject(new Error('Run cancelled during review wait'));
    }
  }

  private clearReviewWait(): void {
    if (this.reviewTimeoutTimer) {
      clearTimeout(this.reviewTimeoutTimer);
      this.reviewTimeoutTimer = null;
    }
    this.activeBatchId = null;
    this.pendingReviewResolve = null;
    this.pendingReviewReject = null;
  }
}
