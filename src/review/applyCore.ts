/**
 * applyCore.ts -- the safe-apply and undo LOGIC, with no VS Code and no disk access.
 *
 * ApplyManager / UndoManager (the only writers) give this code a `WorkspaceOps` object
 * that does the real reading and writing. Because the logic only talks to that small
 * interface, every failure path (stale file, VS Code refusing the edit, a save that
 * fails, a restore that fails) can be unit tested with a fake.
 *
 * Safety rules implemented here:
 *  1. A file edited since the proposal (hash differs) is refused, never merged.
 *  2. Before anything changes, the original texts are saved to a recovery file.
 *  3. ONE workspace edit for the whole batch; afterwards every document is re-read and
 *     compared with what we expected. Any mismatch => restore everything.
 *  4. Only the files we changed are saved (there is deliberately no "save all").
 *  5. We never claim a rollback we did not verify: if the restore cannot be verified the
 *     failure is `restore_failed` and carries the recovery file path.
 *
 * Note: VS Code keeps ONE line-ending style per open file, so texts are compared with
 * line endings normalised (see sameText).
 */
import { createHash } from 'crypto';
import type { FileProposal, HunkStatus } from '../types/contract';
import { buildText } from './hunkText';

export type FailureKind = 'stale' | 'apply_failed' | 'restore_failed';
export interface ApplyFailure { kind: FailureKind; message: string; recoveryPath?: string }

export interface FileState { exists: boolean; text: string; isDirty: boolean }

export type FileChange =
  | { path: string; kind: 'replace'; text: string }
  | { path: string; kind: 'create'; text: string }
  | { path: string; kind: 'delete' };

/** Everything the core needs from the outside world. */
export interface WorkspaceOps {
  /** Current text: the open document if there is one (saved or not), else the file on disk. */
  readCurrent(path: string): Promise<FileState>;
  /** Text on disk, or null if the file does not exist. */
  readDisk(path: string): Promise<string | null>;
  /** ONE workspace edit for all changes. Resolves false if VS Code refused it. */
  applyEdit(changes: FileChange[]): Promise<boolean>;
  /** Save ONE file. Resolves true if it is saved afterwards. */
  save(path: string): Promise<boolean>;
  /** Store the original texts somewhere safe (outside the workspace). Returns where, or undefined on failure. */
  persistRecovery(applyId: string, files: { path: string; before: string | null }[]): Promise<string | undefined>;
}

export interface ApplyFileRecord { path: string; before: string | null; afterHash: string; wasDirty: boolean }
export interface ApplyRecord { applyId: string; createdAt: number; files: ApplyFileRecord[] }

export interface ProposalOutcome {
  proposalId: string;
  path: string;
  decisions: Record<string, HunkStatus>;
  acceptedCount: number;
  totalHunks: number;
  applied: boolean;
  failure?: ApplyFailure;
}
export interface ApplyOutcome { applyId: string; results: ProposalOutcome[]; record?: ApplyRecord }

// ───────── small pure helpers ─────────
export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}
/**
 * THE content hash of the whole project (proposal.base.contentHash, DocSnapshot.contentHash,
 * undo records). Line endings are normalised first, because VS Code keeps one line-ending
 * style per open file and a Windows file may be CRLF while a proposal was built from LF text.
 * Always use this function; never hash a file's text any other way.
 */
export function hashText(text: string): string {
  return createHash('sha256').update(normalizeEol(text)).digest('hex');
}
export function sameText(a: string, b: string): boolean {
  return normalizeEol(a) === normalizeEol(b);
}
/** Workspace-relative, forward slashes, no "..", no absolute paths. */
export function isSafeRelativePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\') || /^[a-zA-Z]:/.test(path)) return false;
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

async function readOrNull(ops: WorkspaceOps, path: string): Promise<FileState | null> {
  try {
    return await ops.readCurrent(path);
  } catch {
    return null;
  }
}
async function saveSafely(ops: WorkspaceOps, path: string): Promise<boolean> {
  try {
    return await ops.save(path);
  } catch {
    return false;
  }
}
async function applyEditSafely(ops: WorkspaceOps, changes: FileChange[]): Promise<boolean> {
  try {
    return await ops.applyEdit(changes);
  } catch {
    return false;
  }
}

