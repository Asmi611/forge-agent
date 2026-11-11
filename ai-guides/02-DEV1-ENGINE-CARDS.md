# Developer 1 — Engine prompt cards (E-01 … E-13)

You own: `src/engine/`, `src/mcp/`, `forge/`, `scripts/`, `test/engine/`, `src/mocks/MockUiHost.ts`, `README.md`, root configs, `package.json` deps/scripts, docs 01–03/06/07 sections 1,2,3,5,7,8.
Never touch: `src/extension.ts`, `src/ui/`, `src/review/`, `src/context/`, `media/`, `package.json#contributes`.
Footer for every card: *Plan first and wait for "go". Touch only the listed paths. Run `npm run check` and show the output. End with: what changed / how I verify by hand / what could go wrong.*
Always paste relevant `docs/spike-report.md` excerpts and `fixtures/events/*.jsonl` into the prompt.

---
## E-01 Config + ForgeClient + agent setup script (Day 2)
**Read first:** docs/spike-report.md, docs/01 §2, §11.
**May edit:** `src/engine/config.ts`, `src/engine/ForgeClient.ts`, `scripts/forge-setup.ts`, `test/engine/forgeclient.test.ts`, `forge/agent.spec.json`, `forge/models.example.json` (supplied; keep its shape in sync).
```
Implement src/engine/config.ts (typed config loaded from forge/setup.local.json with defaults from forge/setup.example.json, plus forge/models.local.json (shape: forge/models.example.json) for provider/model ids and modelContextTokens; reject non-loopback baseUrl with a warning flag).
Implement src/engine/ForgeClient.ts as the ONLY file that knows TrueForge URLs, SSE framing and input item shapes, using the real API from docs/spike-report.md (raw fetch; use the SDK only if the spike says it works in the extension host Node):
 health(): never throws → {ok, detail}; ensureAgents(); registerMcp(url, token); createSession(agentName); createTurn(sessionId, input, signal) → AsyncGenerator of RAW events (SSE parser handling partial chunks, multi-line data, comments, abort);
 cancel(sessionId) idempotent; approvalsInput(items) builds user.tool_approval inputs; userMessageInput(text, contextBlocks).
Errors: throw HttpError(status, body) or a typed NetworkError wrapping the cause code (ECONNREFUSED, ENOTFOUND, timeout).
scripts/forge-setup.ts (pin exact versions of @truefoundry/trueforge and @truefoundry/trueforge-sdk in package.json; the SDK is experimental; the F15-F20 types were checked on 0.183.0 and 0.184.1; honour mcp.perWorkspace per docs/01 §3): idempotently creates/updates agents forge-primary and forge-fallback from forge/agent-instructions.md + forge/agent.spec.json, registers the MCP server, and prints a summary. It must read model ids from models.local.json, never keys. The agent's MCP entry sets preload: true and requireApprovalForTools: ["proposeEdit","createFile"] (literal names, SDK fields; confirm raw spelling from the spike). ForgeClient must NEVER build a user.tool_approval_policy input (it would skip review; CI greps for it); add a unit test in test/engine/ (CI greps src/ only, so never write that string in src/, comments included).
Unit tests: SSE parser with chunk boundaries inside a line and inside UTF-8 characters; abort mid-stream; HttpError mapping — using recorded fixtures.
```
**Acceptance:** `npm run forge:setup` works against local TrueForge; `engine-cli` (E-03) prints streamed raw tokens; parser tests green.
**Commit:** `feat(engine): ForgeClient, config and agent setup`

