/**
 * ProposalStore and DecisionStore (Milestone E-05).
 *
 * ProposalStore generates FileProposal objects with non-overlapping diff hunks
 * using diff structuredPatch({ context: 0 }). Never throws.
 *
 * DecisionStore implements the authoritative correlation rules (docs/01-ARCHITECTURE.md §4.1)
 * keyed by sessionId:threadId:toolCallId with 30-min TTL, argsHash verification on all paths,
 * grouped call matching, and one-time consumption.
 */

import * as crypto from 'node:crypto';
// @ts-expect-error diff package has no bundled TypeScript declarations
import { structuredPatch } from 'diff';
import type {
  FileProposal,
  Hunk,
  BaseSnapshot,
} from '../types/contract.ts';

/** Hunk interface returned by diff.structuredPatch. */
interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** Patch interface returned by diff.structuredPatch. */
interface DiffPatch {
  hunks: DiffHunk[];
}

/** Parameters required to construct a FileProposal. */
export interface CreateProposalParams {
  id?: string;
  callId: string;
  callIds?: string[];
  path: string;
  isNewFile?: boolean;
  base: BaseSnapshot;
  originalContent: string;
  proposedContent: string;
  rationale: string;
}

/** Outcome returned by ProposalStore.createProposal. Never throws. */
export type CreateProposalResult =
  | { ok: true; proposal: FileProposal }
  | { ok: false; reason: string };

/**
 * Deterministic JSON stringifier with lexicographically sorted object keys.
 * Ensures consistent hash generation across JavaScript environments.
 *
 * @param obj - Arbitrary value to serialize
 * @returns Canonical JSON string
 */
export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map((item) => canonicalJson(item)).join(',') + ']';
  }
  const record = obj as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const entries = sortedKeys.map(
    (key) => JSON.stringify(key) + ':' + canonicalJson(record[key])
  );
  return '{' + entries.join(',') + '}';
}

/**
 * Computes the authoritative per-tool argsHash per docs/01-ARCHITECTURE.md §4.1:
 * sha256(toolName + "\0" + path + "\0" + canonicalJson(payload))
 *
 * @param toolName - Literal tool name ('proposeEdit' or 'createFile')
 * @param path - Normalized file path
 * @param payload - Tool payload ('edits' array or 'content' string)
 * @returns 64-char hex sha256 hash
 */
export function computeArgsHash(toolName: string, path: string, payload: unknown): string {
  const normalizedPath = path.replace(/\\/g, '/');
  const payloadStr = canonicalJson(payload);
  return crypto
    .createHash('sha256')
    .update(`${toolName}\0${normalizedPath}\0${payloadStr}`)
    .digest('hex');
}

/**
 * In-memory ProposalStore managing pending proposals and hunk generation.
 */
export class ProposalStore {
  private readonly proposalsById = new Map<string, FileProposal>();
  private readonly proposalsByCallId = new Map<string, string>();
  private readonly proposalsByArgsHash = new Map<string, string>();

