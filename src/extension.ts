/**
 * Forge Agent extension entry point (Dev 2-owned wiring surface).
 *
 * S-01 bootstrap: registers the "Forge: Show Demo Diff (mock)" command.
 * Real agent/UI features are Dev-2 work and are NOT implemented here.
 *
 * No workspace writes, no model-provider calls, no shell strings.
 */

import * as vscode from 'vscode';

/**
 * Forge: Show Demo Diff (mock)
 *
 * Opens a genuine VS Code diff of two in-memory text documents for the
 * demo fixture. No temporary files, no workspace writes.
 *
 * Workflow:
 *  1. Require an open workspace folder.
 *  2. Resolve fixtures/demo-proposal.json relative to the workspace URI.
 *  3. Read + validate the fixture (originalContent / proposedContent).
 *  4. Open two in-memory TextDocuments via vscode.workspace.openTextDocument.
 *  5. Show the original, then vscode.diff(originalUri, modifiedUri, title).
 */
export function activate(context: vscode.ExtensionContext): void {
  registerDemoDiffCommand(context);
}

export function deactivate(): void {
}

export function registerDemoDiffCommand(context: vscode.ExtensionContext): void {
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
      // 3) Graceful failure for missing folder (handled above), missing file,
      //    malformed JSON, or a missing field.
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showWarningMessage(`Forge: demo diff unavailable (${message}).`);
      return;
    }

    // 4) Open two in-memory text documents (no temp files written).
    const originalDocument = await openTextDocumentWithContent(parsed.originalContent, 'typescript');
    const proposedDocument = await openTextDocumentWithContent(parsed.proposedContent, 'typescript');

    // 5) Open the in-editor diff. vscode.diff opens both documents and
    //    does not require either to be shown first, so no separate
    //    showTextDocument call is needed here. Await so execution is
    //    synchronous with the async command registration and we surface
    //    any command execution failure instead of silently ignoring it.
    await vscode.commands.executeCommand('vscode.diff', originalDocument.uri, proposedDocument.uri, 'Forge: Demo Diff (mock)');
  });

  context.subscriptions.push(command);
}

/**
 * Open an in-memory text document with the given content and language.
 * Uses the single options overload, so no disk URI or file is involved.
 */
function openTextDocumentWithContent(content: string, language: string): Thenable<vscode.TextDocument> {
  return vscode.workspace.openTextDocument({ content, language });
}

/**
 * Shape of the demo fixture. Mirrors the FileProposal contract fields.
 */
interface DemoFixture {
  originalContent: string;
  proposedContent: string;
  hunks: { oldText: string; newText: string }[];
}
