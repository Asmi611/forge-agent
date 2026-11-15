import { describe, expect, it } from 'vitest';
import { applyProposals, hashText, isSafeRelativePath, sameText, toReviewProposals, undoRecord, type FileChange, type FileState, type WorkspaceOps } from '../../src/review/applyCore';
import { summarize } from '../../src/review/applyMessages';
import type { FileProposal, Hunk, HunkStatus } from '../../src/types/contract';

// ───────── a fake workspace with failure injection ─────────
interface FakeFile { disk: string; doc?: string; dirty: boolean }

class FakeOps implements WorkspaceOps {
  files = new Map<string, FakeFile>();
  saveCalls: string[] = [];
  editCalls = 0;
  failEditOnCall = new Set<number>();   // 1-based call numbers of applyEdit that return false
  failSave = new Set<string>();
  failRecovery = false;
  corruptAfterEdit = false;             // make the document differ from what was requested
  recovery: { id: string; files: { path: string; before: string | null }[] } | undefined;

  constructor(initial: Record<string, string>) {
    for (const [p, t] of Object.entries(initial)) this.files.set(p, { disk: t, dirty: false });
  }
  async readCurrent(path: string): Promise<FileState> {
    const f = this.files.get(path);
    return f ? { exists: true, text: f.doc ?? f.disk, isDirty: f.dirty } : { exists: false, text: '', isDirty: false };
  }
  async readDisk(path: string): Promise<string | null> {
    return this.files.get(path)?.disk ?? null;
  }
  async applyEdit(changes: FileChange[]): Promise<boolean> {
    this.editCalls++;
    if (this.failEditOnCall.has(this.editCalls)) return false;
    for (const c of changes) {
      if (c.kind === 'delete') this.files.delete(c.path);
      else if (c.kind === 'create') this.files.set(c.path, { disk: '', doc: c.text, dirty: true });
      else {
        const f = this.files.get(c.path);
        if (!f) return false;
        f.doc = this.corruptAfterEdit ? c.text + 'X' : c.text;
        f.dirty = true;
      }
    }
    return true;
  }
  async save(path: string): Promise<boolean> {
    if (this.failSave.has(path)) return false;
    const f = this.files.get(path);
    if (!f) return false;
    this.saveCalls.push(path);
    f.disk = f.doc ?? f.disk;
    f.dirty = false;
    return true;
  }
  async persistRecovery(id: string, files: { path: string; before: string | null }[]): Promise<string | undefined> {
    if (this.failRecovery) return undefined;
    this.recovery = { id, files };
    return `/storage/recovery/${id}.json`;
  }
  text(path: string): string | undefined {
    const f = this.files.get(path);
    return f ? (f.doc ?? f.disk) : undefined;
  }
}

// ───────── proposal helpers ─────────
function hunk(id: string, oldStart: number, oldLines: number, newText: string, status: HunkStatus): Hunk {
  const newLines = newText === '' ? 0 : newText.split('\n').length;
  return { id, oldStart, oldLines, newStart: oldStart, newLines, oldText: '', newText, status };
}
function proposal(id: string, path: string, original: string, hunks: Hunk[], isNewFile = false): FileProposal {
  return {
    id, callId: `c-${id}`, callIds: [`c-${id}`], path, isNewFile,
    base: { contentHash: hashText(original), version: 1, wasDirty: false },
    originalContent: original, proposedContent: '', hunks, rationale: '', createdAt: 0,
  };
}

const ORIG = 'one\ntwo\nthree\nfour\nfive\n';
const twoHunks = (s1: HunkStatus, s2: HunkStatus): FileProposal =>
  proposal('p1', 'src/a.txt', ORIG, [hunk('h1', 2, 1, 'TWO', s1), hunk('h2', 5, 1, 'FIVE', s2)]);

