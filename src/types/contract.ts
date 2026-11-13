/**
 * src/types/contract.ts  --  CONTRACT v2 (DRAFT-1)
 * Frozen at Gate G1 (after the TrueForge spike). Afterwards: joint PR only.
 *
 * Rules of the stream (engine promises, UI relies on them):
 *  - Run generators NEVER throw. Failures become `run.failed`.
 *  - Every run ends with exactly ONE of: run.completed | run.cancelled | run.failed.
 *  - A run may span several TrueForge turns (pause for approval -> new turn). The UI never sees turns.
 *  - `review.required` is NOT terminal: the run is paused until UI calls reviewDone() or cancel().
 *  - The engine NEVER writes workspace files. Only the UI's ApplyManager/UndoManager write.
 *  - Lines are 1-based. proposedContent = originalContent with ALL hunks applied.
 */

export const CONTRACT_VERSION = '2.1.0-draft2';

// ───────────── errors ─────────────
export type ErrorKind =
  | 'unreachable' | 'auth' | 'rate_limit' | 'model' | 'timeout'
  | 'busy' | 'policy' | 'stale' | 'budget' | 'stuck' | 'unknown';

export interface ForgeError { kind: ErrorKind; message: string; retryable: boolean; }

// ───────────── tools exposed over MCP ─────────────
export type ToolName =
  | 'repoMap' | 'searchWorkspace' | 'findSymbol' | 'readFile'
  | 'reportContext' | 'proposeEdit' | 'createFile' | 'runCommand';

export interface LineRange { startLine: number; endLine: number; }

export interface ToolArgs {
  repoMap: { dir?: string; depth?: number };
  searchWorkspace: { query: string; glob?: string; maxResults?: number };
  findSymbol: { name: string };
  readFile: { path: string; range?: LineRange };
  reportContext: { items: { path: string; reason: string }[] };
  /** Search/replace edits against the CURRENT file. Each oldText must match exactly once. */
  proposeEdit: { path: string; edits: { oldText: string; newText: string }[]; rationale: string };
  createFile: { path: string; content: string; rationale: string };
  /** argv-level. No shell. Policy enforced by engine (terminalPolicy.ts) AND host (execFile). */
  runCommand: { file: string; args: string[]; cwd?: string };
}

// ───────────── context ─────────────
export interface ContextItem {
  path: string;
  reason: string;
  tokens: number;
  source: 'mention' | 'auto' | 'agent-tool';
  range?: LineRange;
}

export interface ResolvedMention { kind: 'file' | 'symbol'; label: string; path: string; content: string; }

// ───────────── proposals / review ─────────────
export type HunkStatus = 'pending' | 'accepted' | 'rejected';

export interface Hunk {
  id: string;            // 'h1','h2',...
  oldStart: number;      // 1-based; for pure insertion oldLines=0 and new lines go BEFORE oldStart
  oldLines: number;
  newStart: number;      // computed by engine: oldStart + running delta
  newLines: number;
  oldText: string;
  newText: string;
  status: HunkStatus;
}

/** What the document looked like when the proposal was made. Used for stale detection. */
export interface BaseSnapshot { contentHash: string; /* sha256 of text */ version: number | null; wasDirty: boolean; }

export interface FileProposal {
  id: string;
  callId: string;        // representative TrueForge tool_call_id (always callIds[0])
  callIds: string[];     // ALL tool_call_ids answered by this ONE proposal: identical calls in one batch are grouped (docs/01 §4.1), each id gets the same decision
  path: string;          // workspace-relative, forward slashes
  isNewFile: boolean;
  base: BaseSnapshot;
  originalContent: string;
  proposedContent: string;
  hunks: Hunk[];
  rationale: string;
  createdAt: number;
}

export interface DocSnapshot {
  path: string; exists: boolean; text: string;
  version: number | null; isDirty: boolean; contentHash: string;
}

/** UI -> engine, one call per `review.required` batch. */
export interface ReviewResult {
  batchId: string;
  proposals: {
    proposalId: string;
    decisions: Record<string, HunkStatus>;  // hunkId -> accepted|rejected (pending counts as rejected)
    applied: boolean;                       // true only if disk/doc now contains the accepted hunks
    failure?: { kind: 'stale' | 'apply_failed' | 'restore_failed'; message: string; recoveryPath?: string };
  }[];
  applyId?: string;
}

