/**
 * Forge Agent extension entry point (Dev 2-owned wiring surface).
 *
 * Registers the review UI (DiffReviewer, ApplyManager, UndoManager, ReviewStatusBar)
 * and the "Forge: Show Demo Diff (mock)" command.
 */
import * as vscode from 'vscode';
import { ApplyManager, VscodeWorkspaceOps } from './review/ApplyManager';
import { DiffReviewer } from './review/DiffReviewer';
import { ReviewStatusBar } from './review/ReviewStatusBar';
import { UndoManager } from './review/UndoManager';
import { registerApplyCommands } from './review/applyCommands';
import { proposalFromFixture, type DemoFixture } from './review/demoProposal';
import { registerReviewCommands } from './review/reviewCommands';

export function activate(context: vscode.ExtensionContext): void {
  const reviewer = new DiffReviewer();
  context.subscriptions.push(reviewer);

  const folder = vscode.workspace.workspaceFolders?.[0];
  let apply: ApplyManager | undefined;
  let undo: UndoManager | undefined;

  if (folder) {
    const storageUri = context.storageUri ?? context.globalStorageUri;
    const ops = new VscodeWorkspaceOps(folder.uri, storageUri);
    undo = new UndoManager(ops);
    apply = new ApplyManager(ops, undo);
    context.subscriptions.push(undo, apply);
  }

  const statusBar = new ReviewStatusBar(reviewer, undo);
  context.subscriptions.push(statusBar);

  registerReviewCommands(context, reviewer);
  registerApplyCommands(context, reviewer, apply, undo);
  registerDemoDiffCommand(context, reviewer);
}

export function deactivate(): void {
}

export function registerDemoDiffCommand(context: vscode.ExtensionContext, reviewer?: DiffReviewer): void {
  const command = vscode.commands.registerCommand('forge.showDemoDiff', async () => {
    // 1) Require an open workspace folder.
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showInformationMessage('Forge: open the Forge workspace folder, then run "Forge: Show Demo Diff (mock)" again.');
      return;
    }

    const fixtureUri = vscode.Uri.joinPath(folder.uri, 'fixtures', 'demo-proposal.json');

    // 2) Read + parse + validate the fixture.
    let parsed: DemoFixture;
    try {
      const raw = await vscode.workspace.fs.readFile(fixtureUri);
      const text = new TextDecoder('utf-8').decode(raw);
      parsed = JSON.parse(text) as DemoFixture;
      if (!parsed || typeof parsed.originalContent !== 'string' || typeof parsed.proposedContent !== 'string') {
        throw new Error('Invalid demo fixture: originalContent/proposedContent missing');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showWarningMessage(`Forge: demo diff unavailable (${message}).`);
      return;
    }

    // 3a) With a reviewer: a real per-hunk review (adding again resets every hunk to "pending").
    if (reviewer) {
      try {
        const proposal = proposalFromFixture(parsed);
        reviewer.add(proposal);
        await reviewer.open(proposal.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showWarningMessage(`Forge: demo diff unavailable (${message}).`);
      }
      return;
    }

    // 3b) No reviewer: the plain S-01 diff of two in-memory documents (no files written).
    const originalDocument = await vscode.workspace.openTextDocument({ content: parsed.originalContent, language: 'typescript' });
    const proposedDocument = await vscode.workspace.openTextDocument({ content: parsed.proposedContent, language: 'typescript' });
    await vscode.commands.executeCommand('vscode.diff', originalDocument.uri, proposedDocument.uri, 'Forge: Demo Diff (mock)');
  });

  context.subscriptions.push(command);
}