/**
 * applyCommands.ts -- "Apply accepted changes" and "Undo last apply".
 * Shows plain-language results; the real work is in ApplyManager / UndoManager.
 *
 * What the user sees:
 *  - Apply with something accepted: it is saved, the review closes, and the saved file opens.
 *  - Apply when everything was rejected: nothing is written, the review closes.
 *  - Apply while changes are still undecided and none accepted: we ask instead of guessing.
 *  - Undo: the files go back and the review reopens with the same choices.
 */
import * as vscode from 'vscode';
import type { FileProposal } from '../types/contract';
import type { ApplyManager } from './ApplyManager';
import { chooseApplyAction, countHunks, isFinished, summarize } from './applyMessages';
import type { DiffReviewer } from './DiffReviewer';
import type { UndoManager } from './UndoManager';

const cloneProposals = (v: FileProposal[]): FileProposal[] => JSON.parse(JSON.stringify(v)) as FileProposal[];

export function registerApplyCommands(context: vscode.ExtensionContext, reviewer: DiffReviewer, apply: ApplyManager | undefined, undo: UndoManager | undefined): void {
  /** applyId -> the proposals as they were when applied (with the user's choices), so Undo can reopen the review. */
  const appliedBatches = new Map<string, FileProposal[]>();

  const showSavedFile = async (path: string): Promise<void> => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, ...path.split('/')));
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch {
      // Showing the file is a convenience only.
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('forge.applyAccepted', async () => {
      if (!apply) {
        void vscode.window.showInformationMessage('Forge: open a folder first, then try again.');
        return;
      }
      const proposals = reviewer.all();
      const counts = countHunks(proposals);
      const action = chooseApplyAction(counts);

      if (action === 'empty') {
        void vscode.window.showInformationMessage('Forge: there is nothing to review right now.');
        return;
      }
      if (action === 'ask-undecided') {
        const n = counts.pending;
        void vscode.window
          .showInformationMessage(
            `Forge: ${n} change${n === 1 ? ' is' : 's are'} not decided yet. Accept the ones you want first, or reject everything to close the review without saving.`,
            'Reject all and close',
          )
          .then((choice) => {
            if (choice !== 'Reject all and close') return undefined;
            for (const p of reviewer.all()) reviewer.setAllStatus(p.id, 'rejected');
            return vscode.commands.executeCommand('forge.applyAccepted');
          });
        return;
      }

      // 'go': apply what is accepted. If nothing is accepted this writes nothing and just finishes the review.
      const before = cloneProposals(proposals);
      const outcome = await apply.apply(proposals);

      const savedIds = new Set(outcome.results.filter((r) => r.applied).map((r) => r.proposalId));
      if (outcome.record && savedIds.size > 0) appliedBatches.set(outcome.applyId, before.filter((p) => savedIds.has(p.id)));

      for (const r of outcome.results) if (isFinished(r)) await reviewer.remove(r.proposalId); // closes its diff tab
      const firstSaved = outcome.results.find((r) => r.applied);
      if (firstSaved) await showSavedFile(firstSaved.path); // show the result, not whatever tab was open before

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
      const result = await undo.undoLast();
      if (!result?.ok) return; // cancelled or failed: UndoManager already told the user
      const batch = appliedBatches.get(result.applyId);
      appliedBatches.delete(result.applyId);
      if (!batch || batch.length === 0) return;
      // Reopen the review with the same choices so they can be adjusted.
      // (When the real engine is connected, these reopened proposals must NOT call reviewDone again: U-09.)
      for (const p of batch) reviewer.add(p);
      await reviewer.open(batch[0]?.id);
    }),
  );
}
