/**
 * ReviewStatusBar.ts -- two clickable items at the bottom of the window:
 *   "Apply 1 of 2 changes"   saves the accepted changes (only appears while a review is open)
 *   "Undo last apply"        puts the files back (appears after an Apply)
 * They answer the two questions a new user has: "is it saved yet?" and "can I take it back?".
 */
import * as vscode from 'vscode';
import { countHunks, statusBarText } from './applyMessages';
import type { DiffReviewer } from './DiffReviewer';
import type { UndoManager } from './UndoManager';

export class ReviewStatusBar implements vscode.Disposable {
  private readonly applyItem = vscode.window.createStatusBarItem('forge.review.apply', vscode.StatusBarAlignment.Left, 100);
  private readonly undoItem = vscode.window.createStatusBarItem('forge.review.undo', vscode.StatusBarAlignment.Left, 99);
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly reviewer: DiffReviewer,
    private readonly undo?: UndoManager,
  ) {
    this.applyItem.name = 'Forge: Save accepted changes';
    this.applyItem.command = 'forge.applyAccepted';
    this.undoItem.name = 'Forge: Undo last save';
    this.undoItem.command = 'forge.undoLastApply';
    this.undoItem.text = '$(discard) Undo last save';
    this.undoItem.tooltip = 'Put the files back exactly as they were before the last save.';
    this.subscriptions.push(this.reviewer.onDidChangeProposals(() => this.update()));
    if (this.undo) this.subscriptions.push(this.undo.onDidChange(() => this.update()));
    this.update();
  }

  private update(): void {
    const proposals = this.reviewer.all();
    if (proposals.length === 0) {
      this.applyItem.hide();
    } else {
      const label = statusBarText(countHunks(proposals));
      this.applyItem.text = label.text;
      this.applyItem.tooltip = label.tooltip;
      this.applyItem.show();
    }
    if (this.undo?.canUndo) this.undoItem.show();
    else this.undoItem.hide();
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.applyItem.dispose();
    this.undoItem.dispose();
  }
}
