/** VscodeSink.ts -- connects the EventRouter to real VS Code UI (Output channel, status bar, toasts, review). */
import * as vscode from 'vscode';
import type { FileProposal } from '../types/contract';
import type { DiffReviewer } from '../review/DiffReviewer';
import type { RouterSink } from './EventRouter';
import type { StatusState } from './routerModel';
import type { ForgeStatusBar } from './StatusBar';

export class VscodeSink implements RouterSink {
  constructor(
    readonly output: vscode.OutputChannel,
    private readonly status: ForgeStatusBar,
    private readonly reviewer: DiffReviewer,
  ) {}

  log(line: string): void { this.output.appendLine(`\n[${new Date().toLocaleTimeString()}] ${line}`); }
  token(text: string): void { this.output.append(text); }
  setStatus(state: StatusState): void { this.status.set(state); }
  setModel(name: string): void { this.status.setModel(name); }
  toast(level: 'info' | 'warning' | 'error', text: string): void {
    const show = level === 'error' ? vscode.window.showErrorMessage : level === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    void show(`Forge: ${text.replace(/^Forge:?\s*/, '')}`);
  }
  addProposal(p: FileProposal): void { this.reviewer.add(p); }
  removeProposal(id: string): void { void this.reviewer.remove(id); }
  openReview(firstProposalId: string | undefined): void { void this.reviewer.open(firstProposalId); }
  clearReview(): void { void this.reviewer.clear(); }
}
