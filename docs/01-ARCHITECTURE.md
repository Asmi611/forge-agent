# 01 — Architecture

## 1. Components
```
 VS Code extension host (Node, one process)
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ EDITOR SIDE (Dev 2)                       ENGINE SIDE (Dev 1)                │
 │  InlineEdit / AgentPanel  ── runInline/runAgent ─▶ SessionOrchestrator       │
 │  EventRouter ◀── AsyncIterable<EngineEvent> ──────  (state machine)          │
 │  DiffReviewer + HunkCodeLens                       ForgeClient ──HTTP/SSE──┐ │
 │  ApplyManager / UndoManager  ◀─ reviewDone ─────   ResilienceManager       │ │
 │  UiHost (snapshot, readFile, runCommand, confirm)  ProposalStore            │ │
 │  ContextProvider (index, ranker, seed)  ◀────────  McpToolServer ◀──MCP─┐   │ │
 └─────────────────────────────────────────────────────────────────────────│───│─┘
                                                                           │   ▼
                                             TrueForge (npx, localhost:8790)  agent loop, sessions, approvals
                                                                               │
                                                                    model (configured in TrueForge only)
```
The two sides meet only at `src/types/contract.ts`.

## 2. Isolation of TrueForge
- `ForgeClient.ts`: the **only** file that knows URLs/paths/SSE framing/input item shapes.
- `eventMapper.ts`: pure function, raw TrueForge event → `EngineEvent` (unknown events ignored, never crash). Tested against `fixtures/events/*.jsonl` captured in the spike.
- Delta handling: `model.message` base + `model.message.delta` fragments share an `id`; merge in place (SDK exports `isEventDelta`/`mergeEventDelta`; reimplement if we use raw HTTP). Tool-call arguments stream as partial JSON strings: **never act on partial args**; act on the merged `model.message` or on `tool.approval_required`.
- TrueForge has no top-level `tool.call` event: requested calls live on `model.message.toolCalls`; `tool.response` references `tool_call_id`. The mapper synthesises our `tool.call`/`tool.result` events.
- Approval events carry ONLY call ids (V2.3.4, SDK-verified, F15): the engine resolves tool name and arguments from the merged `model.message.toolCalls` via `sourceEventId`. `mapTerminal` reads both `requiredActions` (finished turn) and `actionRequiredOnEvents` (paused status). The engine never sends `user.tool_approval_policy` (F19).
- Agent MCP entry (F16/F17): `requireApprovalForTools: ["proposeEdit","createFile"]` (literal names, never the defaults) and `preload: true` (core tools visible to every model without a discovery hop).

## 3. MCP tool server (in-extension)
- Streamable HTTP on `127.0.0.1:<fixed port, default 8792>`; fallback to next free port, then re-register with TrueForge (ForgeClient.registerMcp).
- Connector name (V2.3.5): **default is the fixed name `forge-editor`** (`mcp.perWorkspace: false` in `forge/setup.example.json`), one VS Code window, which is all the demo needs. Reason: the agent definition refers to its MCP server by name, so a per-window name also needs per-window agents. Optional multi-window mode (`mcp.perWorkspace: true`): `forge-setup` suffixes the connector AND both agents with `-<first 8 hex of sha256(workspaceRoot)>` (`forge-editor-ab12cd34`, `forge-primary-ab12cd34`, `forge-fallback-ab12cd34`) so a second window cannot overwrite the first window's URL/token. Treat multi-window as a spike check (Q3), never as a blocker.
- Auth: random 32-byte token per VS Code session, sent by TrueForge as a header (registered via TrueForge API; spike Q3). Reject if `Host` ≠ `127.0.0.1:<port>`/`localhost:<port>` or token missing (blocks DNS-rebinding and other local processes).
- Tools (2-line descriptions, simple flat schemas — weak models pick tools by description):