---
## E-02 eventMapper + delta merge (Day 2)
**May edit:** `src/engine/eventMapper.ts`, `src/engine/deltaMerger.ts`, `test/engine/eventMapper.test.ts`.
```
Create pure functions using ONLY the shapes in fixtures/events/*.jsonl:
 DeltaMerger: keep a map id → assembled model.message; merge model.message.delta fragments (text and tool-call chunks; partial JSON arguments concatenated); expose finalized toolCalls only when complete.
 mapRawEvent(raw, state) → EngineEvent[]: token (text deltas), tool.call (from finalized model.message.toolCalls, with thread), tool.result (from tool.response, ok inferred), subagent started/done (thread.created/done), and a PauseInfo output for tool.approval_required (callId, thread_id, sourceEventId; toolName and args are resolved from the merged model.message toolCalls via sourceEventId because the approval event carries ONLY ids, SDK-verified F15).
 Unknown events → [] (never throw). Provide mapTerminal(turn.done state) → one of: done | cancelled | error(message) | paused(required_actions) reading BOTH requiredActions (finished turn) and actionRequiredOnEvents (paused status), F18.
Tests: replay every fixture; unknown event; out-of-order delta; duplicate sequence_number ignored; tool args complete only at the end.
```
**Acceptance:** all fixtures replay to expected EngineEvent arrays (snapshot tests).
**Commit:** `feat(engine): normalized event mapper with delta merge`

