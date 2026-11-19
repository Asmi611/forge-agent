/**
 * ApplyManager.ts -- one of the ONLY two places (with UndoManager) allowed to change workspace files.
 *
 * The safety logic lives in applyCore.ts (tested without VS Code). This file supplies the real
 * VS Code operations (`VscodeWorkspaceOps`) and runs one Apply at a time.
 *
 * WorkspaceEdit is grouped but NOT transactional: a failure can leave some files changed.
 * That is why applyCore verifies every file after the edit and restores from the saved
 * original texts if anything is off.
 */
import * as vscode from 'vscode';
import type { FileProposal } from '../types/contract';
import { applyProposals, type ApplyOutcome, type ApplyRecord, type FileChange, type FileState, type WorkspaceOps } from './applyCore';

export interface UndoSink { push(record: ApplyRecord): void }

export class VscodeWorkspaceOps implements WorkspaceOps {
  constructor(
    private readonly root: vscode.Uri,
    private readonly storage: vscode.Uri,
  ) {}

  private uri(path: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root, ...path.split('/'));
  }

  async readCurrent(path: string): Promise<FileState> {
    const uri = this.uri(path);
    const open = vscode.workspace.textDocuments.find((d) => !d.isClosed && d.uri.toString() === uri.toString());
    let onDisk = true;
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      onDisk = false;
    }
    if (open) return { exists: onDisk, text: open.getText(), isDirty: open.isDirty };
    if (!onDisk) return { exists: false, text: '', isDirty: false };
    const bytes = await vscode.workspace.fs.readFile(uri);
    return { exists: true, text: new TextDecoder('utf-8').decode(bytes), isDirty: false };
  }

  async readDisk(path: string): Promise<string | null> {
    try {
      return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(this.uri(path)));
    } catch {
      return null;
    }
  }

  async applyEdit(changes: FileChange[]): Promise<boolean> {
    const edit = new vscode.WorkspaceEdit();
    for (const c of changes) {
      const uri = this.uri(c.path);
      if (c.kind === 'create') {
        edit.createFile(uri, { ignoreIfExists: false });
        edit.insert(uri, new vscode.Position(0, 0), c.text);
      } else if (c.kind === 'replace') {
        const doc = await vscode.workspace.openTextDocument(uri); // opened in the background, not shown
        edit.replace(uri, doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0)), c.text);
      } else {
        edit.deleteFile(uri, { ignoreIfNotExists: true });
      }
    }
    return vscode.workspace.applyEdit(edit);
  }

  /** Saves exactly ONE document (never "save all", which would also save the user's unrelated unsaved tabs). */
  async save(path: string): Promise<boolean> {
    const doc = await vscode.workspace.openTextDocument(this.uri(path));
    const ok = await doc.save();
    return ok || !doc.isDirty;
  }

  async persistRecovery(applyId: string, files: { path: string; before: string | null }[]): Promise<string | undefined> {
    try {
      const dir = vscode.Uri.joinPath(this.storage, 'recovery');
      await vscode.workspace.fs.createDirectory(dir);
      const file = vscode.Uri.joinPath(dir, `${applyId}.json`);
      const body = JSON.stringify({ applyId, createdAt: new Date().toISOString(), files }, null, 2);
      await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(body));
      return file.fsPath;
    } catch {
      return undefined;
    }
  }
}

export class ApplyManager implements vscode.Disposable {
  private readonly applied = new vscode.EventEmitter<ApplyOutcome>();
  /** Fires after every Apply (the batch-review card uses this to call engine.reviewDone). */
  readonly onDidApply = this.applied.event;
  private chain: Promise<unknown> = Promise.resolve();
  private counter = 0;

  constructor(
    private readonly ops: WorkspaceOps,
    private readonly undo: UndoSink,
  ) {}

  /** Applies every accepted hunk of these proposals as ONE action. Runs one Apply at a time. */
  apply(proposals: readonly FileProposal[]): Promise<ApplyOutcome> {
    const run = async (): Promise<ApplyOutcome> => {
      const applyId = `apply-${Date.now().toString(36)}-${++this.counter}`;
      const outcome = await applyProposals(this.ops, proposals, applyId);
      if (outcome.record) this.undo.push(outcome.record);
      this.applied.fire(outcome);
      return outcome;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  dispose(): void {
    this.applied.dispose();
  }
}
