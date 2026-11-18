/**
 * panelModel.ts -- everything the agent panel SHOWS, as plain data. No VS Code here, so it is unit tested.
 * Engine events go in (apply), a snapshot for the screen comes out (view). The webview only draws this data.
 */
import type { ContextItem, EngineEvent, FileProposal, Hunk, HunkStatus } from '../../types/contract';
import { friendlyError } from '../friendlyErrors';

export const MAX_ROWS = 500;
export const MAX_MESSAGES = 100;
const MAX_TEXT = 20000;
const MAX_RETRIES = 3;

export interface Msg { id: string; role: 'user' | 'agent' | 'note'; tone?: 'info' | 'warning' | 'error'; text: string }
export interface Row { id: string; kind: 'tool' | 'subagent' | 'note'; label: string; detail: string; result: string; state: 'running' | 'ok' | 'failed' | 'info'; helper: boolean }
export interface FileRow { path: string; reason: string; tokens: number; source: 'mention' | 'auto' | 'agent-tool'; badge: string; range?: string }
export interface BudgetView { used: number; limit: number; percent: number; level: 'ok' | 'high' | 'full'; breakdown: { label: string; tokens: number }[] }
export interface HunkView { id: string; label: string; status: HunkStatus }
export interface ProposalView { id: string; path: string; isNewFile: boolean; rationale: string; accepted: number; rejected: number; pending: number; hunks: HunkView[] }
export interface PanelView {
  running: boolean; reviewing: boolean; model: string; statusText: string;
  messages: Msg[]; rows: Row[]; files: FileRow[]; budget: BudgetView | undefined;
  proposals: ProposalView[]; canUndo: boolean; hiddenRows: number;
}

const BADGES: Record<FileRow['source'], string> = { mention: 'You chose', auto: 'Found by Forge', 'agent-tool': 'Opened by the agent' };

const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Plain-language name of a tool call + the one detail worth showing. */
export function describeTool(tool: string, args: unknown): { label: string; detail: string } {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const first = str(a.path) || str(a.query) || str(a.name) || str(a.dir) || (str(a.file) ? [str(a.file), ...(Array.isArray(a.args) ? a.args.map(String) : [])].join(' ') : '');
  const labels: Record<string, string> = {
    repoMap: 'Looking at the project layout', searchWorkspace: 'Searching the project', findSymbol: 'Finding a function or class',
    readFile: 'Reading a file', reportContext: 'Noting which files matter', proposeEdit: 'Preparing a change', createFile: 'Preparing a new file', runCommand: 'Running a check',
  };
  return { label: labels[tool] ?? `Working (${tool})`, detail: short(first, 70) };
}

export function describeHunk(h: Hunk, index: number, total: number): string {
  const n = (c: number): string => `${c} line${c === 1 ? '' : 's'}`;
  const what = h.oldLines === 0 ? `adds ${n(h.newLines)}` : h.newLines === 0 ? `removes ${n(h.oldLines)}` : `replaces ${n(h.oldLines)} with ${h.newLines}`;
  return `Change ${index + 1} of ${total}: ${what}`;
}

export function proposalViews(proposals: readonly FileProposal[]): ProposalView[] {
  return proposals.map((p) => {
    const c = { accepted: 0, rejected: 0, pending: 0 };
    for (const h of p.hunks) c[h.status === 'accepted' ? 'accepted' : h.status === 'rejected' ? 'rejected' : 'pending']++;
    return { id: p.id, path: p.path, isNewFile: p.isNewFile, rationale: short(p.rationale ?? '', 240), ...c, hunks: p.hunks.map((h, i) => ({ id: h.id, label: describeHunk(h, i, p.hunks.length), status: h.status })) };
  });
}

export class PanelModel {
  private running = false;
  private reviewing = false;
  private model = '';
  private messages: Msg[] = [];
  private rows: Row[] = [];
  private hidden = 0;
  private byCall = new Map<string, Row>();
  private mentions: FileRow[] = [];
  private reported: FileRow[] = [];
  private budget: { used: number; limit: number } | undefined;
  private openAgentMsg: Msg | undefined;
  private seq = 0;
  private retried = false;

  get isRunning(): boolean { return this.running; }

  private id(prefix: string): string { return `${prefix}${++this.seq}`; }

  private pushMsg(role: Msg['role'], text: string, tone?: Msg['tone']): Msg {
    const m: Msg = { id: this.id('m'), role, text, ...(tone ? { tone } : {}) };
    this.messages.push(m);
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    return m;
  }

  private pushRow(r: Omit<Row, 'id'>): Row {
    const row: Row = { id: this.id('r'), ...r };
    this.rows.push(row);
    if (this.rows.length > MAX_ROWS) { const drop = this.rows.length - MAX_ROWS; this.rows.splice(0, drop); this.hidden += drop; }
    return row;
  }

  /** The user pressed Send. */
  addUser(text: string): void { this.openAgentMsg = undefined; this.pushMsg('user', short(text, MAX_TEXT)); }
  addNote(text: string, tone: Msg['tone'] = 'info'): void { this.openAgentMsg = undefined; this.pushMsg('note', text, tone); }

  setMentions(items: { path: string; label: string; tokens: number }[]): void {
    this.mentions = items.map((i) => ({ path: i.path, reason: `you mentioned ${i.label}`, tokens: i.tokens, source: 'mention' as const, badge: BADGES.mention }));
  }

