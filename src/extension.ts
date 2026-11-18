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
import { ApplyManager, VscodeWorkspaceOps } from './review/ApplyManager';
import { registerApplyCommands } from './review/applyCommands';
import { registerReviewCommands } from './review/reviewCommands';
import { ReviewStatusBar } from './review/ReviewStatusBar';
import { UndoManager } from './review/UndoManager';
import { toReviewProposals } from './review/applyCore';
import { createMockEngine } from './mocks/createMockEngine';
import { EventRouter } from './ui/EventRouter';
import { registerEngineCommands } from './ui/engineCommands';
import { registerInlineEdit } from './ui/InlineEdit';
import { ForgeStatusBar } from './ui/StatusBar';
import { VscodeSink } from './ui/VscodeSink';
import { AgentPanel, PANEL_VIEW_ID } from './ui/AgentPanel/AgentPanel';
import type { FileProposal } from './types/contract';
import { registerContextCommands } from './context/contextCommands';
import { createWorkspaceContext } from './context/workspaceContext';

export function activate(context: vscode.ExtensionContext): void {
  const reviewer = new DiffReviewer();
  context.subscriptions.push(reviewer);
  registerReviewCommands(context, reviewer);
  registerDemoDiffCommand(context, reviewer);

  // Safe apply + undo (the only code that writes workspace files). Needs an open folder.
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  const ops = root ? new VscodeWorkspaceOps(root, context.globalStorageUri) : undefined;
  const undo = ops ? new UndoManager(ops) : undefined;
  const apply = ops && undo ? new ApplyManager(ops, undo) : undefined;
  if (undo) context.subscriptions.push(undo);
  if (apply) context.subscriptions.push(apply);
  registerApplyCommands(context, reviewer, apply, undo);
  context.subscriptions.push(new ReviewStatusBar(reviewer, undo));

  // Context finder: indexes the open folder in the background (never blocks the editor).
  const contextOutput = vscode.window.createOutputChannel('Forge Context');
  const workspaceContext = root ? createWorkspaceContext(root, contextOutput) : undefined;
  context.subscriptions.push(contextOutput);
  if (workspaceContext) context.subscriptions.push(workspaceContext);
  registerContextCommands(context, workspaceContext, contextOutput);

  // Engine -> screen. The real engine is not built yet, so a contract-correct MOCK engine runs for now.
  const output = vscode.window.createOutputChannel('Forge');
  const status = new ForgeStatusBar();
  context.subscriptions.push(output, status);
  const engine = createMockEngine({ getProposal: loadDemoProposal });
  const panel = new AgentPanel(context.extensionUri, {
    engine, reviewer, undo,
    resolveMention: workspaceContext ? (raw) => workspaceContext.provider.resolveMention(raw) : undefined,
    files: workspaceContext ? () => workspaceContext.index.files.values() : undefined,
  });
  context.subscriptions.push(panel, vscode.window.registerWebviewViewProvider(PANEL_VIEW_ID, panel, { webviewOptions: { retainContextWhenHidden: true } }));
  const router = new EventRouter(new VscodeSink(output, status, reviewer), panel.observe);
  panel.attachRouter(router);
  context.subscriptions.push(vscode.commands.registerCommand('forge.showPanel', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.forge');
    panel.focusInput();
  }));
  registerEngineCommands(context, engine, router, output, reviewer);
  registerInlineEdit(context, engine, router, output);

  // When the user finishes reviewing (applied, or everything rejected) the paused run must continue.
  if (apply) {
    context.subscriptions.push(apply.onDidApply((outcome) => {
      const batchId = router.takeBatch();
      if (batchId) void engine.reviewDone({ batchId, proposals: toReviewProposals(outcome), applyId: outcome.applyId });
    }));
  }
}

/** The demo proposal for the mock engine (read from fixtures/demo-proposal.json in the open folder). */
async function loadDemoProposal(): Promise<FileProposal | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  try {
    const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'fixtures', 'demo-proposal.json'));
    return proposalFromFixture(JSON.parse(new TextDecoder('utf-8').decode(raw)) as DemoFixture);
  } catch {
    return undefined;
  }
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
