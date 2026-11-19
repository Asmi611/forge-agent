/**
 * Comprehensive unit tests for ProposalStore, DecisionStore, and MCP Handlers (Milestone E-05).
 *
 * Verifies hunk generation, pure insertions/deletions, rebuilding proposedContent from hunks,
 * newStart running delta calculation, zero hunk handling, identical call grouping,
 * authoritative correlation rules, argsHash verification, duplicate record idempotency vs conflict,
 * threadId omission ambiguity, and truthful MCP handler acknowledgment replies.
 */

import { describe, expect, it } from 'vitest';
import type { BaseSnapshot, Hunk, LineRange, UiHost } from '../../src/types/contract.ts';
import {
  ProposalStore,
  DecisionStore,
  canonicalJson,
  computeArgsHash,
  DECISION_TTL_MS,
} from '../../src/engine/ProposalStore.ts';
import {
  handleProposeEdit,
  PROPOSE_EDIT_TOOL_NAME,
} from '../../src/mcp/tools/proposeEdit.ts';
import {
  handleCreateFile,
  CREATE_FILE_TOOL_NAME,
} from '../../src/mcp/tools/createFile.ts';
import type { ToolExecutionContext } from '../../src/mcp/limits.ts';

const dummyBase: BaseSnapshot = {
  contentHash: 'dummy-hash',
  version: 1,
  wasDirty: false,
};

/**
 * Rebuilds document text from originalContent and hunks following contract rules:
 * - oldStart is 1-based line number.
 * - oldLines lines are replaced by newText lines.
 * - For pure insertion oldLines === 0 and new lines go before oldStart.
 */
function rebuildFromHunks(originalContent: string, hunks: Hunk[]): string {
  const origLines = originalContent.split('\n');
  const resultLines = [...origLines];
  let lineOffset = 0;
  for (const h of hunks) {
    const newHunkLines = h.newText.length > 0 ? h.newText.split('\n') : [];
    const insertIdx = h.oldStart - 1 + lineOffset;
    resultLines.splice(insertIdx, h.oldLines, ...newHunkLines);
    lineOffset += h.newLines - h.oldLines;
  }
  return resultLines.join('\n');
}

