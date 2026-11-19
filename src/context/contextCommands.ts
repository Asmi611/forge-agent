/**
 * contextCommands.ts -- "Forge: Show Context Ranking": type what you want done and see, in plain words,
 * which files Forge would pick, why, and how much of the size budget they use.
 * It only reads. Use it to check the context finder on a real folder.
 */
import * as vscode from 'vscode';
import type { ContextProviderImpl } from './ContextProviderImpl';
import { readProviderConfig, type WorkspaceContext } from './workspaceContext';

const SAMPLE = 'add a config command to the command line tool that prints the app configuration as JSON and hides secret values, with tests and docs';

/** Register the "Show Context Ranking" command (works on the open folder). */
export function registerContextCommands(context: vscode.ExtensionContext, ctx: WorkspaceContext | undefined, out: vscode.OutputChannel): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.showContextRanking', async () => {
      if (!ctx) {
        void vscode.window.showInformationMessage('Forge: open a folder first (File > Open Folder), then try again.');
        return;
      }
      const prompt = await vscode.window.showInputBox({
        title: 'Which files would Forge pick?',
        prompt: 'Describe what you want done. You do not need to mention any file names.',
        value: SAMPLE,
      });
      if (prompt === undefined || prompt.trim() === '') return; // Escape = do nothing
      out.show(true);
      out.clear();
      await report(out, ctx, prompt);
    }),
  );
}

async function report(out: vscode.OutputChannel, ctx: WorkspaceContext, prompt: string): Promise<void> {
  const provider: ContextProviderImpl = ctx.provider;
  const budget = readProviderConfig().seedBudgetTokens;
  out.appendLine(`Request: ${prompt}`);
  out.appendLine('Looking through the project...');
  await ctx.ready();
  out.appendLine(`Project: ${ctx.index.files.size} files indexed (last build ${ctx.index.lastBuildMs} ms, ${ctx.index.lastReadCount} files read, the rest came from the cache).`);

  let t = Date.now();
  const ranked = await provider.rankFiles(prompt);
  out.appendLine(`\nBest matches (found in ${Date.now() - t} ms). A higher score means a better match:`);
  if (ranked.length === 0) out.appendLine('  Nothing matched. Try describing the feature or the problem in other words.');
  ranked.forEach((r, i) => out.appendLine(`  ${i + 1}. ${r.path}   (score ${r.score.toFixed(1)})\n       why: ${r.reason}`));

  t = Date.now();
  const seed = await provider.seed(prompt, budget);
  const used = seed.reduce((sum, i) => sum + i.tokens, 0);
  out.appendLine(`\nWhat Forge would show the AI before it starts (found in ${Date.now() - t} ms). Size used: ${used} of ${budget} (budget):`);
  for (const i of seed) {
    const where = i.range ? ` lines ${i.range.startLine}-${i.range.endLine}` : '';
    out.appendLine(`  - ${i.path}${where}   (${i.tokens} size)\n       why: ${i.reason}`);
  }
  out.appendLine('\n(Size is estimated as characters / 4. You can change the weights and the budget in Settings: search "forge.context".)');
}