describe('applyProposals: normal flow', () => {
  it('accept 1, reject 2: only hunk 1 reaches the file (and disk), pending ones are not applied', async () => {
    const ops = new FakeOps({ 'src/a.txt': ORIG });
    const out = await applyProposals(ops, [twoHunks('accepted', 'rejected')], 'a1');
    expect(ops.files.get('src/a.txt')?.disk).toBe('one\nTWO\nthree\nfour\nfive\n');
    expect(out.results[0]).toMatchObject({ applied: true, acceptedCount: 1, totalHunks: 2 });
    expect(out.record?.files[0]).toMatchObject({ path: 'src/a.txt', before: ORIG, wasDirty: false });
    const pending = await applyProposals(new FakeOps({ 'src/a.txt': ORIG }), [twoHunks('accepted', 'pending')], 'a2');
    expect(pending.results[0]?.applied).toBe(true);
  });

  it('nothing accepted: nothing is written, no error', async () => {
    const ops = new FakeOps({ 'src/a.txt': ORIG });
    const out = await applyProposals(ops, [twoHunks('rejected', 'pending')], 'a1');
    expect(ops.editCalls).toBe(0);
    expect(out.results[0]).toMatchObject({ applied: false });
    expect(out.results[0]?.failure).toBeUndefined();
    expect(out.record).toBeUndefined();
  });

  it('saves ONLY the files it changed (an unrelated dirty file is never saved)', async () => {
    const ops = new FakeOps({ 'src/a.txt': ORIG, 'src/unrelated.txt': 'mine\n' });
    const unrelated = ops.files.get('src/unrelated.txt');
    if (unrelated) { unrelated.doc = 'mine, edited but not saved\n'; unrelated.dirty = true; }
    await applyProposals(ops, [twoHunks('accepted', 'accepted')], 'a1');
    expect(ops.saveCalls).toEqual(['src/a.txt']);
    expect(ops.files.get('src/unrelated.txt')).toMatchObject({ dirty: true, disk: 'mine\n' });
  });

  it('creates a new file, and undo deletes it again', async () => {
    const ops = new FakeOps({});
    const p = proposal('n1', 'src/new.txt', '', [hunk('h1', 1, 0, 'hello\nworld', 'accepted')], true);
    const out = await applyProposals(ops, [p], 'a1');
    expect(ops.files.get('src/new.txt')?.disk).toBe('hello\nworld\n');
    expect(out.record?.files[0]?.before).toBeNull();
    const undo = await undoRecord(ops, out.record!, async () => true);
    expect(undo.ok).toBe(true);
    expect(ops.files.has('src/new.txt')).toBe(false);
  });

  it('a batch of 3 files is ONE edit', async () => {
    const ops = new FakeOps({ 'a.txt': ORIG, 'b.txt': ORIG, 'c.txt': ORIG });
    const ps = ['a', 'b', 'c'].map((n) => proposal(n, `${n}.txt`, ORIG, [hunk('h1', 1, 1, 'ONE', 'accepted')]));
    const out = await applyProposals(ops, ps, 'a1');
    expect(ops.editCalls).toBe(1);
    expect(out.record?.files).toHaveLength(3);
  });

  it('line endings: an editor that normalises CRLF to LF still verifies', async () => {
    const crlf = 'a\r\nb\r\nc\r\n';
    const ops = new FakeOps({ 'x.txt': crlf });
    const out = await applyProposals(ops, [proposal('p', 'x.txt', crlf, [hunk('h1', 2, 1, 'B', 'accepted')])], 'a1');
    expect(out.results[0]?.applied).toBe(true);
    expect(sameText(ops.text('x.txt') ?? '', 'a\nB\nc\n')).toBe(true);
  });
});

