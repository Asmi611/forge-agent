/**
 * reviewCommands.ts -- the commands behind the Accept / Reject buttons.
 * They only change decisions in DiffReviewer; they never write files.
 *
 * forge.acceptHunk / forge.rejectHunk   called by the buttons on a comment box (or with
 *                                       (proposalId, hunkId) by other code, e.g. the panel)
 * forge.*HunkAtCursor                   palette / keyboard: the hunk under the cursor
 * forge.acceptAllHunks / rejectAllHunks the whole diff you are looking at
 */
import * as vscode from 'vscode';
import type { HunkStatus } from '../types/contract';
import { DiffReviewer, ORIGINAL_SCHEME, PROPOSED_SCHEME, hunkRefFrom } from './DiffReviewer';

function proposalIdOfActiveEditor(reviewer: DiffReviewer): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (uri && (uri.scheme === PROPOSED_SCHEME || uri.scheme === ORIGINAL_SCHEME) && reviewer.get(uri.query)) return uri.query;
  return reviewer.current?.id;
}

export function registerReviewCommands(context: vscode.ExtensionContext, reviewer: DiffReviewer): void {
  const nothing = (): void => {
    void vscode.window.showInformationMessage('Forge: open a Forge diff and put the cursor on a change first.');
  };

  const decideOne = (first: unknown, second: unknown, status: HunkStatus): void => {
    const ref = typeof first === 'string' && typeof second === 'string' ? { proposalId: first, hunkId: second } : hunkRefFrom(first);
    if (!ref || !reviewer.setHunkStatus(ref.proposalId, ref.hunkId, status)) nothing();
  };

  const decideAtCursor = (status: HunkStatus): void => {
    const id = proposalIdOfActiveEditor(reviewer);
    const line = vscode.window.activeTextEditor?.selection.active.line ?? 0;
    const hunkId = id === undefined ? undefined : reviewer.hunkAtLine(id, line);
    if (id === undefined || hunkId === undefined) return nothing();
    reviewer.setHunkStatus(id, hunkId, status);
  };

  const decideAll = (status: HunkStatus): void => {
    const id = proposalIdOfActiveEditor(reviewer);
    if (id === undefined || !reviewer.setAllStatus(id, status)) nothing();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('forge.acceptHunk', (a?: unknown, b?: unknown) => decideOne(a, b, 'accepted')),
    vscode.commands.registerCommand('forge.rejectHunk', (a?: unknown, b?: unknown) => decideOne(a, b, 'rejected')),
    vscode.commands.registerCommand('forge.acceptHunkAtCursor', () => decideAtCursor('accepted')),
    vscode.commands.registerCommand('forge.rejectHunkAtCursor', () => decideAtCursor('rejected')),
    vscode.commands.registerCommand('forge.acceptAllHunks', () => decideAll('accepted')),
    vscode.commands.registerCommand('forge.rejectAllHunks', () => decideAll('rejected')),
  );
}