  apply(e: EngineEvent): void {
    switch (e.type) {
      case 'run.started':
        this.running = true; this.reviewing = false; this.model = e.model;
        this.rows = []; this.hidden = 0; this.byCall.clear(); this.reported = []; this.budget = undefined; this.openAgentMsg = undefined; this.retried = false;
        if (e.mode === 'inline') this.mentions = [];
        break;
      case 'token': {
        if (!this.openAgentMsg) this.openAgentMsg = this.pushMsg('agent', '');
        this.openAgentMsg.text = short(this.openAgentMsg.text + e.text, MAX_TEXT);
        break;
      }
      case 'tool.call': {
        this.openAgentMsg = undefined;
        const d = describeTool(e.tool, e.args);
        const row = this.pushRow({ kind: 'tool', label: d.label, detail: d.detail, result: '', state: 'running', helper: e.thread !== 'main' });
        this.byCall.set(e.callId, row);
        break;
      }
      case 'tool.result': {
        const row = this.byCall.get(e.callId);
        if (row) { row.state = e.ok ? 'ok' : 'failed'; row.result = short(e.summary, 120); this.byCall.delete(e.callId); }
        break;
      }
      case 'context.report':
        this.reported = e.items.map((i: ContextItem) => ({ path: i.path, reason: i.reason, tokens: i.tokens, source: i.source, badge: BADGES[i.source], ...(i.range ? { range: `lines ${i.range.startLine}-${i.range.endLine}` } : {}) }));
        break;
      case 'subagent':
        this.pushRow({ kind: 'subagent', label: e.state === 'started' ? `Helper started${e.label ? `: ${e.label}` : ''}` : `Helper finished${e.label ? `: ${e.label}` : ''}`, detail: '', result: '', state: e.state === 'started' ? 'running' : 'ok', helper: true });
        break;
      case 'budget': this.budget = { used: e.usedTokens, limit: e.limitTokens }; break;
      case 'command.requested': this.pushRow({ kind: 'note', label: 'Asked to run a check', detail: short(e.display, 70), result: '', state: 'info', helper: false }); break;
      case 'proposal.created': this.settleRunning(); this.pushRow({ kind: 'note', label: 'A change is ready for you to review', detail: e.proposal.path, result: '', state: 'ok', helper: false }); break;
      case 'review.required': this.reviewing = true; this.settleRunning(); break;
      case 'proposal.discarded': this.pushRow({ kind: 'note', label: 'A proposed change was dropped', detail: '', result: e.reason === 'cancelled' ? 'because you stopped Forge' : '', state: 'info', helper: false }); break;
      case 'retry': this.retried = true; this.pushRow({ kind: 'note', label: `The AI had a problem. Trying again (${e.attempt} of ${MAX_RETRIES})`, detail: '', result: '', state: 'info', helper: false }); break;
      case 'failover':
        this.model = e.to;
        this.pushRow({ kind: 'note', label: 'Switched to the backup AI model', detail: e.to, result: '', state: 'info', helper: false });
        this.addNote(`The main model had a problem, so Forge switched to the backup model (${e.to}) and is carrying on.`, 'warning');
        break;
      case 'run.completed': this.finish(); if (e.summary) this.addNote(`Done: ${e.summary}`); break;
      case 'run.cancelled': this.finish(); this.addNote('Stopped. Nothing was changed.'); break;
      case 'run.failed': this.finish(); this.addNote(friendlyError(e.error), 'error'); break;
      default: break;
    }
  }

  /** Forge is now waiting for the PERSON, so no step may keep spinning. */
  private settleRunning(): void {
    for (const r of this.rows) if (r.state === 'running' && r.kind === 'tool') r.state = 'ok';
    this.byCall.clear();
  }

  get isReviewing(): boolean { return this.reviewing; }

  private finish(): void {
    this.running = false; this.reviewing = false; this.openAgentMsg = undefined;
    for (const row of this.byCall.values()) row.state = 'info'; // a call that never got an answer is not "still spinning"
    this.byCall.clear();
    for (const r of this.rows) if (r.state === 'running') r.state = 'info';
  }

  private budgetView(files: FileRow[]): BudgetView | undefined {
    if (!this.budget) return undefined;
    const { used, limit } = this.budget;
    const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    const sum = (src: FileRow['source']): number => files.filter((f) => f.source === src).reduce((a, f) => a + f.tokens, 0);
    const parts = [
      { label: 'Files you mentioned', tokens: sum('mention') },
      { label: 'Files Forge found', tokens: sum('auto') },
      { label: 'Files the agent opened', tokens: sum('agent-tool') },
    ];
    const known = parts.reduce((a, p) => a + p.tokens, 0);
    parts.push({ label: 'Conversation and results', tokens: Math.max(0, used - known) });
    return { used, limit, percent, level: percent >= 100 ? 'full' : percent >= 80 ? 'high' : 'ok', breakdown: parts.filter((p) => p.tokens > 0) };
  }

  view(proposals: readonly FileProposal[], canUndo: boolean): PanelView {
    const seen = new Set(this.reported.map((f) => f.path));
    const files = [...this.mentions.filter((m) => !seen.has(m.path)), ...this.reported];
    const pv = proposalViews(proposals);
    const statusText = this.reviewing || (this.running && pv.length > 0) ? 'Waiting for your review' : this.running ? (this.retried ? 'Working (retrying)…' : 'Working…') : this.reviewing || pv.length > 0 ? 'Waiting for your review' : 'Ready';
    return {
      running: this.running, reviewing: this.reviewing, model: this.model, statusText,
      messages: this.messages.map((m) => ({ ...m })), rows: this.rows.map((r) => ({ ...r })), files, budget: this.budgetView(files),
      proposals: pv, canUndo, hiddenRows: this.hidden,
    };
  }
}