// ───────── restore (used by apply on failure, and by undo) ─────────
export interface RestoreItem { path: string; before: string | null; wasDirty: boolean }

/**
 * Put files back to their `before` text (or delete files that were created), then RE-READ
 * and compare. `verified` is true only if every file really is back as it was.
 * `saved` = paths we had already saved, so the restored text must be saved again.
 */
export async function restoreFiles(ops: WorkspaceOps, files: readonly RestoreItem[], saved: ReadonlySet<string>): Promise<{ verified: boolean }> {
  const changes: FileChange[] = files.map((f) =>
    f.before === null ? { path: f.path, kind: 'delete' } : { path: f.path, kind: 'replace', text: f.before });
  if (!(await applyEditSafely(ops, changes))) return { verified: false };

  let verified = true;
  for (const f of files) {
    const cur = await readOrNull(ops, f.path);
    if (f.before === null) {
      if (!cur || cur.exists) verified = false; // a created file must be gone
      continue;
    }
    if (!cur || !cur.exists || !sameText(cur.text, f.before)) { verified = false; continue; }
    // If we had saved it, or it was clean before, the file on disk must match again too.
    if (saved.has(f.path) || !f.wasDirty) {
      const diskNow = await ops.readDisk(f.path).catch(() => null);
      if (diskNow !== null && sameText(diskNow, f.before)) {
        // Disk is already right. Saving only clears the editor's "unsaved" marker, so a failure here is harmless.
        if (!saved.has(f.path)) await saveSafely(ops, f.path);
        continue;
      }
      if (!(await saveSafely(ops, f.path))) { verified = false; continue; }
      const disk = await ops.readDisk(f.path).catch(() => null);
      if (disk === null || !sameText(disk, f.before)) verified = false;
    }
  }
  return { verified };
}

// ───────── apply ─────────
function acceptedOf(p: FileProposal): number {
  return p.hunks.filter((h) => h.status === 'accepted').length;
}