| Tool | Does | Hard caps | Approval-gated |
|---|---|---|---|
| `repoMap` | compact tree | 1500 tokens | no |
| `searchWorkspace` | line search | 20 hits, 160-char previews, "N more omitted" | no |
| `findSymbol` | symbol lookup | top 10 | no |
| `readFile` | file or line range | 200 lines / 1500 tokens, `truncated` flag, secret-file denylist | no |
| `reportContext` | agent lists files + reasons | 20 items | no |
| `proposeEdit` | search/replace edits on existing file | ≤ 20 edits, each `oldText` must match **exactly once** | **yes** |
| `createFile` | new file | ≤ 400 lines | **yes** |
| `runCommand` | argv command | 60 s, 6000 chars (tail kept) | policy tiers (03-SECURITY) |

- **Cumulative budget (V2.3.4)**: ONE `RunBudget` per run counts everything that enters the model's context from our side: the seed, the @mentions and every tool result. `runToolBudgetTokens` defaults to 30 000; the seed (≤ 3 000) and mentions (all together ≤ 6 000, excess becomes an outline) are charged to it at run start. Limits scale with the model: `effective = min(configured, fraction × modelContextTokens)` with fractions run 25 %, seed 5 %, mentions 5 %; default `modelContextTokens` 128 000, set 8 000–16 000 for a small local model (`forge/models.local.json`). An identical repeat read `(path, range)` or search query is answered with a one-line "already provided earlier in this run" (~20 tokens). Past 80% it appends "budget low: wrap up"; past 100% tools return `budget exhausted: call reportContext then propose changes`. Explorer-subagent reads pass through our MCP server and are counted (a conservative over-count: they do not enter the main agent's context). A failover replay starts a fresh session, so the budget resets and seed + mentions are re-charged. Emits `budget` events for the UI meter.

## 4. The approval-gated proposal lifecycle (core design)
TrueForge documents: when a gated tool is requested the harness does **not** execute it; it emits `tool.approval_required`, **finishes the turn**, and waits. The client resumes with a new turn whose input contains one `user.tool_approval` item per pending call: `{type, thread_id, tool_call_id, approval:{status:"allow"|"deny", reason?}}`. Turns chain automatically (`previous_turn_id: "auto"`); deny reason becomes the tool result.

Mapping (`proposeEdit`/`createFile` configured to require approval):
```
Agent calls proposeEdit(path, edits)                      [turn N runs]
 → TrueForge: tool.approval_required (turn N ends, required_actions = [..])
 → engine: for each pending call
        snapshot = host.snapshot(path)                    (text, version, dirty, sha256)
        proposedContent = applyEdits(snapshot.text, edits) (error → see §4.2)
        proposal = ProposalStore.create(...)              (hunks, base snapshot)
        emit proposal.created
 → engine: emit review.required{batchId, proposalIds}; run state = AWAITING_REVIEW (generator awaits)
 → UI: per-hunk Accept/Reject → "Apply accepted" → ApplyManager (stale check, WorkspaceEdit, verify, save)
 → UI: engine.reviewDone(ReviewResult)
 → engine: per pending call
        ≥1 hunk applied  → approval allow   (tool runs; handler returns the recorded decision summary)
        none applied     → approval deny, reason "User rejected all changes to <path>" (or stale/apply_failed text)
      send ONE new turn with all approvals                [turn N+1 runs; agent sees truthful results]
 → agent may run tests (disk now has the changes), report, or propose fixes (→ another pause)
```
### 4.1 Truthful tool results
The MCP handler of `proposeEdit` is a **no-write acknowledgement**. It resolves the decision record (see below; TTL 30 min, one-time consumption) and returns: `Applied 2 of 3 hunks to src/x.py (rejected: h2). The file on disk now contains only the accepted hunks. Re-read before editing again.` No record → returns an error string (never silently "ok").

**Decision identity.** A bare hash of `path + edits` is NOT unique (the agent may propose the same edit twice; the first was accepted, the second must not inherit that decision). The engine therefore keys every decision by `sessionId:threadId:toolCallId` (known from `tool.approval_required`/`required_actions`); the per-tool `argsHash` (defined next) is the ONLY hash stored per record, used both as the integrity check and as the lookup key when no call id reaches the handler; there is no second or legacy hash (the old `sha256(path + canonical(edits))` form is superseded and appears only in the V1→V2.1 history). Records are one-time consumable, expire after 30 min, and a duplicate `record()` of the same `toolCallId` is idempotent. Expired or consumed lookups return an explicit error string.