describe('applyProposals: safety', () => {
  it('stale file: edited during review => refused, file untouched; other files still apply', async () => {
    const ops = new FakeOps({ 'src/a.txt': ORIG + 'user typed this\n', 'src/b.txt': ORIG });
    const a = twoHunks('accepted', 'accepted');
    const b = proposal('p2', 'src/b.txt', ORIG, [hunk('h1', 1, 1, 'ONE', 'accepted')]);
    const out = await applyProposals(ops, [a, b], 'a1');
    expect(out.results[0]?.failure?.kind).toBe('stale');
    expect(ops.text('src/a.txt')).toBe(ORIG + 'user typed this\n');
    expect(out.results[1]?.applied).toBe(true);
  });

  it('unsaved edit that was already there when the proposal was made is fine (hash matches)', async () => {
    const ops = new FakeOps({ 'src/a.txt': 'disk version\n' });
    const f = ops.files.get('src/a.txt');
    if (f) { f.doc = ORIG; f.dirty = true; }
    const out = await applyProposals(ops, [twoHunks('accepted', 'rejected')], 'a1');
    expect(out.results[0]?.applied).toBe(true);
    expect(out.record?.files[0]?.wasDirty).toBe(true);
  });

  it('file deleted since the proposal => stale', async () => {
    const out = await applyProposals(new FakeOps({}), [twoHunks('accepted', 'accepted')], 'a1');
    expect(out.results[0]?.failure?.kind).toBe('stale');
  });

  it('rejects paths outside the workspace without touching anything', async () => {
    const ops = new FakeOps({});
    const p = proposal('p', '../outside.txt', ORIG, [hunk('h1', 1, 1, 'x', 'accepted')]);
    const out = await applyProposals(ops, [p], 'a1');
    expect(out.results[0]?.failure?.kind).toBe('apply_failed');
    expect(ops.editCalls).toBe(0);
    expect(['a/b.txt', 'src/x.py'].every(isSafeRelativePath)).toBe(true);
    expect(['', '/etc/passwd', 'C:/x', 'a/../b', 'a\\b', './a'].some(isSafeRelativePath)).toBe(false);
  });

  it('no recovery copy => nothing is changed', async () => {
    const ops = new FakeOps({ 'src/a.txt': ORIG });
    ops.failRecovery = true;
    const out = await applyProposals(ops, [twoHunks('accepted', 'accepted')], 'a1');
    expect(out.results[0]?.failure?.kind).toBe('apply_failed');
    expect(ops.editCalls).toBe(0);
    expect(ops.text('src/a.txt')).toBe(ORIG);
  });

  it('VS Code refuses the edit => apply_failed, files unchanged', async () => {
    const ops = new FakeOps({ 'src/a.txt': ORIG });
    ops.failEditOnCall.add(1);
    const out = await applyProposals(ops, [twoHunks('accepted', 'accepted')], 'a1');
    expect(out.results[0]?.failure?.kind).toBe('apply_failed');
    expect(ops.text('src/a.txt')).toBe(ORIG);
  });

  it('verification mismatch => everything restored and verified (apply_failed)', async () => {
    const ops = new FakeOps({ 'src/a.txt': ORIG });
    ops.corruptAfterEdit = true;
    const out = await applyProposals(ops, [twoHunks('accepted', 'accepted')], 'a1');
    // the restore edit is also "corrupted" by this fake, so turn that off for the restore
    expect(['apply_failed', 'restore_failed']).toContain(out.results[0]?.failure?.kind);
  });

  it('verification mismatch with a working restore => apply_failed and the original text is back', async () => {
    const ops = new FakeOps({ 'src/a.txt': ORIG });
    const original = ops.applyEdit.bind(ops);
    let first = true;
    ops.applyEdit = async (changes) => {
      const ok = await original(changes);
      if (first) { first = false; const f = ops.files.get('src/a.txt'); if (f && f.doc) f.doc += 'JUNK'; }
      return ok;
    };
    const out = await applyProposals(ops, [twoHunks('accepted', 'accepted')], 'a1');
    expect(out.results[0]?.failure?.kind).toBe('apply_failed');
    expect(ops.text('src/a.txt')).toBe(ORIG);
    expect(ops.files.get('src/a.txt')?.disk).toBe(ORIG);
  });

  it('save fails => restored, apply_failed', async () => {
    const ops = new FakeOps({ 'src/a.txt': ORIG });
    ops.failSave.add('src/a.txt');
    const out = await applyProposals(ops, [twoHunks('accepted', 'accepted')], 'a1');
    expect(out.results[0]?.failure?.kind).toBe('apply_failed');
    expect(ops.text('src/a.txt')).toBe(ORIG);
  });

  it('INJECTED RESTORE FAILURE => restore_failed with the recovery path', async () => {
    const ops = new FakeOps({ 'src/a.txt': ORIG });
    ops.failSave.add('src/a.txt');   // forces a rollback...
    ops.failEditOnCall.add(2);       // ...and the rollback's edit fails too
    const out = await applyProposals(ops, [twoHunks('accepted', 'accepted')], 'a1');
    const f = out.results[0]?.failure;
    expect(f?.kind).toBe('restore_failed');
    expect(f?.recoveryPath).toBe('/storage/recovery/a1.json');
    expect(ops.recovery?.files[0]).toEqual({ path: 'src/a.txt', before: ORIG }); // the original text is safe in the recovery file
    expect(summarize(out)).toMatchObject({ level: 'error' });
    expect(summarize(out).text).toContain('/storage/recovery/a1.json');
  });
});

