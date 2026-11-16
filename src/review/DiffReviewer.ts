/**
 * DiffReviewer.ts -- shows a FileProposal as a side-by-side diff and lets the user
 * accept or reject each hunk. It NEVER writes files: it only keeps the decisions in memory.
 * (ApplyManager, a later card, is the only thing that writes.)
 *
 * How it works:
 *  - Two virtual documents (nothing on disk): scheme "forge-original" shows the original
 *    text; scheme "forge-proposed" shows buildText(proposal, 'preview'), which is the
 *    original with every hunk applied except the rejected ones.
 *  - CodeLens does not render inside a diff editor (see docs/spike-codelens.md), so each
 *    hunk gets a comment thread (Comments API) with Accept / Reject buttons instead.
 *  - Changing a hunk's status refreshes the proposed text and moves the threads.
 */
import * as vscode from 'vscode';
import type { FileProposal, HunkStatus } from '../types/contract';
import { buildText } from './hunkText';
import { sortForReview } from './proposalOrder';

export const ORIGINAL_SCHEME = 'forge-original';
export const PROPOSED_SCHEME = 'forge-proposed';
export const CONTROLLER_ID = 'forge-review';
const HUNK_PREFIX = 'forge-hunk:';

/** Text shown inside one hunk's comment box. */
class HunkComment implements vscode.Comment {
  readonly mode = vscode.CommentMode.Preview;
  readonly author: vscode.CommentAuthorInformation = { name: 'Forge' };
  constructor(
    readonly body: string,
    readonly label: string,
    readonly contextValue: string,
  ) {}
}

/** Reads "proposalId + hunkId" back out of a comment (or a thread) clicked in the UI. */
export function hunkRefFrom(arg: unknown): { proposalId: string; hunkId: string } | undefined {
  const asThread = arg as { comments?: readonly { contextValue?: string }[] } | undefined;
  const asComment = arg as { contextValue?: string } | undefined;
  const value = asComment?.contextValue ?? asThread?.comments?.[0]?.contextValue;
  if (typeof value !== 'string' || !value.startsWith(HUNK_PREFIX)) return undefined;
  const [proposalId, hunkId] = value.slice(HUNK_PREFIX.length).split(':');
  return proposalId && hunkId ? { proposalId: decodeURIComponent(proposalId), hunkId } : undefined;
}

export class DiffReviewer implements vscode.Disposable, vscode.TextDocumentContentProvider {
  private readonly proposals = new Map<string, FileProposal>();
  private readonly threads = new Map<string, Map<string, vscode.CommentThread>>();
  private order: string[] = [];
  private currentId: string | undefined;

  private readonly controller: vscode.CommentController;
  private readonly contentChanged = new vscode.EventEmitter<vscode.Uri>();
  private readonly proposalsChanged = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[];

  /** Required by TextDocumentContentProvider: tells VS Code a virtual document changed. */
  readonly onDidChange = this.contentChanged.event;
  /** For the agent panel: fires whenever a proposal is added, removed or a hunk changes. */
  readonly onDidChangeProposals = this.proposalsChanged.event;

