/** InlineEdit.ts -- "Forge: Edit Selection" (Ctrl+K). Starts a run and returns at once, so the editor never freezes. */
import * as vscode from 'vscode';
import type { EngineApi } from '../types/contract';
import { buildInlineRequest, checkTarget, type InlineInput } from './inlineCore';
import type { EventRouter } from './EventRouter';

export function registerInlineEdit(context: vscode.ExtensionContext, engine: EngineApi, router: EventRouter, output: vscode.OutputChannel): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.inlineEdit', async () => {
      const ed = vscode.window.activeTextEditor;
      const sel = ed?.selection;
      const base = {
        hasEditor: !!ed,
        scheme: ed?.document.uri.scheme ?? '',
        fsPath: ed?.document.uri.fsPath ?? '',
        workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        startLine0: sel?.start.line ?? 0, startChar: sel?.start.character ?? 0,
        endLine0: sel?.end.line ?? 0, endChar: sel?.end.character ?? 0,
        selectedText: ed && sel ? ed.document.getText(sel) : '',
      };
      const first = checkTarget(base);
      if (!first.ok) { void vscode.window.showInformationMessage(first.message); return; }

      const instruction = await vscode.window.showInputBox({
        title: `Forge: change lines ${first.startLine}-${first.endLine} of ${first.path}`,
        prompt: 'What should Forge do with the selected code? (Press Enter to start, Escape to cancel. Nothing is saved until you Apply.)',
        placeHolder: 'For example: add a docstring',
      });
      if (instruction === undefined) return; // Escape = do nothing

      const input: InlineInput = { ...base, instruction };
      const built = buildInlineRequest(input);
      if (!built.ok) { void vscode.window.showInformationMessage(built.message); return; }
      output.show(true);
      void router.consume(engine.runInline(built.request)); // not awaited
    }),
  );
}
