/** engineCommands.ts -- "Ask Forge" and "Stop". They start/stop a run and never wait for it inside the command handler. */
import * as vscode from 'vscode';
import type { EngineApi } from '../types/contract';
import type { DiffReviewer } from '../review/DiffReviewer';
import type { EventRouter } from './EventRouter';

export function registerEngineCommands(context: vscode.ExtensionContext, engine: EngineApi, router: EventRouter, output: vscode.OutputChannel, reviewer: DiffReviewer): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.askAgent', async () => {
      const prompt = await vscode.window.showInputBox({
        title: 'Ask Forge',
        prompt: 'What should Forge do? Nothing is saved until you review and press Save.',
        placeHolder: 'For example: add a decrement button',
      });
      if (!prompt?.trim()) return; // Escape = do nothing
      output.show(true);
      void router.consume(engine.runAgent({ prompt, mentions: [] })); // not awaited: the editor stays responsive
    }),
    vscode.commands.registerCommand('forge.stop', () => { void engine.cancel(); }),
    vscode.commands.registerCommand('forge.reviewOpen', () => { void reviewer.open(reviewer.current?.id); }),
  );
}