describe('ProposalStore hunk generation', () => {
  it('creates pure insertion at the start of a file and verifies rebuilt text and newStart delta', () => {
    const store = new ProposalStore();
    const orig = 'line1\nline2\n';
    const prop = 'line0\nline1\nline2\n';

    const res = store.createProposal({
      callId: 'call-1',
      path: 'src/example.ts',
      base: dummyBase,
      originalContent: orig,
      proposedContent: prop,
      rationale: 'Insert header',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.proposal.hunks.length).toBe(1);
    const hunk = res.proposal.hunks[0];
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldLines).toBe(0);
    expect(hunk.newStart).toBe(1); // oldStart (1) + runningDelta (0)
    expect(hunk.newLines).toBe(1);
    expect(hunk.newText).toBe('line0');
    expect(hunk.oldText).toBe('');

    // Verify rebuilding proposedContent from hunks equals expected text
    const rebuilt = rebuildFromHunks(orig, res.proposal.hunks);
    expect(rebuilt).toBe(prop);
  });

  it('creates pure insertion in the middle of a file and verifies rebuilt text and newStart delta', () => {
    const store = new ProposalStore();
    const orig = 'line1\nline2\nline3\n';
    const prop = 'line1\ninsertA\ninsertB\nline2\nline3\n';

    const res = store.createProposal({
      callId: 'call-2',
      path: 'src/example.ts',
      base: dummyBase,
      originalContent: orig,
      proposedContent: prop,
      rationale: 'Insert middle lines',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.proposal.hunks.length).toBe(1);
    const hunk = res.proposal.hunks[0];
    expect(hunk.oldStart).toBe(2);
    expect(hunk.oldLines).toBe(0);
    expect(hunk.newStart).toBe(2); // oldStart (2) + runningDelta (0)
    expect(hunk.newLines).toBe(2);
    expect(hunk.newText).toBe('insertA\ninsertB');
    expect(hunk.oldText).toBe('');

    // Verify rebuilding proposedContent from hunks equals expected text
    const rebuilt = rebuildFromHunks(orig, res.proposal.hunks);
    expect(rebuilt).toBe(prop);
  });

  it('creates pure insertion at the end of a file and verifies rebuilt text and newStart delta', () => {
    const store = new ProposalStore();
    const orig = 'line1\nline2\n';
    const prop = 'line1\nline2\nline3\n';

    const res = store.createProposal({
      callId: 'call-3',
      path: 'src/example.ts',
      base: dummyBase,
      originalContent: orig,
      proposedContent: prop,
      rationale: 'Insert at end',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.proposal.hunks.length).toBe(1);
    const hunk = res.proposal.hunks[0];
    expect(hunk.oldStart).toBe(3);
    expect(hunk.oldLines).toBe(0);
    expect(hunk.newStart).toBe(3); // oldStart (3) + runningDelta (0)
    expect(hunk.newLines).toBe(1);
    expect(hunk.newText).toBe('line3');
    expect(hunk.oldText).toBe('');

    // Verify rebuilding proposedContent from hunks equals expected text
    const rebuilt = rebuildFromHunks(orig, res.proposal.hunks);
    expect(rebuilt).toBe(prop);
  });

  it('creates pure deletion and verifies rebuilt text and newStart delta', () => {
    const store = new ProposalStore();
    const orig = 'line1\nline2\nline3\n';
    const prop = 'line1\nline3\n';

    const res = store.createProposal({
      callId: 'call-4',
      path: 'src/example.ts',
      base: dummyBase,
      originalContent: orig,
      proposedContent: prop,
      rationale: 'Delete line2',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.proposal.hunks.length).toBe(1);
    const hunk = res.proposal.hunks[0];
    expect(hunk.oldStart).toBe(2);
    expect(hunk.oldLines).toBe(1);
    expect(hunk.newStart).toBe(2); // oldStart (2) + runningDelta (0)
    expect(hunk.newLines).toBe(0);
    expect(hunk.oldText).toBe('line2');
    expect(hunk.newText).toBe('');

    // Verify rebuilding proposedContent from hunks equals expected text
    const rebuilt = rebuildFromHunks(orig, res.proposal.hunks);
    expect(rebuilt).toBe(prop);
  });

  it('computes newStart with running delta across multiple hunks', () => {
    const store = new ProposalStore();
    const orig = 'line1\nline2\nline3\nline4\nline5\n';
    // Hunk 1 inserts 2 lines at line 2 (+2 delta)
    // Hunk 2 replaces line 4 with 1 line (0 delta)
    const prop = 'line1\ninsert1\ninsert2\nline2\nline3\nreplacement4\nline5\n';

    const res = store.createProposal({
      callId: 'call-multi',
      path: 'src/example.ts',
      base: dummyBase,
      originalContent: orig,
      proposedContent: prop,
      rationale: 'Multiple hunks with delta',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.proposal.hunks.length).toBe(2);
    const [h1, h2] = res.proposal.hunks;

    // First hunk: oldStart 2, oldLines 0, newLines 2 -> running delta becomes +2
    expect(h1.oldStart).toBe(2);
    expect(h1.newStart).toBe(2);
    expect(h1.newLines).toBe(2);

    // Second hunk: oldStart 4, oldLines 1, newLines 1
    // newStart must be oldStart (4) + runningDelta (+2) = 6
    expect(h2.oldStart).toBe(4);
    expect(h2.newStart).toBe(6);

    // Verify rebuilt text
    const rebuilt = rebuildFromHunks(orig, res.proposal.hunks);
    expect(rebuilt).toBe(prop);
  });

  it('returns ok: false with reason "no changes" when hunks are empty without throwing', () => {
    const store = new ProposalStore();
    const sameContent = 'line1\nline2\n';

    const res = store.createProposal({
      callId: 'call-no-op',
      path: 'src/example.ts',
      base: dummyBase,
      originalContent: sameContent,
      proposedContent: sameContent,
      rationale: 'Identical content',
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('no changes');
    }
  });
});

describe('ProposalStore grouping and hashing', () => {
  it('canonicalJson produces identical strings regardless of object key order', () => {
    const obj1 = { z: 1, a: 2, m: { y: 'yes', x: 'no' } };
    const obj2 = { a: 2, m: { x: 'no', y: 'yes' }, z: 1 };
    expect(canonicalJson(obj1)).toBe(canonicalJson(obj2));
  });

  it('computeArgsHash includes toolName so proposeEdit and createFile never collide on identical path and payload', () => {
    const path = 'src/test.ts';
    const payload = 'content';
    const editHash = computeArgsHash('proposeEdit', path, payload);
    const createHash = computeArgsHash('createFile', path, payload);

    expect(editHash).not.toBe(createHash);
  });

  it('groups identical createFile calls into one proposal with callIds.length === 2', () => {
    const store = new ProposalStore();
    const content = 'export const message = "hello";\n';

    const res1 = store.addOrGroup(
      {
        callId: 'call-create-1',
        path: 'src/new.ts',
        isNewFile: true,
        base: { contentHash: '', version: null, wasDirty: false },
        originalContent: '',
        proposedContent: content,
        rationale: 'Create new.ts',
      },
      'createFile',
      content
    );

    expect(res1.ok).toBe(true);
    if (!res1.ok) return;
    expect(res1.grouped).toBe(false);
    expect(res1.proposal.callIds).toEqual(['call-create-1']);

    const res2 = store.addOrGroup(
      {
        callId: 'call-create-2',
        path: 'src/new.ts',
        isNewFile: true,
        base: { contentHash: '', version: null, wasDirty: false },
        originalContent: '',
        proposedContent: content,
        rationale: 'Create new.ts duplicate',
      },
      'createFile',
      content
    );

    expect(res2.ok).toBe(true);
    if (!res2.ok) return;
    expect(res2.grouped).toBe(true);
    expect(res2.proposal.callIds.length).toBe(2);
    expect(res2.proposal.callIds).toEqual(['call-create-1', 'call-create-2']);
    expect(res2.proposal.callId).toBe('call-create-1');

    // Both callIds point to the same proposal
    expect(store.getByCallId('call-create-1')?.id).toBe(res1.proposal.id);
    expect(store.getByCallId('call-create-2')?.id).toBe(res1.proposal.id);
  });

  it('proposeEdit and createFile on same path never group together', () => {
    const store = new ProposalStore();
    const path = 'src/example.ts';
    const content = 'console.log("hello");\n';

    const createRes = store.addOrGroup(
      {
        callId: 'call-create',
        path,
        isNewFile: true,
        base: { contentHash: '', version: null, wasDirty: false },
        originalContent: '',
        proposedContent: content,
        rationale: 'Create file',
      },
      'createFile',
      content
    );

    const editRes = store.addOrGroup(
      {
        callId: 'call-edit',
        path,
        isNewFile: false,
        base: dummyBase,
        originalContent: 'line1\n',
        proposedContent: 'line1\nline2\n',
        rationale: 'Edit file',
      },
      'proposeEdit',
      [{ oldText: 'line1', newText: 'line1\nline2' }]
    );

    expect(createRes.ok).toBe(true);
    expect(editRes.ok).toBe(true);
    if (createRes.ok && editRes.ok) {
      expect(createRes.grouped).toBe(false);
      expect(editRes.grouped).toBe(false);
      expect(createRes.proposal.id).not.toBe(editRes.proposal.id);
    }
  });
});

describe('DecisionStore authoritative correlation and rules', () => {
  it('record() with identical decision twice is an idempotent no-op', () => {
    const store = new DecisionStore();
    const entry = {
      sessionId: 'sess-1',
      threadId: 'th-1',
      toolCallId: 'call-1',
      toolName: 'proposeEdit',
      path: 'src/app.ts',
      argsHash: 'hash-1',
      decision: { status: 'allow' as const, summary: 'Accepted' },
    };

    store.record(entry);
    // Recording again with identical values must not throw
    expect(() => store.record(entry)).not.toThrow();
  });

  it('record() with DIFFERENT decision for same toolCallId throws an error', () => {
    const store = new DecisionStore();
    const entry = {
      sessionId: 'sess-1',
      threadId: 'th-1',
      toolCallId: 'call-1',
      toolName: 'proposeEdit',
      path: 'src/app.ts',
      argsHash: 'hash-1',
      decision: { status: 'allow' as const, summary: 'Accepted' },
    };

    store.record(entry);

    const conflictingEntry = {
      ...entry,
      decision: { status: 'deny' as const, summary: 'User rejected' },
    };

    expect(() => store.record(conflictingEntry)).toThrow(
      /Conflicting decision recorded for toolCallId call-1/
    );
  });

  it('lookup with no active run returns error "no active run"', () => {
    const store = new DecisionStore();
    store.setActiveSession(null);

    const res = store.lookup({
      toolCallId: 'call-1',
      toolName: 'proposeEdit',
      path: 'src/app.ts',
      payload: [],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('no active run');
    }
  });

  it('lookup where threadId was omitted: exactly 1 match correlates successfully', () => {
    const store = new DecisionStore();
    store.setActiveSession('sess-1');

    const edits = [{ oldText: 'a', newText: 'b' }];
    const hash = computeArgsHash('proposeEdit', 'src/app.ts', edits);

    store.record({
      sessionId: 'sess-1',
      threadId: 'thread-alpha',
      toolCallId: 'call-single',
      toolName: 'proposeEdit',
      path: 'src/app.ts',
      argsHash: hash,
      decision: { status: 'allow', totalCount: 1, acceptedCount: 1 },
    });

    const res = store.lookup({
      toolCallId: 'call-single',
      // threadId omitted
      toolName: 'proposeEdit',
      path: 'src/app.ts',
      payload: edits,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.record.toolCallId).toBe('call-single');
      expect(res.record.state).toBe('CONSUMED');
    }
  });

  it('lookup where threadId was omitted: 2+ live records returns ambiguous error', () => {
    const store = new DecisionStore();
    store.setActiveSession('sess-1');

    const edits = [{ oldText: 'a', newText: 'b' }];
    const hash = computeArgsHash('proposeEdit', 'src/app.ts', edits);

    // Two live records with the same toolCallId under different threads in the same session
    store.record({
      sessionId: 'sess-1',
      threadId: 'thread-1',
      toolCallId: 'call-dup',
      toolName: 'proposeEdit',
      path: 'src/app.ts',
      argsHash: hash,
      decision: { status: 'allow', totalCount: 1 },
    });
    store.record({
      sessionId: 'sess-1',
      threadId: 'thread-2',
      toolCallId: 'call-dup',
      toolName: 'proposeEdit',
      path: 'src/app.ts',
      argsHash: hash,
      decision: { status: 'allow', totalCount: 1 },
    });

    const res = store.lookup({
      toolCallId: 'call-dup',
      // threadId omitted
      toolName: 'proposeEdit',
      path: 'src/app.ts',
      payload: edits,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('correlation_ambiguous');
    }
  });

  it('lookup where 2+ live records with DIFFERING decisions match returns ambiguous error', () => {
    const store = new DecisionStore();
    store.setActiveSession('sess-1');

    const edits = [{ oldText: 'foo', newText: 'bar' }];
    const hash = computeArgsHash('proposeEdit', 'src/app.ts', edits);

    // Two records matching the same argsHash but with different decisions
    store.record({
      sessionId: 'sess-1',
      threadId: 'thread-1',
      toolCallId: 'call-a',
      toolName: 'proposeEdit',
      path: 'src/app.ts',
      argsHash: hash,
      decision: { status: 'allow', acceptedCount: 1, totalCount: 1 },
    });
    store.record({
      sessionId: 'sess-1',
      threadId: 'thread-1',
      toolCallId: 'call-b',
      toolName: 'proposeEdit',
      path: 'src/app.ts',
      argsHash: hash,
      decision: { status: 'deny', summary: 'Rejected by user' },
    });

    // Lookup via argsHash fallback (no toolCallId)
    const res = store.lookup({
      toolName: 'proposeEdit',
      path: 'src/app.ts',
      payload: edits,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('correlation_ambiguous');
    }
  });

  it('lookup where exact toolCallId matches but argsHash differs is rejected without consuming record (proposeEdit)', () => {
    const store = new DecisionStore();
    store.setActiveSession('sess-1');

    const originalEdits = [{ oldText: 'original', newText: 'modified' }];
    const origHash = computeArgsHash('proposeEdit', 'src/app.ts', originalEdits);

    store.record({
      sessionId: 'sess-1',
      threadId: 'th-1',
      toolCallId: 'call-edit-mismatch',
      toolName: 'proposeEdit',
      path: 'src/app.ts',
      argsHash: origHash,
      decision: { status: 'allow', totalCount: 1 },
    });

    // Request comes with DIFFERENT edits
    const differentEdits = [{ oldText: 'tampered', newText: 'tampered' }];
    const res = store.lookup({
      toolCallId: 'call-edit-mismatch',
      threadId: 'th-1',
      toolName: 'proposeEdit',
      path: 'src/app.ts',
      payload: differentEdits,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('args_mismatch');
    }

    // Verify record was NOT consumed
    const retryWithCorrectArgs = store.lookup({
      toolCallId: 'call-edit-mismatch',
      threadId: 'th-1',
      toolName: 'proposeEdit',
      path: 'src/app.ts',
      payload: originalEdits,
    });
    expect(retryWithCorrectArgs.ok).toBe(true);
  });

  it('lookup where exact toolCallId matches but argsHash differs is rejected without consuming record (createFile)', () => {
    const store = new DecisionStore();
    store.setActiveSession('sess-1');

    const originalContent = 'export const config = true;\n';
    const origHash = computeArgsHash('createFile', 'src/config.ts', originalContent);

    store.record({
      sessionId: 'sess-1',
      threadId: 'th-1',
      toolCallId: 'call-create-mismatch',
      toolName: 'createFile',
      path: 'src/config.ts',
      argsHash: origHash,
      decision: { status: 'allow', byteCount: 28 },
    });

    // Request comes with DIFFERENT content
    const differentContent = 'export const tampered = true;\n';
    const res = store.lookup({
      toolCallId: 'call-create-mismatch',
      threadId: 'th-1',
      toolName: 'createFile',
      path: 'src/config.ts',
      payload: differentContent,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('args_mismatch');
    }

    // Verify record was NOT consumed
    const retry = store.lookup({
      toolCallId: 'call-create-mismatch',
      threadId: 'th-1',
      toolName: 'createFile',
      path: 'src/config.ts',
      payload: originalContent,
    });
    expect(retry.ok).toBe(true);
  });

  it('expires records older than 30 minutes', () => {
    const store = new DecisionStore();
    store.setActiveSession('sess-1');

    const edits = [{ oldText: 'a', newText: 'b' }];
    const hash = computeArgsHash('proposeEdit', 'src/app.ts', edits);

    // Record created 31 minutes ago
    store.record({
      sessionId: 'sess-1',
      threadId: 'th-1',
      toolCallId: 'call-expired',
      toolName: 'proposeEdit',
      path: 'src/app.ts',
      argsHash: hash,
      decision: { status: 'allow' },
      createdAt: Date.now() - (DECISION_TTL_MS + 60000),
    });

    const res = store.lookup({
      toolCallId: 'call-expired',
      threadId: 'th-1',
      toolName: 'proposeEdit',
      path: 'src/app.ts',
      payload: edits,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('record expired');
    }
  });

  it('enforces one-time consumption (second lookup fails)', () => {
    const store = new DecisionStore();
    store.setActiveSession('sess-1');

    const edits = [{ oldText: 'x', newText: 'y' }];
    const hash = computeArgsHash('proposeEdit', 'src/app.ts', edits);

    store.record({
      sessionId: 'sess-1',
      threadId: 'th-1',
      toolCallId: 'call-once',
      toolName: 'proposeEdit',
      path: 'src/app.ts',
      argsHash: hash,
      decision: { status: 'allow' },
    });

    const firstLookup = store.lookup({
      toolCallId: 'call-once',
      threadId: 'th-1',
      toolName: 'proposeEdit',
      path: 'src/app.ts',
      payload: edits,
    });
    expect(firstLookup.ok).toBe(true);

    const secondLookup = store.lookup({
      toolCallId: 'call-once',
      threadId: 'th-1',
      toolName: 'proposeEdit',
      path: 'src/app.ts',
      payload: edits,
    });
    expect(secondLookup.ok).toBe(false);
    if (!secondLookup.ok) {
      expect(secondLookup.error).toContain('consumed');
    }
  });
});

describe('MCP Handlers truthful acknowledgment responses', () => {
  const mockHost: UiHost = {
    workspaceRoot: '/mock/workspace',
    isWorkspaceTrusted: () => true,
    context: {
      resolveMention: async () => null,
      seed: async () => [],
      search: async () => ({ hits: [], omitted: 0 }),
      findSymbol: async () => ({ symbols: [] }),
      repoMap: async () => ({ tree: '', truncated: false }),
    },
    snapshot: async (p: string) => ({
      path: p,
      exists: true,
      text: 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12\nline 13\nline 14\nline 15\n',
      version: 1,
      isDirty: false,
      contentHash: 'hash',
    }),
    readFile: async () => '',
    runCommand: async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      killed: false,
    }),
    confirmCommand: async () => true,
  };

  const execContext: ToolExecutionContext = {
    host: mockHost,
  };

  it('handleProposeEdit returns exact truthful sentence when all hunks are accepted', async () => {
    const store = new DecisionStore();
    store.setActiveSession('sess-1');

    const edits = [{ oldText: 'line 2', newText: 'line 2 updated' }];
    const hash = computeArgsHash('proposeEdit', 'src/foo.ts', edits);

    store.record({
      sessionId: 'sess-1',
      threadId: 'th-1',
      toolCallId: 'call-all-accepted',
      toolName: PROPOSE_EDIT_TOOL_NAME,
      path: 'src/foo.ts',
      argsHash: hash,
      decision: {
        status: 'allow',
        totalCount: 3,
        acceptedCount: 3,
      },
    });

    const res = await handleProposeEdit(
      { path: 'src/foo.ts', edits, rationale: 'Test all accepted' },
      execContext,
      store,
      { toolCallId: 'call-all-accepted', threadId: 'th-1' }
    );

    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe(
      'Applied 3 of 3 hunks to src/foo.ts. The file on disk now contains only the accepted hunks. Re-read before editing again.'
    );
  });

  it('handleProposeEdit returns exact truthful sentence when some hunks are rejected', async () => {
    const store = new DecisionStore();
    store.setActiveSession('sess-1');

    const edits = [{ oldText: 'line 2', newText: 'line 2 updated' }];
    const hash = computeArgsHash('proposeEdit', 'src/x.py', edits);

    store.record({
      sessionId: 'sess-1',
      threadId: 'th-1',
      toolCallId: 'call-partial-accepted',
      toolName: PROPOSE_EDIT_TOOL_NAME,
      path: 'src/x.py',
      argsHash: hash,
      decision: {
        status: 'allow',
        totalCount: 3,
        acceptedCount: 2,
        rejectedHunkIds: ['h2'],
      },
    });

    const res = await handleProposeEdit(
      { path: 'src/x.py', edits, rationale: 'Test partial accepted' },
      execContext,
      store,
      { toolCallId: 'call-partial-accepted', threadId: 'th-1' }
    );

    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe(
      'Applied 2 of 3 hunks to src/x.py (rejected: h2). The file on disk now contains only the accepted hunks. Re-read before editing again.'
    );
  });

  it('handleProposeEdit returns truthful sentence when user rejects all changes', async () => {
    const store = new DecisionStore();
    store.setActiveSession('sess-1');

    const edits = [{ oldText: 'line 2', newText: 'line 2 updated' }];
    const hash = computeArgsHash('proposeEdit', 'src/foo.ts', edits);

    store.record({
      sessionId: 'sess-1',
      threadId: 'th-1',
      toolCallId: 'call-rejected',
      toolName: PROPOSE_EDIT_TOOL_NAME,
      path: 'src/foo.ts',
      argsHash: hash,
      decision: {
        status: 'deny',
        summary: 'User rejected all changes to src/foo.ts',
      },
    });

    const res = await handleProposeEdit(
      { path: 'src/foo.ts', edits, rationale: 'Test rejection' },
      execContext,
      store,
      { toolCallId: 'call-rejected', threadId: 'th-1' }
    );

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('User rejected all changes to src/foo.ts');
  });

  it('handleProposeEdit inline mode guard rejects edits starting >5 lines outside selected range', async () => {
    const store = new DecisionStore();
    store.setActiveSession('sess-1');

    // Snapshot has line 1..15.
    // Selected range is lines 1 to 2.
    // Edit targets "line 10", which is line 10 (10 > 2 + 5 = 7, so >5 lines outside).
    const edits = [{ oldText: 'line 10', newText: 'line 10 modified' }];
    const inlineRange: LineRange = { startLine: 1, endLine: 2 };

    const res = await handleProposeEdit(
      { path: 'src/foo.ts', edits, rationale: 'Inline edit' },
      execContext,
      store,
      { inlineRange }
    );

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain(
      'Edit starts >5 lines outside the selected range (lines 1–2). Rejected by inline mode guard.'
    );
  });

  it('handleCreateFile returns exact truthful sentence when allowed', async () => {
    const store = new DecisionStore();
    store.setActiveSession('sess-1');

    const content = 'export const test = 123;\n';
    const hash = computeArgsHash('createFile', 'src/new.ts', content);

    store.record({
      sessionId: 'sess-1',
      threadId: 'th-1',
      toolCallId: 'call-create-allow',
      toolName: CREATE_FILE_TOOL_NAME,
      path: 'src/new.ts',
      argsHash: hash,
      decision: {
        status: 'allow',
        byteCount: Buffer.byteLength(content, 'utf-8'),
      },
    });

    const res = await handleCreateFile(
      { path: 'src/new.ts', content, rationale: 'Add new file' },
      execContext,
      store,
      { toolCallId: 'call-create-allow', threadId: 'th-1' }
    );

    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe(
      `Created src/new.ts with ${Buffer.byteLength(content, 'utf-8')} bytes. The file on disk now contains the initial content.`
    );
  });

  it('handleCreateFile returns truthful sentence when user rejects creation', async () => {
    const store = new DecisionStore();
    store.setActiveSession('sess-1');

    const content = 'export const test = 123;\n';
    const hash = computeArgsHash('createFile', 'src/new.ts', content);

    store.record({
      sessionId: 'sess-1',
      threadId: 'th-1',
      toolCallId: 'call-create-deny',
      toolName: CREATE_FILE_TOOL_NAME,
      path: 'src/new.ts',
      argsHash: hash,
      decision: {
        status: 'deny',
        summary: 'User rejected creation of src/new.ts',
      },
    });

    const res = await handleCreateFile(
      { path: 'src/new.ts', content, rationale: 'Add new file' },
      execContext,
      store,
      { toolCallId: 'call-create-deny', threadId: 'th-1' }
    );

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('User rejected creation of src/new.ts');
  });
});