  /**
   * Constructs a FileProposal with diff hunks.
   * Never throws: returns { ok: false, reason: 'no changes' } on zero hunks.
   *
   * @param params - Proposal creation arguments
   * @returns CreateProposalResult with proposal or failure reason
   */
  public createProposal(params: CreateProposalParams): CreateProposalResult {
    try {
      const normalizedPath = params.path.replace(/\\/g, '/');
      const patchFn = structuredPatch as (
        oldFileName: string,
        newFileName: string,
        oldStr: string,
        newStr: string,
        oldHeader: string,
        newHeader: string,
        options: { context: number }
      ) => DiffPatch;

      const patch = patchFn(
        normalizedPath,
        normalizedPath,
        params.originalContent,
        params.proposedContent,
        '',
        '',
        { context: 0 }
      );

      if (!patch.hunks || patch.hunks.length === 0) {
        return { ok: false, reason: 'no changes' };
      }

      let runningDelta = 0;
      const hunks: Hunk[] = patch.hunks.map((diffHunk, index) => {
        const oldStart = diffHunk.oldStart;
        const oldLines = diffHunk.oldLines;
        const newLines = diffHunk.newLines;
        const newStart = oldStart + runningDelta;
        runningDelta += newLines - oldLines;

        const oldText = diffHunk.lines
          .filter((line) => line.startsWith('-'))
          .map((line) => line.slice(1).replace(/\r$/, ''))
          .join('\n');

        const newText = diffHunk.lines
          .filter((line) => line.startsWith('+'))
          .map((line) => line.slice(1).replace(/\r$/, ''))
          .join('\n');

        return {
          id: `h${index + 1}`,
          oldStart,
          oldLines,
          newStart,
          newLines,
          oldText,
          newText,
          status: 'pending',
        };
      });

      const callIds =
        params.callIds && params.callIds.length > 0
          ? [...params.callIds]
          : [params.callId];
      const callId = callIds[0];
      const proposalId = params.id ?? `prop-${crypto.randomUUID()}`;

      const proposal: FileProposal = {
        id: proposalId,
        callId,
        callIds,
        path: normalizedPath,
        isNewFile: params.isNewFile ?? false,
        base: params.base,
        originalContent: params.originalContent,
        proposedContent: params.proposedContent,
        hunks,
        rationale: params.rationale,
        createdAt: Date.now(),
      };

      return { ok: true, proposal };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `Failed to construct patch: ${msg}` };
    }
  }

  /**
   * Stores a proposal and registers its callId and argsHash lookups.
   *
   * @param proposal - The FileProposal to store
   * @param argsHash - Optional precomputed argsHash
   */
  public add(proposal: FileProposal, argsHash?: string): void {
    this.proposalsById.set(proposal.id, proposal);
    for (const cid of proposal.callIds) {
      this.proposalsByCallId.set(cid, proposal.id);
    }
    if (argsHash) {
      this.proposalsByArgsHash.set(argsHash, proposal.id);
    }
  }

  /**
   * Adds a proposal, grouping identical calls with matching argsHash into one proposal.
   *
   * @param params - Proposal creation arguments
   * @param toolName - Tool name ('proposeEdit' or 'createFile')
   * @param payload - Tool payload for argsHash computation
   * @returns CreateProposalResult with grouped flag
   */
  public addOrGroup(
    params: CreateProposalParams,
    toolName: string,
    payload: unknown
  ): { ok: true; proposal: FileProposal; grouped: boolean } | { ok: false; reason: string } {
    const hash = computeArgsHash(toolName, params.path, payload);
    const existingId = this.proposalsByArgsHash.get(hash);

    if (existingId) {
      const existing = this.proposalsById.get(existingId);
      if (existing) {
        if (!existing.callIds.includes(params.callId)) {
          existing.callIds.push(params.callId);
          this.proposalsByCallId.set(params.callId, existing.id);
        }
        return { ok: true, proposal: existing, grouped: true };
      }
    }

    const created = this.createProposal(params);
    if (!created.ok) {
      return created;
    }

    this.add(created.proposal, hash);
    return { ok: true, proposal: created.proposal, grouped: false };
  }

  /**
   * Retrieves a proposal by its unique proposalId.
   */
  public get(id: string): FileProposal | undefined {
    return this.proposalsById.get(id);
  }

  /**
   * Retrieves a proposal by any of its folded tool_call_ids.
   */
  public getByCallId(callId: string): FileProposal | undefined {
    const propId = this.proposalsByCallId.get(callId);
    return propId ? this.proposalsById.get(propId) : undefined;
  }

  /**
   * Retrieves a proposal by its argsHash.
   */
  public getByArgsHash(argsHash: string): FileProposal | undefined {
    const propId = this.proposalsByArgsHash.get(argsHash);
    return propId ? this.proposalsById.get(propId) : undefined;
  }

  /**
   * Returns all stored proposals.
   */
  public all(): FileProposal[] {
    return Array.from(this.proposalsById.values());
  }

  /**
   * Removes a proposal by ID.
   */
  public remove(id: string): boolean {
    const proposal = this.proposalsById.get(id);
    if (!proposal) return false;
    for (const cid of proposal.callIds) {
      this.proposalsByCallId.delete(cid);
    }
    for (const [hash, pid] of this.proposalsByArgsHash.entries()) {
      if (pid === id) {
        this.proposalsByArgsHash.delete(hash);
      }
    }
    return this.proposalsById.delete(id);
  }

  /**
   * Discards all proposals and resets store state.
   */
  public discardAll(): FileProposal[] {
    const list = this.all();
    this.clear();
    return list;
  }

  /**
   * Clears all internal maps.
   */
  public clear(): void {
    this.proposalsById.clear();
    this.proposalsByCallId.clear();
    this.proposalsByArgsHash.clear();
  }
}