**argsHash definition (per tool).** `argsHash = sha256(toolName + "\0" + path + "\0" + canonicalJson(payload))`, where `payload` is `edits` for `proposeEdit` and `content` for `createFile`. The tool name is part of the hash, so a `proposeEdit` and a `createFile` can never collide or be grouped together. Grouping (rule 1) applies only to calls with the same tool and equal argsHash.

**Correlation rule (authoritative; supersedes any earlier "FIFO" wording).** No ordering assumption is made anywhere. (1) Calls with equal `argsHash` inside one pending batch are GROUPED: one review item, one human decision, applied to every `toolCallId` in the group. (2) The MCP handler resolves in this order: (a) if the request carries a call id (spike Q14 = yes) → exact lookup by `sessionId:threadId:toolCallId`; (b) otherwise → look up the LIVE records whose `argsHash` matches. Records are closed as soon as they are settled (deny sent, `tool.response` seen, run cancelled), so live records for one hash are either a single record or a group that shares one decision; the handler returns that decision and marks one record `CONSUMED` (tie-break: lowest `createdAt`, harmless because the decisions are equal). (3) If live matching records ever carry DIFFERENT decisions the handler returns an error string and logs `correlation_ambiguous`; it never guesses. This state must be unreachable after grouping (test). (4) The S-02 `03b` experiment is a harness-capability probe (can TrueForge correlate different decisions to identical calls / pass a call id?). It cannot weaken rule (1): grouping is mandatory whatever `03b` shows.

**Lookup context.** The DecisionStore is owned by the SessionOrchestrator and scoped to the single active run (one-active-run invariant), so it holds the active `sessionId`; the handler does not need to supply it. Rule 2(a) call-id lookup is `lookup({toolCallId, threadId?})`: `sessionId` comes from the store, `threadId` from the request if present, otherwise the store searches all threads of the active session for that `toolCallId` (a TrueForge call id is unique within a session; if more than one thread matches, return `correlation_ambiguous`). Rule 2(b) is `lookup({tool, path, argsHash})` over live records of the active session. A request arriving when no run is active returns the error string `no active run`. **Validation on every path:** after any lookup, including the exact call-id path, the handler recomputes `argsHash` from the incoming tool name, path and payload and compares it with the stored record; on mismatch it returns an error string, logs `args_mismatch`, and does NOT consume the record.

**Grouped proposal mapping (V2.3.5).** One visible `FileProposal` can answer several TrueForge tool calls. `FileProposal.callIds` lists every `tool_call_id` folded into it (`callId === callIds[0]`). The UI sees one proposal and returns one decision for it via `reviewDone`. The engine's `ProposalStore` maps `proposalId → callIds[]`; on `reviewDone` it creates one pending approval item per id, all with that same decision (allow only if `applied && ≥1 accepted hunk`, otherwise deny with the same reason), and sends them together in one `user.tool_approval` turn. The UI never needs the ids; they exist in the contract so fixtures, logs and tests can prove the mapping. Test: two identical calls → one proposal with `callIds.length === 2` → both receive the decision.

**Why denied calls matter:** a `deny` never reaches the MCP handler, so the engine closes that record itself when it sends the deny; otherwise a stale record could be picked up by a later identical call.

