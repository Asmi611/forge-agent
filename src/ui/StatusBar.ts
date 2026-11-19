/** StatusBar.ts -- the main Forge item at the bottom left: idle / working (click = Stop) / retrying / reviewing. */
import * as vscode from 'vscode';
import { statusLabel, type StatusState } from './routerModel';

export class ForgeStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('forge.status', vscode.StatusBarAlignment.Left, 101);
  private state: StatusState = { kind: 'idle' };
  private model = '';

  constructor() {
    this.item.name = 'Forge';
    this.render();
    this.item.show();
  }

  set(state: StatusState): void {
    this.state = state;
    this.render();
  }

  setModel(name: string): void {
    this.model = name;
    this.render();
  }

  private render(): void {
    const l = statusLabel(this.state, this.model);
    this.item.text = l.text;
    this.item.tooltip = l.tooltip;
    this.item.command = l.command;
  }

  dispose(): void {
    this.item.dispose();
  }
}
