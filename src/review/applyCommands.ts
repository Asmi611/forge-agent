/**
 * applyCommands.ts -- "Apply accepted changes" and "Undo last apply".
 * Shows plain-language results; the real work is in ApplyManager / UndoManager.
 */
import * as vscode from 'vscode';
import type { ApplyManager } from './ApplyManager';
import { summarize } from './applyMessages';
import type { DiffReviewer } from './DiffReviewer';
import type { UndoManager } from './UndoManager';

export function registerApplyCommands(context: vscode.ExtensionContext, reviewer: DiffReviewer, apply: ApplyManager | undefined, undo: UndoManager | undefined): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.applyAccepted', async () => {
      if (!apply) {
        void vscode.window.showInformationMessage('Forge: open a folder first, then try again.');
        return;
      }
      const proposals = reviewer.all();
      if (proposals.length === 0) {
        void vscode.window.showInformationMessage('Forge: there is nothing to apply right now.');
        return;
      }
      const accepted = proposals.reduce((n, p) => n + p.hunks.filter((h) => h.status === 'accepted').length, 0);
      if (accepted === 0) {
        void vscode.window.showInformationMessage('Forge: nothing is accepted yet. Click "✓ Accept" on a change first, then Apply.');
        return;
      }
      const outcome = await apply.apply(proposals);
      for (const r of outcome.results) if (r.applied) reviewer.remove(r.proposalId); // done: closes its diff tab
      const s = summarize(outcome);
      const show = s.level === 'error' ? vscode.window.showErrorMessage : s.level === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      void (s.offerUndo ? show(s.text, 'Undo') : show(s.text)).then((choice) => {
        if (choice === 'Undo') void vscode.commands.executeCommand('forge.undoLastApply');
      });
    }),
    vscode.commands.registerCommand('forge.undoLastApply', async () => {
      if (!undo || !undo.canUndo) {
        void vscode.window.showInformationMessage('Forge: there is nothing to undo.');
        return;
      }
      await undo.undoLast();
    }),
  );
}