export async function applyProposals(ops: WorkspaceOps, proposals: readonly FileProposal[], applyId: string, now: () => number = Date.now): Promise<ApplyOutcome> {
  const results: ProposalOutcome[] = proposals.map((p) => {
    const decisions: Record<string, HunkStatus> = {};
    for (const h of p.hunks) decisions[h.id] = h.status;
    return { proposalId: p.id, path: p.path, decisions, acceptedCount: acceptedOf(p), totalHunks: p.hunks.length, applied: false };
  });
  const fail = (i: number, failure: ApplyFailure): void => {
    const r = results[i];
    if (r) { r.applied = false; r.failure = failure; }
  };

  interface Planned { index: number; path: string; before: string | null; wasDirty: boolean; finalText: string }
  const planned: Planned[] = [];

  // 1) plan: stale check + final text for every proposal that has an accepted hunk
  for (const [i, p] of proposals.entries()) {
    if (acceptedOf(p) === 0) continue; // nothing accepted: nothing to write (pending hunks are NOT applied)
    if (!isSafeRelativePath(p.path)) { fail(i, { kind: 'apply_failed', message: `${p.path} is outside the workspace.` }); continue; }
    const state = await readOrNull(ops, p.path);
    if (!state) { fail(i, { kind: 'apply_failed', message: `Forge could not read ${p.path}.` }); continue; }
    if (p.isNewFile) {
      if (state.exists) { fail(i, { kind: 'stale', message: `${p.path} already exists now.` }); continue; }
    } else {
      if (!state.exists) { fail(i, { kind: 'stale', message: `${p.path} was deleted or moved.` }); continue; }
      if (hashText(state.text) !== p.base.contentHash) { fail(i, { kind: 'stale', message: `${p.path} changed after the proposal was made.` }); continue; }
    }
    let finalText: string;
    try {
      finalText = buildText(p, 'final').text;
    } catch {
      fail(i, { kind: 'apply_failed', message: `The proposed changes for ${p.path} are inconsistent.` });
      continue;
    }
    planned.push({ index: i, path: p.path, before: p.isNewFile ? null : state.text, wasDirty: state.isDirty, finalText });
  }
  if (planned.length === 0) return { applyId, results };

  // 2) recovery copy FIRST: if we cannot make one, change nothing
  const recoveryPath = await ops.persistRecovery(applyId, planned.map((x) => ({ path: x.path, before: x.before }))).catch(() => undefined);
  if (recoveryPath === undefined) {
    for (const x of planned) fail(x.index, { kind: 'apply_failed', message: 'Forge could not save a recovery copy first, so nothing was changed.' });
    return { applyId, results };
  }

  const saved = new Set<string>();
  const rollback = async (message: string): Promise<ApplyOutcome> => {
    const { verified } = await restoreFiles(ops, planned.map((x) => ({ path: x.path, before: x.before, wasDirty: x.wasDirty })), saved);
    const failure: ApplyFailure = verified
      ? { kind: 'apply_failed', message }
      : { kind: 'restore_failed', message: `${message} Forge could not confirm that your files were put back.`, recoveryPath };
    for (const x of planned) fail(x.index, failure);
    return { applyId, results };
  };

  // 3) ONE workspace edit (grouped, but NOT transactional: verify + restore is our safety net)
  const changes: FileChange[] = planned.map((x) => (x.before === null ? { path: x.path, kind: 'create', text: x.finalText } : { path: x.path, kind: 'replace', text: x.finalText }));
  if (!(await applyEditSafely(ops, changes))) return rollback('VS Code did not accept the change.');

  // 4) verify what is now in each document
  const after = new Map<string, string>();
  for (const x of planned) {
    const cur = await readOrNull(ops, x.path);
    if (!cur || !cur.exists || !sameText(cur.text, x.finalText)) return rollback(`The result in ${x.path} was not what Forge expected.`);
    after.set(x.path, cur.text);
  }

  // 5) save ONLY these files, check each result, verify the disk
  for (const x of planned) {
    if (!(await saveSafely(ops, x.path))) return rollback(`Forge could not save ${x.path}.`);
    saved.add(x.path);
    const disk = await ops.readDisk(x.path).catch(() => null);
    if (disk === null || !sameText(disk, x.finalText)) return rollback(`The saved file ${x.path} was not what Forge expected.`);
  }

  // 6) success: remember how to undo it
  const record: ApplyRecord = {
    applyId,
    createdAt: now(),
    files: planned.map((x) => ({ path: x.path, before: x.before, afterHash: hashText(after.get(x.path) ?? x.finalText), wasDirty: x.wasDirty })),
  };
  for (const x of planned) {
    const r = results[x.index];
    if (r) r.applied = true;
  }
  return { applyId, results, record };
}

// ───────── undo ─────────
export interface UndoResult { ok: boolean; cancelled: boolean; undone: string[]; edited: string[]; message: string }

export async function undoRecord(ops: WorkspaceOps, record: ApplyRecord, confirmEdited: (paths: string[]) => Promise<boolean>): Promise<UndoResult> {
  const edited: string[] = [];
  for (const f of record.files) {
    const cur = await readOrNull(ops, f.path);
    if (!cur || !cur.exists || hashText(cur.text) !== f.afterHash) edited.push(f.path);
  }
  if (edited.length > 0 && !(await confirmEdited(edited))) {
    return { ok: false, cancelled: true, undone: [], edited, message: 'Undo cancelled: some files were edited after the apply.' };
  }
  const { verified } = await restoreFiles(
    ops,
    record.files.map((f) => ({ path: f.path, before: f.before, wasDirty: f.wasDirty })),
    new Set(record.files.map((f) => f.path)),
  );
  const paths = record.files.map((f) => f.path);
  return verified
    ? { ok: true, cancelled: false, undone: paths, edited, message: `Undone ${paths.length} file${paths.length === 1 ? '' : 's'}.` }
    : { ok: false, cancelled: false, undone: [], edited, message: 'Forge could not confirm the undo. Check these files: ' + paths.join(', ') };
}

/** hunk decisions in the shape ReviewResult.proposals[] expects. */
export function toReviewProposals(outcome: ApplyOutcome): { proposalId: string; decisions: Record<string, HunkStatus>; applied: boolean; failure?: ApplyFailure }[] {
  return outcome.results.map((r) => (r.failure ? { proposalId: r.proposalId, decisions: r.decisions, applied: r.applied, failure: r.failure } : { proposalId: r.proposalId, decisions: r.decisions, applied: r.applied }));
}
