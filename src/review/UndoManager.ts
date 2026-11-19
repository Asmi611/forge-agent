/**
 * UndoManager.ts -- the other writer. Keeps a stack of Apply records and puts files back
 * exactly as they were before an Apply (works even after the tabs were closed).
 * If a file was edited after the Apply, it asks before overwriting that newer work.
 */
import * as vscode from 'vscode';
import { undoRecord, type ApplyRecord, type UndoResult, type WorkspaceOps } from './applyCore';

const MAX_RECORDS = 20;

export type UndoOutcome = UndoResult & { applyId: string };

export class UndoManager implements vscode.Disposable {
  private readonly stack: ApplyRecord[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly ops: WorkspaceOps) {}

  get canUndo(): boolean {
    return this.stack.length > 0;
  }

  push(record: ApplyRecord): void {
    this.stack.push(record);
    if (this.stack.length > MAX_RECORDS) this.stack.shift();
    this.changed.fire();
  }

  async undoLast(): Promise<UndoOutcome | undefined> {
    const record = this.stack[this.stack.length - 1];
    if (!record) return undefined;
    const result = await undoRecord(this.ops, record, async (paths) => {
      const answer = await vscode.window.showWarningMessage(
        `These files were edited after Forge saved its changes: ${paths.join(', ')}. Undo anyway? Your newer edits in them will be lost.`,
        { modal: true },
        'Undo anyway',
      );
      return answer === 'Undo anyway';
    });
    if (result.ok) {
      this.stack.pop();
      this.changed.fire();
      void vscode.window.showInformationMessage(`Forge: ${result.message}`);
    } else if (!result.cancelled) {
      void vscode.window.showErrorMessage(`Forge: ${result.message}`);
    }
    return { ...result, applyId: record.applyId };
  }

  dispose(): void {
    this.changed.dispose();
  }
}
