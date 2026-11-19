/**
 * AgentPanel.ts -- the side panel (a WebviewView). It draws what PanelModel says and turns button clicks into
 * the same commands/actions the rest of the extension already uses. It never writes files itself.
 */
import * as vscode from 'vscode';
import type { AgentRequest, EngineApi, EngineEvent, ResolvedMention } from '../../types/contract';
import type { DiffReviewer } from '../../review/DiffReviewer';
import type { UndoManager } from '../../review/UndoManager';
import { parseMentions } from '../../context/mentions';
import type { EventRouter } from '../EventRouter';
import { buildPanelHtml, makeNonce } from './panelHtml';
import { parsePanelRequest, suggestMentions, type Suggestion } from './panelMessages';
import { PanelModel } from './panelModel';

export const PANEL_VIEW_ID = 'forge.agentPanel';
const POST_EVERY_MS = 80;

export interface PanelDeps {
  engine: EngineApi;
  reviewer: DiffReviewer;
  undo: UndoManager | undefined;
  /** Both optional: with no open folder there is no index. */
  resolveMention?: (raw: string) => Promise<ResolvedMention | null>;
  files?: () => Iterable<{ path: string; symbols: readonly { name: string; kind: string }[] }>;
}

export class AgentPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  readonly model = new PanelModel();
  private router: EventRouter | undefined;
  private view: vscode.WebviewView | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri, private readonly deps: PanelDeps) {
    this.subs.push(deps.reviewer.onDidChangeProposals(() => this.refresh()));
    if (deps.undo) this.subs.push(deps.undo.onDidChange(() => this.refresh()));
  }

  /** The router is built after the panel (the panel's observer is passed into it), so it is attached afterwards. */
  attachRouter(router: EventRouter): void { this.router = router; }

  /** Give this to the EventRouter as its observer. */
  readonly observe = (e: EngineEvent): void => {
    this.model.apply(e);
    if (e.type === 'run.started') this.view?.show?.(true); // show the panel but keep the cursor where it is
    this.refresh();
  };

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = makeNonce();
    view.webview.html = buildPanelHtml({
      cspSource: view.webview.cspSource, nonce,
      cssUri: view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css')).toString(),
      jsUri: view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js')).toString(),
    });
    this.subs.push(view.webview.onDidReceiveMessage((raw: unknown) => { void this.onMessage(raw); }));
    view.onDidDispose(() => { if (this.view === view) this.view = undefined; });
  }

  focusInput(): void { void this.view?.webview.postMessage({ type: 'focusInput' }); }

  /** Throttled: many tokens per second become a few screen updates per second. */
  refresh(): void {
    if (!this.view || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, POST_EVERY_MS);
  }

  private flush(): void {
    if (!this.view) return;
    void this.view.webview.postMessage({ type: 'state', state: this.model.view(this.deps.reviewer.all(), this.deps.undo?.canUndo ?? false) });
  }

  private async onMessage(raw: unknown): Promise<void> {
    const m = parsePanelRequest(raw);
    if (!m) return;
    const { reviewer } = this.deps;
    switch (m.type) {
      case 'ready': this.flush(); break;
      case 'send': await this.send(m.text); break;
      case 'stop': void this.deps.engine.cancel(); break;
      case 'applyAccepted': await vscode.commands.executeCommand('forge.applyAccepted'); break;
      case 'undo': await vscode.commands.executeCommand('forge.undoLastApply'); break;
      case 'review': await reviewer.open(m.proposalId); break;
      case 'hunk': reviewer.setHunkStatus(m.proposalId, m.hunkId, m.status); break;
      case 'all': for (const p of reviewer.all()) if (!m.proposalId || p.id === m.proposalId) reviewer.setAllStatus(p.id, m.status); break;
      case 'suggest': {
        const items: Suggestion[] = this.deps.files ? suggestMentions(this.deps.files(), m.q) : [];
        void this.view?.webview.postMessage({ type: 'suggestions', seq: m.seq, items });
        break;
      }
    }
  }

  private async send(text: string): Promise<void> {
    if (!this.router) return;
    if (this.model.isRunning) {
      this.model.addNote(this.model.isReviewing
        ? 'Forge is waiting for you to review the changes above. Press "Save accepted changes" (or Reject all), or press Stop, then ask again.'
        : 'Forge is still working. Press Stop first if you want to start something new.', 'warning');
      this.refresh();
      return;
    }
    this.model.addUser(text);
    const mentions: ResolvedMention[] = [];
    const missing: string[] = [];
    for (const pm of parseMentions(text).slice(0, 8)) {
      let r: ResolvedMention | null = null;
      try { r = (await this.deps.resolveMention?.(pm.raw)) ?? null; } catch { r = null; }
      if (r) mentions.push(r); else missing.push(pm.raw);
    }
    if (missing.length) this.model.addNote(`I could not find ${missing.join(', ')} in your project, so I left ${missing.length === 1 ? 'it' : 'them'} out.`, 'warning');
    this.model.setMentions(mentions.map((r) => ({ path: r.path, label: r.label, tokens: Math.ceil(r.content.length / 4) })));
    this.refresh();
    const req: AgentRequest = { prompt: text, mentions };
    void this.router.consume(this.deps.engine.runAgent(req)); // not awaited: the editor stays responsive
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const s of this.subs) s.dispose();
  }
}