/** 30-minute time-to-live for decision records. */
export const DECISION_TTL_MS = 30 * 60 * 1000;

export interface DecisionPayload {
  status: 'allow' | 'deny';
  summary?: string;
  acceptedCount?: number;
  totalCount?: number;
  rejectedHunkIds?: string[];
  byteCount?: number;
}

export interface DecisionRecordInput {
  sessionId: string;
  threadId: string;
  toolCallId: string;
  toolName: string;
  path: string;
  argsHash: string;
  decision: DecisionPayload;
  createdAt?: number;
}

export interface DecisionRecord extends DecisionRecordInput {
  state: 'LIVE' | 'CONSUMED' | 'CLOSED';
  createdAt: number;
}

export interface DecisionLookupParams {
  toolCallId?: string;
  threadId?: string;
  toolName: string;
  path: string;
  payload: unknown;
}

export type DecisionLookupResult =
  | { ok: true; record: DecisionRecord }
  | { ok: false; error: string };

function isEqualDecision(d1: DecisionPayload, d2: DecisionPayload): boolean {
  if (d1.status !== d2.status) return false;
  if (d1.summary !== d2.summary) return false;
  if (d1.acceptedCount !== d2.acceptedCount) return false;
  if (d1.totalCount !== d2.totalCount) return false;
  if (d1.byteCount !== d2.byteCount) return false;
  const r1 = (d1.rejectedHunkIds ?? []).slice().sort().join(',');
  const r2 = (d2.rejectedHunkIds ?? []).slice().sort().join(',');
  return r1 === r2;
}

/**
 * Authoritative DecisionStore managing human review decisions.
 * Scoped to SessionOrchestrator and keyed by sessionId:threadId:toolCallId.
 */
export class DecisionStore {
  private activeSessionId: string | null = null;
  private readonly records = new Map<string, DecisionRecord>();

