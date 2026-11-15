/**
 * Forge Agent extension entry point (Dev 2-owned wiring surface).
 *
 * Registers the review UI (DiffReviewer + its commands) and the
 * "Forge: Show Demo Diff (mock)" command. With a DiffReviewer the demo opens as a real
 * per-hunk review (Accept / Reject each change). Without one (the S-01 smoke test calls
 * registerDemoDiffCommand(context) with a single argument) it behaves exactly as in S-01:
 * a plain read-only vscode.diff of two in-memory documents.
 *
 * No workspace writes, no model-provider calls, no shell strings.
 */
import * as vscode from 'vscode';
import { DiffReviewer } from './review/DiffReviewer';
import { proposalFromFixture, type DemoFixture } from './review/demoProposal';
import { registerReviewCommands } from './review/reviewCommands';

export function activate(context: vscode.ExtensionContext): void {
  const reviewer = new DiffReviewer();
  context.subscriptions.push(reviewer);
  registerReviewCommands(context, reviewer);
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