  constructor() {
    this.controller = vscode.comments.createCommentController(CONTROLLER_ID, 'Forge review');
    this.disposables = [
      this.controller,
      this.contentChanged,
      this.proposalsChanged,
      vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, this),
      vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this),
    ];
  }

  // ───────── content provider ─────────
  provideTextDocumentContent(uri: vscode.Uri): string {
    const p = this.proposals.get(uri.query);
    if (!p) return '';
    if (uri.scheme === ORIGINAL_SCHEME) return p.originalContent;
    return this.preview(p)?.text ?? p.originalContent;
  }

  // ───────── proposals ─────────
  /** Add (or replace) a proposal. Copies it, so the engine's object is never changed. */
  add(proposal: FileProposal): void {
    this.dropThreads(proposal.id);
    const copy: FileProposal = { ...proposal, hunks: proposal.hunks.map((h) => ({ ...h })) };
    this.proposals.set(copy.id, copy);
    this.order = sortForReview([...this.proposals.values()]).map((p) => p.id);
    this.createThreads(copy);
    this.contentChanged.fire(this.uri(PROPOSED_SCHEME, copy));
    this.proposalsChanged.fire();
  }

  /** Removes a proposal, its comment boxes and its diff tab. Resolves once the tab is closed. */
  async remove(proposalId: string): Promise<void> {
    if (!this.proposals.has(proposalId)) return;
    this.dropThreads(proposalId);
    this.proposals.delete(proposalId);
    this.order = this.order.filter((id) => id !== proposalId);
    if (this.currentId === proposalId) this.currentId = undefined;
    this.proposalsChanged.fire();
    await this.closeTabs(proposalId);
  }

  async clear(): Promise<void> {
    for (const id of [...this.proposals.keys()]) await this.remove(id);
  }

  get(proposalId: string): FileProposal | undefined {
    return this.proposals.get(proposalId);
  }

  /** In review order: source files, then tests, then docs. */
  all(): FileProposal[] {
    return this.order.flatMap((id) => {
      const p = this.proposals.get(id);
      return p ? [p] : [];
    });
  }

  /** hunkId -> status, in the shape reviewDone() expects. */
  decisions(proposalId: string): Record<string, HunkStatus> {
    const out: Record<string, HunkStatus> = {};
    for (const h of this.proposals.get(proposalId)?.hunks ?? []) out[h.id] = h.status;
    return out;
  }

  /** The proposal the user is looking at (last opened). */
  get current(): FileProposal | undefined {
    return this.currentId === undefined ? undefined : this.proposals.get(this.currentId);
  }

  async open(proposalId?: string): Promise<void> {
    const p = this.proposals.get(proposalId ?? this.order[0] ?? '');
    if (!p) return;
    this.currentId = p.id;
    await vscode.commands.executeCommand(
      'vscode.diff',
      this.uri(ORIGINAL_SCHEME, p),
      this.uri(PROPOSED_SCHEME, p),
      `Forge: ${p.path} (${p.hunks.length} ${p.hunks.length === 1 ? 'change' : 'changes'})`,
    );
  }

  // ───────── decisions ─────────
  setHunkStatus(proposalId: string, hunkId: string, status: HunkStatus): boolean {
    const p = this.proposals.get(proposalId);
    const h = p?.hunks.find((x) => x.id === hunkId);
    if (!p || !h) return false;
    h.status = status;
    this.refresh(p);
    return true;
  }

  setAllStatus(proposalId: string, status: HunkStatus): boolean {
    const p = this.proposals.get(proposalId);
    if (!p) return false;
    for (const h of p.hunks) h.status = status;
    this.refresh(p);
    return true;
  }

  /** Which hunk is the cursor on? (the last hunk that starts at or above this 0-based line) */
  hunkAtLine(proposalId: string, line: number): string | undefined {
    const p = this.proposals.get(proposalId);
    const built = p ? this.preview(p) : undefined;
    if (!p || !built) return undefined;
    let best: string | undefined;
    let bestLine = -1;
    for (const h of p.hunks) {
      const start = built.hunkLine[h.id] ?? 0;
      if (start <= line && start >= bestLine) { best = h.id; bestLine = start; }
    }
    return best ?? p.hunks[0]?.id;
  }

  dispose(): void {
    for (const id of [...this.threads.keys()]) this.dropThreads(id);
    for (const d of this.disposables) d.dispose();
  }

  // ───────── internals ─────────
  private uri(scheme: string, p: FileProposal): vscode.Uri {
    return vscode.Uri.from({ scheme, path: `/${p.path}`, query: p.id });
  }

  private preview(p: FileProposal): ReturnType<typeof buildText> | undefined {
    try {
      return buildText(p, 'preview');
    } catch {
      return undefined; // broken hunks: show the original instead of wrong text
    }
  }

  private commentFor(p: FileProposal, hunkIndex: number): HunkComment {
    const h = p.hunks[hunkIndex];
    if (!h) throw new RangeError('no such hunk');
    const plural = (n: number): string => `${n} line${n === 1 ? '' : 's'}`;
    const what = h.oldLines === 0 ? `Adds ${plural(h.newLines)}` : h.newLines === 0 ? `Removes ${plural(h.oldLines)}` : `Replaces ${plural(h.oldLines)} with ${h.newLines}`;
    const label = h.status === 'accepted' ? '✓ Accepted: saved when you Apply' : h.status === 'rejected' ? '✗ Rejected: will not be saved' : 'Undecided';
    return new HunkComment(`Change ${hunkIndex + 1} of ${p.hunks.length}: ${what}.`, label, `${HUNK_PREFIX}${encodeURIComponent(p.id)}:${h.id}`);
  }

  private rangeFor(line: number): vscode.Range {
    return new vscode.Range(line, 0, line, 0);
  }

  private createThreads(p: FileProposal): void {
    const built = this.preview(p);
    const map = new Map<string, vscode.CommentThread>();
    p.hunks.forEach((h, i) => {
      const thread = this.controller.createCommentThread(this.uri(PROPOSED_SCHEME, p), this.rangeFor(built?.hunkLine[h.id] ?? 0), [this.commentFor(p, i)]);
      thread.canReply = false;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      map.set(h.id, thread);
    });
    this.threads.set(p.id, map);
  }

  private dropThreads(proposalId: string): void {
    for (const t of this.threads.get(proposalId)?.values() ?? []) t.dispose();
    this.threads.delete(proposalId);
  }

  /** After a decision: redraw the right side and move each comment box to its hunk's new line. */
  private refresh(p: FileProposal): void {
    this.contentChanged.fire(this.uri(PROPOSED_SCHEME, p));
    const built = this.preview(p);
    p.hunks.forEach((h, i) => {
      const thread = this.threads.get(p.id)?.get(h.id);
      if (!thread) return;
      thread.range = this.rangeFor(built?.hunkLine[h.id] ?? 0);
      thread.comments = [this.commentFor(p, i)];
    });
    this.proposalsChanged.fire();
  }

  private async closeTabs(proposalId: string): Promise<void> {
    const tabs: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputTextDiff && input.modified.scheme === PROPOSED_SCHEME && input.modified.query === proposalId) tabs.push(tab);
      }
    }
    if (tabs.length > 0) await vscode.window.tabGroups.close(tabs);
  }
}