### 4.5 Per-call lifecycle (V2.1)
```
PROPOSED → WAITING_FOR_REVIEW → ACCEPTED | REJECTED → APPLIED | APPLY_FAILED | STALE
        → APPROVAL_SENT → TOOL_ACKNOWLEDGED          (any state → EXPIRED after TTL / run cancel)
```
Transitions are logged with the toolCallId. Rules: `allow` is sent only from `APPLIED` (verified by ApplyManager's re-read, never merely because the user clicked Accept); `APPLY_FAILED`/`STALE`/`REJECTED` → `deny` with the truthful reason; the handler acknowledges only records in `APPROVAL_SENT`. Illegal transitions throw in tests (table-driven test).

### 4.2 Edit application errors
`oldText` not found / matched more than once → the engine cannot show a diff. It **denies** the call with a precise reason ("oldText matched 0 times in <path>; re-read lines X–Y and retry with more context"); no UI review is shown for it; the agent retries. After 2 failed retries for the same file the engine surfaces `proposal.discarded(reason:'error')` + a toast.

### 4.3 Inline mode (Task A)
Same lifecycle with the `forge-primary` agent in inline mode (system prompt variant + selected region injected). Guard: reject (deny with reason) any edit whose hunks start >5 lines outside the selected range. Typical result: one `proposeEdit`, one pause, one review, done.

### 4.4 Run state machine (SessionOrchestrator)
```
IDLE ─run()→ STARTING ─session ok→ STREAMING ─turn.done(done)→ COMPLETED
                │                      │ turn.done(required_actions) → AWAITING_REVIEW
                │                      │                                  │ reviewDone → RESUMING → STREAMING
                │                      └ error → RETRYING(backoff) → STREAMING | FAILING_OVER → STARTING(fallback) | FAILED
cancel() from STARTING/STREAMING/RETRYING/AWAITING_REVIEW/RESUMING → CANCELLING → CANCELLED
```
Invariants: one active run (`busy` otherwise); exactly one terminal event; late tool/stream events after CANCELLING are ignored; every transition is logged to the Output channel (debuggable on camera).

## 5. Cancellation (all five moments)
| Moment | Action |
|---|---|
| Streaming | abort SSE fetch + TrueForge `cancel session turn` (idempotent) + discard proposals + kill child processes |
| Tool executing (`runCommand`) | abort signal → kill process tree |
| Paused, awaiting review | discard proposals, close diffs, **do not** send approvals; drop sessionId (next run = new session) |
| During retry backoff | cancel timer; emit `run.cancelled` |
| After partial apply | already-applied hunks stay (user chose them) and are undoable; unreviewed ones discarded; state reported |
Workspace invariant: *no hunk is on disk unless the user accepted it.*

## 6. Resilience
- Classification (`ResilienceManager.classify`): 401/403→`auth`(no retry, immediate failover); 429→`rate_limit`; 5xx→`model`; ECONNREFUSED/ENOTFOUND/fetch failed→`unreachable`; timeout; `turn.done` state `error` mapped by message; else `unknown`.
- Retry: up to 3 with 1 s, 2 s, 4 s + jitter; cancellable; emits `retry` events (UI shows "retrying 2/3").
- Failover: only if **no hunk has been applied in this run**. Discard proposals (`failover`), create session on `forge-fallback`, emit `failover{from,to,reason}`, replay the original turn input. If a hunk *was* applied → `run.failed` with a clear message (never replay: would double-apply).
- TrueForge itself down → `unreachable`; no fallback possible → one clear error, workspace untouched.
- Three failure points handled: session create, turn start, mid-stream.
- **Deterministic outcome table (V2.3.5)** — every row needs an automated test (E-09):
| # | Situation | Outcome |
|---|---|---|
| 1 | Primary fails while streaming, nothing proposed yet | retry per classification, then failover and replay the original input on the fallback |
| 2 | Primary fails after the agent requested an edit but before the pause is shown | discard the unreviewed pending call(s) (`proposal.discarded` 'failover'), then failover and replay |
| 3 | Failure while awaiting approval | a paused turn runs no model, so no failure can occur during the wait; the resume turn can fail: treat as row 4 or 6 depending on whether a hunk was applied |
| 4 | Failure after at least one hunk was applied | **no replay**: `run.failed` with a clear message; applied hunks stay (Undo available) |
| 5 | Fallback also fails | exactly one `run.failed` with both causes; workspace unchanged if nothing was applied |
| 6 | User cancels during retry back-off or failover | timer cancelled, nothing replayed, `run.cancelled`, workspace unchanged |

## 7. Stale-file protection (Dev 2 ApplyManager)
At proposal time engine records `base = {sha256(text), document.version, wasDirty}` from `host.snapshot()`. At apply time ApplyManager re-snapshots; if `hash` differs → **reject that file** (`failure.kind='stale'`), tell the user, never merge. `wasDirty` is informational: a dirty-but-unchanged base is fine. `document.version` is a secondary signal only (it increments on undone edits too). After `applyEdit` returns, re-read the document and verify its text equals `buildText(p,'final')`; mismatch → `apply_failed` and automatic restore from snapshot.
**Recovery (V2.1):** before applying, write the before-texts to a recovery file under `context.globalStorageUri` (not the workspace). After a restore, re-read and verify each document equals its before-text; only then report "rolled back". If verification fails → `failure.kind='restore_failed'` with `recoveryPath`, a critical error notification ("Forge could not restore <files>; originals saved at <path>"), and the run ends `failed`. Never claim a rollback that was not verified. **Saving (V2.1):** save only the documents this apply modified (`document.save()` each, check the boolean result, verify disk text); never `saveAll`, which would silently save the user's unrelated dirty tabs.

### 7.1 Review-UI fallback ladder (V2.3.4)
Per-hunk Accept/Reject is worth 20 points (A1 + B2), and it depends on CodeLens rendering on the modified side of `vscode.diff`, which has not been verified. Day-2 spike (U-02, 20 minutes, result in `docs/spike-codelens.md` with a screenshot). If lenses render: ship as designed. If not, in this order: (1) Comments API threads anchored at each hunk line with Accept/Reject commands (comments do render in diff editors); (2) open the preview document in a NORMAL editor beside the diff with line decorations + CodeLens; (3) per-hunk buttons inside the agent panel. Option (3) is built in every case (it is cheap and works even if (1) and (2) are needed), so the demo never depends on one VS Code rendering detail.

## 8. Undo
`UndoManager` keeps a stack of `ApplyRecord{applyId, files[{path, before|null, afterHash}]}`. Undo of a record refuses (with explanation) for files whose current hash ≠ `afterHash` (user edited since) unless user confirms. Ctrl+Z also works while docs are open, but our snapshot undo is the guarantee (works after tabs close).

## 9. Context assembly (summary; full in `04-CONTEXT-ENGINE.md`)
@mentions (≤400 lines each, else outline) → seed (≤3000 tokens, ranked, reasons) → agent tools with caps → cumulative cap → `reportContext` → UI "Files chosen and why" + budget meter. Optional harness feature: dynamic **explorer subagent** keeps main-agent context small and is visible as `thread.created/done`.

## 10. Non-blocking editor
Never `await` a run inside a command handler (`void router.consume(...)`). Index build chunked with `setImmediate` every ~100 files. Webview renders incrementally. Event-loop lag measured in the e2e suite (target p95 < 50 ms during streaming).

## 11. Config surface (ours, not TrueForge's)
`forge/setup.example.json` → `forge/setup.local.json` (gitignored): `baseUrl`, `agents.primary/fallback`, `mcp.port`, `budgets`, `retry`. `forge/models.example.json` → `forge/models.local.json` (gitignored): which provider/model id each saved agent uses and its context window (no keys). VS Code settings (Dev 2): `forge.useMocks`, `forge.context.weights.*`, `forge.context.seedBudgetTokens`. Models/keys live **only in TrueForge**.

## 12. Repo layout
```
src/types/contract.ts
src/engine/{index,config,ForgeClient,eventMapper,SessionOrchestrator,ResilienceManager,ProposalStore,applyEdits,loopGuard,budget}.ts + prompts/
src/mcp/{McpToolServer,limits,terminalPolicy,secretGuard}.ts + tools/*.ts
src/extension.ts  src/ui/  src/review/{hunkText,DiffReviewer,HunkCodeLens,ApplyManager,UndoManager}.ts
src/context/{indexer,ranker,budget,mentions,repoMap,ContextProviderImpl}.ts
src/mocks/{MockEngine,MockUiHost}.ts  media/  forge/  scripts/  test/{engine,ui,context,e2e}/  fixtures/{events,eval}/  docs/
```