// ───────────── events engine -> UI ─────────────
export type EngineEvent =
  | { type: 'run.started'; runId: string; mode: 'inline' | 'agent'; model: string }
  | { type: 'token'; text: string }
  | { type: 'tool.call'; callId: string; tool: string; args: unknown; thread: string }
  | { type: 'tool.result'; callId: string; ok: boolean; summary: string }
  | { type: 'context.report'; items: ContextItem[] }
  | { type: 'subagent'; threadId: string; state: 'started' | 'done'; label?: string }
  | { type: 'budget'; usedTokens: number; limitTokens: number }
  | { type: 'proposal.created'; proposal: FileProposal }
  | { type: 'review.required'; batchId: string; proposalIds: string[] }
  | { type: 'proposal.discarded'; proposalId: string; reason: 'cancelled' | 'failover' | 'error' | 'stale' | 'superseded' }
  | { type: 'retry'; attempt: number; delayMs: number; kind: ErrorKind }
  | { type: 'failover'; from: string; to: string; reason: ErrorKind }
  | { type: 'command.requested'; display: string }
  | { type: 'run.completed'; summary?: string }
  | { type: 'run.cancelled' }
  | { type: 'run.failed'; error: ForgeError };

export type TerminalEvent = Extract<EngineEvent, { type: 'run.completed' | 'run.cancelled' | 'run.failed' }>;

// ───────────── UI -> engine ─────────────
export interface InlineRequest {
  prompt: string; path: string; selectedText: string; range: LineRange;
}
export interface AgentRequest { prompt: string; mentions: ResolvedMention[]; }

export interface EngineApi {
  runInline(req: InlineRequest): AsyncIterable<EngineEvent>;
  runAgent(req: AgentRequest): AsyncIterable<EngineEvent>;
  /** Idempotent, returns fast. Discards unreviewed proposals. */
  cancel(): Promise<void>;
  reviewDone(result: ReviewResult): Promise<void>;
  switchModel(profile: string): Promise<void>;
  activeModel(): string;
}

// ───────────── engine -> UI (editor capabilities) ─────────────
export interface CommandRequest {
  file: string; args: string[]; cwd?: string; timeoutMs: number; maxOutputChars: number;
}
export interface CommandResult {
  exitCode: number | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean; killed: boolean;
}

export interface ContextProvider {
  resolveMention(raw: string): Promise<ResolvedMention | null>;
  seed(prompt: string, budgetTokens: number): Promise<ContextItem[]>;
  search(q: { query: string; glob?: string; maxResults?: number }):
    Promise<{ hits: { path: string; line: number; preview: string }[]; omitted: number }>;
  findSymbol(q: { name: string }): Promise<{ symbols: { name: string; path: string; line: number; kind: string }[] }>;
  repoMap(q: { dir?: string; depth?: number }): Promise<{ tree: string; truncated: boolean }>;
}

export interface UiHost {
  workspaceRoot: string;
  /** vscode.workspace.isTrusted. runCommand MUST be refused when false (docs/03 T12). */
  isWorkspaceTrusted(): boolean;
  context: ContextProvider;
  /** Current VS Code document text if open (dirty or not), else disk. */
  snapshot(path: string): Promise<DocSnapshot>;
  readFile(path: string, range?: LineRange): Promise<string>;
  /** Host MUST use execFile with shell:false, cwd locked to workspace, env scrubbed, kill tree on abort. */
  runCommand(req: CommandRequest, signal: AbortSignal): Promise<CommandResult>;
  /** Ask the user before first execution of a confirm-tier command. Non-blocking UI. */
  confirmCommand(c: { display: string; reason: string }): Promise<boolean>;
}

/** V2.1: lifecycle of ONE pending gated tool call, keyed by sessionId:threadId:toolCallId (docs/01 §4.5). */
export type ToolCallState =
  | 'PROPOSED' | 'WAITING_FOR_REVIEW' | 'ACCEPTED' | 'REJECTED'
  | 'APPLIED' | 'APPLY_FAILED' | 'STALE' | 'APPROVAL_SENT' | 'TOOL_ACKNOWLEDGED' | 'EXPIRED';