  /**
   * Sets or clears the active session ID.
   */
  public setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId;
  }

  /**
   * Gets the active session ID.
   */
  public getActiveSession(): string | null {
    return this.activeSessionId;
  }

  /**
   * Records a review decision.
   * Duplicate record() with identical decision is an idempotent no-op.
   * Duplicate record() with DIFFERENT decision throws an error.
   *
   * @param input - Decision record parameters
   */
  public record(input: DecisionRecordInput): void {
    const key = `${input.sessionId}:${input.threadId}:${input.toolCallId}`;
    const existing = this.records.get(key);

    if (existing) {
      if (
        isEqualDecision(existing.decision, input.decision) &&
        existing.argsHash === input.argsHash
      ) {
        return; // Idempotent duplicate
      }
      throw new Error(
        `Conflicting decision recorded for toolCallId ${input.toolCallId}: differing decision payload`
      );
    }

    const record: DecisionRecord = {
      ...input,
      path: input.path.replace(/\\/g, '/'),
      state: 'LIVE',
      createdAt: input.createdAt ?? Date.now(),
    };
    this.records.set(key, record);
  }

  /**
   * Resolves a decision record for an MCP tool handler using the authoritative
   * correlation rules (docs/01-ARCHITECTURE.md §4.1).
   *
   * Validates argsHash on every path; on mismatch logs args_mismatch and does NOT consume.
   *
   * @param params - Lookup parameters from the incoming tool request
   * @returns Lookup result with consumed record or explicit error
   */
  public lookup(params: DecisionLookupParams): DecisionLookupResult {
    if (!this.activeSessionId) {
      return { ok: false, error: 'no active run' };
    }

    const incomingArgsHash = computeArgsHash(
      params.toolName,
      params.path,
      params.payload
    );

    const now = Date.now();
    const isExpired = (r: DecisionRecord) => now - r.createdAt > DECISION_TTL_MS;

    // Rule 2(a): Request carries call id
    if (params.toolCallId) {
      let candidate: DecisionRecord | undefined;

      if (params.threadId) {
        const key = `${this.activeSessionId}:${params.threadId}:${params.toolCallId}`;
        candidate = this.records.get(key);
      } else {
        // Search all threads of active session for this toolCallId
        const matching: DecisionRecord[] = [];
        for (const record of this.records.values()) {
          if (
            record.sessionId === this.activeSessionId &&
            record.toolCallId === params.toolCallId &&
            record.state === 'LIVE' &&
            !isExpired(record)
          ) {
            matching.push(record);
          }
        }

        if (matching.length > 1) {
          return { ok: false, error: 'correlation_ambiguous' };
        }
        if (matching.length === 1) {
          candidate = matching[0];
        } else {
          // Check if it existed under any thread but is consumed/expired/closed
          for (const record of this.records.values()) {
            if (
              record.sessionId === this.activeSessionId &&
              record.toolCallId === params.toolCallId
            ) {
              candidate = record;
              break;
            }
          }
        }
      }

      if (!candidate) {
        return { ok: false, error: 'no decision record found' };
      }

      if (isExpired(candidate)) {
        return { ok: false, error: 'record expired' };
      }

      if (candidate.state !== 'LIVE') {
        return { ok: false, error: `record already ${candidate.state.toLowerCase()}` };
      }

      // Authoritative integrity check: argsHash must match incoming args
      if (candidate.argsHash !== incomingArgsHash) {
        // Do NOT consume record on mismatch
        return { ok: false, error: 'args_mismatch' };
      }

      candidate.state = 'CONSUMED';
      return { ok: true, record: candidate };
    }

    // Rule 2(b): No call id -> lookup live records matching argsHash
    const normalizedPath = params.path.replace(/\\/g, '/');
    const liveMatches: DecisionRecord[] = [];

    for (const record of this.records.values()) {
      if (
        record.sessionId === this.activeSessionId &&
        record.state === 'LIVE' &&
        !isExpired(record) &&
        record.argsHash === incomingArgsHash &&
        record.toolName === params.toolName &&
        record.path === normalizedPath
      ) {
        liveMatches.push(record);
      }
    }

    if (liveMatches.length === 0) {
      return { ok: false, error: 'no live record found' };
    }

    // Rule 3: If live matching records carry DIFFERENT decisions -> correlation_ambiguous
    const firstDecision = liveMatches[0].decision;
    for (let i = 1; i < liveMatches.length; i++) {
      if (!isEqualDecision(firstDecision, liveMatches[i].decision)) {
        return { ok: false, error: 'correlation_ambiguous' };
      }
    }

    // Tie-break: lowest createdAt
    liveMatches.sort((a, b) => a.createdAt - b.createdAt);
    const chosen = liveMatches[0];
    chosen.state = 'CONSUMED';
    return { ok: true, record: chosen };
  }

  /**
   * Closes a record when deny is sent, tool response is received, or run is cancelled.
   */
  public closeRecord(toolCallId: string, _reason?: string): void {
    for (const record of this.records.values()) {
      if (record.toolCallId === toolCallId) {
        record.state = 'CLOSED';
      }
    }
  }

  /**
   * Closes all live records for a cancelled session.
   */
  public cancelSession(sessionId: string): void {
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId && record.state === 'LIVE') {
        record.state = 'CLOSED';
      }
    }
  }

  /**
   * Clears all records.
   */
  public clear(): void {
    this.records.clear();
    this.activeSessionId = null;
  }
}