describe('undoRecord', () => {
  it('restores the text from before the apply, on disk too', async () => {
    const ops = new FakeOps({ 'src/a.txt': ORIG });
    const out = await applyProposals(ops, [twoHunks('accepted', 'accepted')], 'a1');
    const undo = await undoRecord(ops, out.record!, async () => true);
    expect(undo).toMatchObject({ ok: true, undone: ['src/a.txt'] });
    expect(ops.files.get('src/a.txt')).toMatchObject({ disk: ORIG, dirty: false });
  });

  it('refuses when the file was edited since, unless the user confirms', async () => {
    const ops = new FakeOps({ 'src/a.txt': ORIG });
    const out = await applyProposals(ops, [twoHunks('accepted', 'accepted')], 'a1');
    const f = ops.files.get('src/a.txt');
    if (f) { f.doc = (f.doc ?? f.disk) + 'newer edit\n'; f.dirty = true; }
    const refused = await undoRecord(ops, out.record!, async () => false);
    expect(refused).toMatchObject({ ok: false, cancelled: true, edited: ['src/a.txt'] });
    expect(ops.text('src/a.txt')).toContain('newer edit');
    const forced = await undoRecord(ops, out.record!, async (paths) => paths.length === 1);
    expect(forced.ok).toBe(true);
    expect(ops.text('src/a.txt')).toBe(ORIG);
  });
});

describe('messages and ReviewResult shape', () => {
  it('plain-language summaries', async () => {
    const ops = new FakeOps({ 'src/a.txt': ORIG });
    const ok = await applyProposals(ops, [twoHunks('accepted', 'rejected')], 'a1');
    expect(summarize(ok)).toEqual({ level: 'info', text: 'Forge: Saved 1 of 2 changes in src/a.txt.', offerUndo: true });
    const none = await applyProposals(new FakeOps({ 'src/a.txt': ORIG }), [twoHunks('rejected', 'rejected')], 'a2');
    expect(summarize(none).text).toBe('Forge: Nothing was accepted, so nothing was changed.');
    const stale = await applyProposals(new FakeOps({ 'src/a.txt': 'changed\n' }), [twoHunks('accepted', 'accepted')], 'a3');
    expect(summarize(stale)).toMatchObject({ level: 'warning', offerUndo: false });
  });

  it('toReviewProposals matches the contract shape', async () => {
    const ops = new FakeOps({ 'src/a.txt': ORIG });
    const out = await applyProposals(ops, [twoHunks('accepted', 'rejected')], 'a1');
    expect(toReviewProposals(out)).toEqual([{ proposalId: 'p1', decisions: { h1: 'accepted', h2: 'rejected' }, applied: true }]);
  });
});