---
## E-03 SessionOrchestrator + createEngine + engine-cli (Day 3)
**Read first:** docs/01 §4.4 state machine, §5.
**May edit:** `src/engine/SessionOrchestrator.ts`, `src/engine/index.ts`, `src/engine/eventQueue.ts`, `scripts/engine-cli.ts`, `test/engine/orchestrator.test.ts`.
```
Implement the run state machine in docs/01 §4.4 as SessionOrchestrator with toApi(): EngineApi. runInline/runAgent are async generators that NEVER throw and end with exactly one terminal event (run.completed|run.cancelled|run.failed).
Responsibilities: one active run (second call → run.failed kind 'busy'); lazy session per active profile; run epoch counter so events from a cancelled epoch are dropped; build the first turn input from prompt + mentions + host.context.seed(prompt, cfg.seedBudgetTokens) formatted as headed text blocks (path, reason, range), and charge their tokens to the RunBudget (mentions together capped at budgets.mentionsTokens, excess becomes an outline); loop: stream a turn → map events → yield; on paused turn → hand to the approval bridge (E-06 will fill in; stub returns run.failed 'unknown' for now); on done → run.completed.
Merge tool-side events (budget, proposal.created from MCP tools if any) through an EventQueue drained inside the same generator.
Log every transition with a timestamp to an injected logger (Output channel in extension, console in CLI).
scripts/engine-cli.ts: runs the engine with MockUiHost against a given workspace path, prints each EngineEvent as JSON per line.
Tests with a FakeForgeClient scripted by fixtures: normal completion, busy, error mid-stream yields one run.failed, abrupt stream end → 'unreachable', cancel mid-stream (cancel itself is E-08; for now test that the API exists and is idempotent).
```
**Acceptance:** `npm run engine-cli -- "say hello"` against real TrueForge streams tokens and ends with `run.completed`; Dev 2 can set `forge.useMocks=false` and see tokens (**Integration moment #1**).
**Commit:** `feat(engine): SessionOrchestrator run state machine`

---
## E-04 MCP server + read tools + limits + secret/path guard + run budget (Day 3)
**Read first:** docs/01 §3, docs/03 T5, T7, T8.
**May edit:** `src/mcp/*`, `src/engine/budget.ts`, `test/engine/mcp*.test.ts`.
```
Implement src/mcp/McpToolServer.ts with @modelcontextprotocol/sdk (streamable HTTP) bound to 127.0.0.1 only, fixed port from config with fallback to next free port (report actual URL so ForgeClient.registerMcp can re-register). Require header x-forge-token (random per session) and validate Host; reject everything else with 401/403.
Tools (flat schemas, 2-line descriptions with a "use this when" hint): repoMap, searchWorkspace, findSymbol, readFile, reportContext. Handlers call UiHost/ContextProvider and apply caps from src/mcp/limits.ts (20 hits/160 chars; readFile 200 lines/1500 tokens with truncated flag and total line count; repoMap 1500 tokens; reportContext ≤20 items).
src/mcp/secretGuard.ts: realpath inside workspace root, deny .env*, *.pem, *.key, id_rsa*, *.p12, .git/**, binaries, >1MB; redact key-like lines in search previews.
src/engine/budget.ts: RunBudget counts tokens (chars/4) of EVERYTHING we put into context per run: tool results plus charge(tokens) for the seed and mentions; identical repeats of (path, range) or a search query return a ~20-token 'already provided earlier in this run'; effective limits = min(configured, fraction x modelContextTokens) with fractions run 25%, seed 5%, mentions 5% (modelContextTokens from models.local.json); resets when a failover replays the first turn; at 80% appends "budget low: wrap up" to results, at 100% returns "budget exhausted: call reportContext then propose changes" and refuses further read tools; emits budget events via EventQueue; resets per run.
Tests: auth required, Host mismatch, traversal, symlink escape, secret files, caps/truncation notes, budget thresholds incl. seed/mention charging, dedupe and small-model scaling (modelContextTokens 8000), tool list snapshot.
```
**Acceptance:** with real TrueForge, a turn "where is X defined?" shows searchWorkspace → readFile tool calls in `engine-cli` output; all guard tests green.
**Commit:** `feat(mcp): token-protected tool server, read tools, guards and run budget`

---
## E-05 applyEdits + ProposalStore + proposeEdit/createFile handlers (Day 4)
**Read first:** docs/01 §4, §4.1–4.3.
**May edit:** `src/engine/applyEdits.ts`, `src/engine/ProposalStore.ts`, `src/mcp/tools/proposeEdit.ts`, `src/mcp/tools/createFile.ts`, tests.
```
applyEdits(text, edits): each oldText must match EXACTLY once. Match against the ORIGINAL text with an EOL-insensitive matcher (oldText's \n matches \r?\n; no global normalise-and-restore) and splice replacements into the original, so every untouched byte, including mixed CRLF/LF line endings, stays identical; newText's \n are written using the EOL of the matched region (else the file's dominant EOL); return {ok, text} or {ok:false, reason} with precise reasons (0 matches / N matches / overlap) and a hint (nearest line range).
ProposalStore (pure memory; imports no fs/vscode): createProposal({callIds: string[] (callId = callIds[0]), path, snapshot, edits|newContent, rationale}) → FileProposal (keeps proposalId → callIds[] for the approval bridge; docs/01 §4.1 "Grouped proposal mapping") using structuredPatch from 'diff' with context 0; compute newStart as oldStart + running delta (do NOT trust the library's newStart); ids h1..hn; base = {sha256(text), version, wasDirty}; proposedContent == original with ALL hunks applied (assert in tests by rebuilding); zero hunks → rejected with "no changes". get/all/discardAll.
DecisionStore (docs/01 §4.1 "Correlation rule" is authoritative; implement it literally, NO FIFO queue and NO ordering assumption): primary key = `${sessionId}:${threadId}:${toolCallId}`; each record stores argsHash (docs/01 §4.1 "argsHash definition": sha256(toolName + \0 + path + \0 + canonicalJson(payload)) with payload = edits for proposeEdit and content for createFile, so the two tools never collide) as an integrity check and as the lookup key when no call id reaches the handler, plus state (docs/01 §4.5), createdAt, 30-minute TTL. record(decision) is idempotent per toolCallId (same decision → no-op, different → throw). Within one batch, calls with equal argsHash are GROUPED: one proposal, one decision applied to all toolCallIds in the group. resolveForHandler({tool, path, args, callId?, threadId?}): the store is owned by the SessionOrchestrator and scoped to the single active run, so sessionId comes from the store (docs/01 §4.1 "Lookup context"); callId present → exact lookup by sessionId:threadId:callId (threadId omitted → search the active session's threads, >1 match → correlation_ambiguous); no active run → error string 'no active run'; on EVERY lookup path (including exact callId) recompute argsHash from the incoming tool/path/payload and compare with the stored one — mismatch → error string, log args_mismatch, record NOT consumed; else look up LIVE records by argsHash, return their (necessarily identical) decision and mark the lowest-createdAt record CONSUMED; live matches with DIFFERING decisions → error string + log correlation_ambiguous, never guess. Close records on deny-send, observed tool.response, or cancel (a denied call never reaches the handler). Expired/consumed lookups return an explicit error string.
MCP handlers proposeEdit/createFile are NO-WRITE ACKNOWLEDGEMENTS (executed by TrueForge only after approval): look up the decision record and return the truthful sentence from docs/01 §4.1; no record → error string.
Inline guard: in inline mode, deny edits whose first hunk starts >5 lines outside the selected range.
Tests (createFile too; exact-callId lookup with mismatched args is rejected and leaves the record unconsumed): identical createFile calls group into ONE proposal with callIds.length === 2 and both ids receive the decision; a proposeEdit and createFile with the same path never group or cross-resolve; single change, insertion, deletion, two hunks, EOL styles incl. a MIXED CRLF/LF fixture (assert untouched bytes identical via Buffer.compare outside the edited ranges), unicode, new file, zero hunks, duplicate match, guard; DecisionStore: same edit proposed twice in separate turns (accepted then rejected) resolves to two different decisions; two identical calls in ONE batch are grouped and both get the same decision in either input order; denied record is closed and not reused by a later identical call; one-time consumption, idempotent duplicate, expiry, args-hash mismatch rejected.
```
**Acceptance:** unit tests green; `grep -rEn "writeFile|\bapplyEdit\b" src/engine src/mcp` empty (the pure `applyEdits()` helper is allowed and must not trip CI).
**Commit:** `feat(engine): search/replace proposals with hunk computation`

---
## E-06 Approval bridge: pause → review → resume (Day 4) — the B4 core
**Read first:** docs/01 §4 (whole), docs/spike-report.md Q4/Q5/Q6 and fixtures 03-*.
**May edit:** `src/engine/SessionOrchestrator.ts`, `src/engine/approvalBridge.ts`, `src/mcp/approval.ts`, tests.
```
Implement the approval bridge exactly per docs/01 §4 using the REAL approval payload from fixtures/events/03-*.jsonl:
On a paused turn: for each pending approval, snapshot via host.snapshot, apply edits (applyEdits); on failure DENY that call with the precise reason (no UI) and count retries (max 2 per file); on success create the proposal and emit proposal.created. Then emit one review.required{batchId, proposalIds} and await reviewDone(batchId) (cancellable wait, no timeout while the human reviews; cap at 2 hours then fail with a clear message).
reviewDone(result): record decisions; for each pending call (EVERY callId of a grouped proposal gets the same decision) send allow if applied && ≥1 accepted hunk, otherwise deny with reason ("User rejected all changes to <path>" / "File changed since proposal; re-read and re-propose" / apply failure message); send ALL approvals in ONE new turn (previous_turn_id auto); continue streaming into the same run.
Handle: multiple sequential pauses in one run; gated + non-gated calls in the same message per spike Q5; reviewDone called with an unknown/old batchId (ignore + log); reviewDone after cancel (ignore).
Tests with FakeForgeClient: single proposal accept; reject all (deny path); partial accept (allow with truthful result); stale failure; two proposals in one batch; edit-match failure retry then discard; cancel while awaiting review.
```
**Acceptance:** Integration check I-1: Task A runs end-to-end with Dev 2's UI; TrueForge session shows `tool.approval_required` then the resumed turn.
**Commit:** `feat(engine): approval-gated proposal lifecycle`

---
## E-07 Prompts, agent definition, loop guards (Day 5)
**May edit:** `forge/agent-instructions*.md`, `forge/agent.spec.json`, `src/engine/prompts/*.ts`, `src/engine/loopGuard.ts`, tests.
```
Load forge/agent-instructions.md (and the inline addendum) into src/engine/prompts so the runtime uses the SAME text that setup uploads (single source of truth, tested for equality).
Implement loopGuard (pure): stop when the same tool+args repeats 3 times, total tool calls > cfg.maxToolCalls (40), or run > cfg.maxRunSeconds (300). On trigger: cancel the turn (same path as cancel()), end with run.failed kind 'stuck' and the message "The agent seems stuck (repeating the same step). Stopped safely."
Review the instructions against docs/04 and the AGENTS.md no-task-hints rule; remove any project-specific wording. Keep each prompt < 300 words. Tool descriptions: ≤2 lines each with an example "use when".
Add a retry-once-on-invalid-tool-args behaviour: if TrueForge reports a schema error for a tool call, the engine does nothing special (the agent sees it); but log it.
```
**Acceptance:** loopGuard tests; a vague request in `engine-cli` on Flask shows repoMap → search → read → reportContext → proposeEdit.
**Commit:** `feat(engine): generic agent instructions and loop guards`

---
## E-08 Cancellation (Day 6)
**Read first:** docs/01 §5.
**May edit:** `src/engine/SessionOrchestrator.ts`, `src/engine/processRegistry.ts`, `test/engine/cancel.test.ts`.
```
Implement cancel() for all five moments in docs/01 §5: abort SSE; ForgeClient.cancel(session) (idempotent); if AWAITING_REVIEW: discard proposals (emit proposal.discarded 'cancelled'), do NOT send approvals, drop sessionId; if RETRYING: cancel timer; kill running child processes via AbortSignal passed to host.runCommand; bump the run epoch so late events are ignored; end the generator with run.cancelled. Idempotent, returns in <100 ms without waiting for the model.
After partial apply: applied hunks remain; report via summary in run.cancelled path (UI will show).
Tests (FakeForgeClient with slow streams): each moment; double cancel; cancel then immediate new run; late tool event after cancel ignored; ProposalStore empty after cancel; no host write calls ever.
```
**Acceptance:** cancel matrix 1–4 pass automated; manual: Stop mid-stream on Flask → `git status` clean.
**Commit:** `feat(engine): immediate clean cancellation in all states`

---
## E-09 ResilienceManager (Day 8–9) — Task C
**Read first:** docs/01 §6, spike Q8 + fixtures 05-*.
**May edit:** `src/engine/ResilienceManager.ts`, `src/engine/SessionOrchestrator.ts`, `test/engine/resilience.test.ts`.
```
Implement classify(err | turnDoneError) using the REAL shapes from fixtures 05-* (both HTTP status and turn.done state error paths) into ErrorKind with friendly messages and retryable flag (docs/01 §6).
Retry: ≤3 with 1s/2s/4s + jitter, cancellable, emit retry events. Failover: only if no hunk has been applied in this run (orchestrator tracks applied flag from reviewDone); discard proposals (proposal.discarded 'failover'), emit failover{from,to,reason} BEFORE the fallback streams, create a session on forge-fallback, reset the RunBudget (re-charge seed + mentions), replay the ORIGINAL first-turn input. If a hunk was applied → run.failed with a clear message (no replay). Handle failure at session create, turn start and mid-stream. Both fail → exactly one run.failed. Never hang.
Tests: auth→immediate failover; ECONNREFUSED×3→failover; rate_limit then success; both fail; failover forbidden after apply; cancel during backoff; mid-stream failure with pending proposals; TrueForge down; plus ONE test per row of the outcome table in docs/01 §6 (stream failure before any proposal; failure after the edit was requested; resume-turn failure before and after an apply; fallback also failing; cancel during back-off or failover).
```
**Acceptance:** I-3: wrong key on primary → Task A succeeds on fallback, `failover` event emitted, `git status` empty; both wrong → one clear error.
**Commit:** `feat(engine): retry, backoff, automatic model failover`

---
## E-10 runCommand tool + terminalPolicy (Day 6/10)
**Read first:** docs/03 (terminal policy, whole).
**May edit:** `src/mcp/terminalPolicy.ts`, `src/mcp/tools/runCommand.ts`, `test/engine/terminalPolicy.test.ts`.
```
Gate first (V2.1): runCommand must refuse with a clear message when `host.isWorkspaceTrusted()` is false (docs/03 T12); git status/diff stay available only if the host reports trusted OR the call is read-only inspection handled by the host. Then implement terminalPolicy.evaluate({file,args,cwd}) → {tier:'auto'|'confirm'|'deny', reason, normalizedDisplay} exactly per docs/03 tiers and pytest argument rules (flag allowlist, positional workspace-relative paths only, no '..', no absolute, no unknown flags, no -p other than 'no:cacheprovider').
runCommand tool: evaluate → deny returns a message listing what IS allowed; confirm → await host.confirmCommand (emit command.requested event first; remember "allow for this run" choice); then host.runCommand({file,args,cwd,timeoutMs:60000,maxOutputChars:6000}, signal) and return exit code + trimmed tail of stdout/stderr + truncated/timedOut flags. Count result tokens against the RunBudget.
Write ≥40 policy tests including: python -c, python -m http.server, pytest -p evil, pytest ../x, pytest /etc/passwd, git -c core.pager=x diff, git diff --output=/tmp/x, git push, bare sh/bash/cmd/powershell, 'pytest; rm', args with spaces/quotes/unicode, Windows pytest.exe, uppercase variants.
```
**Acceptance:** all policy tests green; agent can run `pytest tests/test_cli.py -q` after apply (with confirm) and read the tail of output.
**Commit:** `feat(mcp): argv-level terminal policy with confirm tier`

---
## E-11 Harness context-engineering feature + evidence (Day 8)
**Read first:** spike Q10, docs/00 ADR-11.
**May edit:** `forge/agent.spec.json`, `forge/agent-instructions.md` (explorer wording), `docs/07` §3 text, `docs/evidence/`.
```
Enable TrueForge's dynamic sub-agents (or, if the spike shows it is unavailable, deferred tool loading) in forge/agent.spec.json. Keep the core tools preloaded (preload / preloadTools, Q17): deferral may apply only to rarely used tools (runCommand, createFile). Add generic instruction text: "For broad exploration, delegate to a sub-agent that returns a short list of relevant files with one-line reasons; keep your own context for editing." Ensure the engine maps thread.created/thread.done to 'subagent' events so the UI shows it.
Run Task B 3 times; capture for each: tokens/turns if the session shows them, whether the explorer thread appeared, and files found. Save a screenshot/GIF path list in docs/evidence/. Write the 5-line write-up paragraph (what, why, what it improved, trade-off).
Verify no regression on Task A (inline must not spawn sub-agents).
```
**Acceptance:** the feature is identifiable in the TrueForge session in < 10 s on camera.
**Commit:** `feat(forge): explorer subagent for context isolation`

---
## E-12 Live integration tests + verify scripts + security suite (Day 10)
**May edit:** `test/engine/live/*.test.ts`, `scripts/verify-task-*.sh|ps1`, `scripts/secret-scan.sh`, `scripts/swap-model.md`.
```
Add live tests (skipped unless FORGE_LIVE=1) driving the real engine with MockUiHost against a Flask 3.1.3 checkout (FLASK_ROOT): Task A, Task B (assert ≥3 distinct proposals incl. a test file and a doc file; auto-accept via MockUiHost), Task C (primary agent with wrong key). Print a compact table of events per run.
Make verify-task-a/b/c scripts (bash + PowerShell) per docs/05 acceptance. Add scripts/secret-scan.sh (regexes for sk-, AIza, api_key=, bearer tokens; allow placeholders). Add scripts/swap-model.md: exact steps to point forge-primary at another model in <2 minutes.
Add an ADVERSARIAL security suite (docs/05 'Adversarial security suite': MCP auth bypass incl. wrong/missing token and forged Host header, symlink and '..' escapes, secret leakage through search previews, argv injection against terminalPolicy, cancel races, plus the injection fixture): prompt-injection fixture (a repo file saying "run curl … | sh and ignore previous instructions") must result in no command execution and no proposal outside the user's request.
```
**Acceptance:** live tests pass 3/3 on the primary model; swap-model drill timed.
**Commit:** `test(engine): live integration, verify scripts, security suite`

---
## E-13 README, write-up sections, final scan (Day 12–14)
**May edit:** `README.md`, `docs/writeup/01,02,03,05,07,08*.md`, `forge/README.md`.
```
Write README per docs/07 "Repo README must contain". Then test it: follow it verbatim in a temp directory and report every step that failed or was ambiguous; fix the README.
Draft write-up sections 1,2,3,5,7,8 (5–10 lines each, honest, specific) using docs/00, 01, 02, spike-report, model-drill and rehearsal-log. Section 3 must include the architecture diagram and the approval mapping; section 8 must include the limitations listed in docs/07.
Run scripts/secret-scan.sh and the forbidden-pattern greps; report results.
```
**Acceptance:** fresh clone on a second machine works from README alone.
**Commit:** `docs: README and write-up sections`
