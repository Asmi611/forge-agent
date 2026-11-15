# S-02 TrueForge Spike Report: Integration Feasibility & Day-1 Gate G0 Assessment

## Document Information
- **Pack Version**: Forge-a-thon Pack v2.3.5
- **TrueForge Target**: Local mode (`@truefoundry/trueforge@v0.185.1`, `@truefoundry/trueforge-sdk@0.184.1`)
- **Node Requirement**: Node >= 22.14 (engine host bypassed via raw HTTP client, ADR-10)
- **Author**: Developer 1 (Engine)
- **Date**: 14–15 November 2026
- **Status**: Completed Day-1 Spike Analysis / Gate G0 IN PROGRESS

---

## 1. Executive Summary & Gate G0 Status

The Day-1 integration spike (Card S-02) investigated the runtime behavior, wire protocol, MCP tool gating, and error modes of TrueForge running in local mode (`http://localhost:8790`). The primary goal was to prove the feasibility of an approval-gated AI coding agent where editor file edits are strictly proposed, reviewed per-hunk by the human, and applied only by the editor extension.

### Key Spike Conclusions:
1. **Core Feasibility Proven**: Raw HTTP turn creation, SSE streaming, and local MCP tool invocation over HTTP (`http://127.0.0.1:8792/mcp`) work reliably without any external cloud dependencies or provider SDK imports in the client.
2. **Approval Gating Operational**: TrueForge correctly pauses the active turn upon encountering gated tools (`tool.approval_required` followed by `turn.update` with `state.status: "paused"`), and cleanly resumes the same turn upon receiving `user.tool_approval` events submitted to `POST /api/v1/sessions/{session_id}/turns/{turn_id}/events`. Multiple parallel tool calls within a single turn are individually gated and executed according to per-call human decisions submitted sequentially.
3. **Class B Discovery (Correlation Rule)**: Inspected MCP tool execution requests carried `x-tfg-session-id`, but contained **no `tool_call_id`**, caller thread ID, or correlation metadata in headers, `_meta`, or arguments. Consequently, the MCP server cannot distinguish between identical concurrent calls by ID alone. To ensure deterministic human review, identical tool calls must be consolidated into a single proposal item per `docs/01-ARCHITECTURE.md` §4.1.
4. **Resilience & Cancellation**: Active streaming cancellation is verified via `POST /api/v1/sessions/{id}/cancel` (HTTP 200, clean `cancelled` terminal event). Model errors (404 and timeouts) surface cleanly as terminal SSE events (`turn.done` with `state.status: "error"`).
5. **Gate G0 Status: IN PROGRESS**: The critical architectural gates are overwhelmingly resolved. Gate G0 remains marked **IN PROGRESS** pending four outstanding action items (detailed in Section 7):
   - Verification of extension host reload across a paused approval session (Q6; 10-minute pause verified live; reload across restart remaining).
   - Visual inspection and session URL recording in the TrueForge Web UI (Q16).
   - Completion of the comparative preload 3-run evaluation matrix (Q17; `preload: false` vs `preload: true`).
   - Authoring and committing `forge/agent.spec.json` (currently MISSING).

---

## 2. Evidence Registry & Classification

To ensure rigorous auditability, all evidence referenced throughout this report is categorized into one of five distinct classes:

| Class | Definition | Verification Standard |
|---|---|---|
| **Class 1: Live-Verified Behavior** | Behavior executed and verified live against running TrueForge instance, with outputs confirmed in test execution logs. | Rerunnable script pass, console output verified, status codes confirmed. |
| **Class 2: Committed Fixture Evidence** | Raw JSONL wire event logs captured during live runs and committed to `fixtures/events/`. | Immutable file on disk containing exact raw SSE frames. |
| **Class 3: Local Uncommitted Supporting Evidence** | Supporting diagnostic files present in local worktree but not tracked in version control. | Validated against local server schema, e.g. `scripts/spike/openapi-local.json`. |
| **Class 4: Architectural Decisions** | Design rules and client-side policies adopted to handle unverified or edge-case platform behaviors. | Documented in `docs/01-ARCHITECTURE.md` and repository ADRs. |
| **Class 5: Untested / Unconfirmed Behavior** | Platform capabilities or error states that have not been exercised live. | Explicitly flagged as unverified; fallbacks active. |

### 2.1 Committed Fixture Inventory (`fixtures/events/`)

| Fixture File | Relevant Questions | Description / Wire Event Sequence |
|---|---|---|
| `01-plain.jsonl` | Q2, Q9 | Baseline non-tool turn: `turn.created` -> `model.message` -> incremental `model.message.delta` fragments -> `turn.done` (`state.status: "done"`). |
| `02-tool.jsonl` | Q3, Q9, Q14 | Ungated MCP tool call: model requests `echo`, tool executes on local MCP server, returns `tool.response`, model synthesizes final output. |
| `03-allow-turn1.jsonl` | Q4, Q15 | Gated tool turn 1: model calls gated tool; TrueForge emits `tool.approval_required` with `tool_calls: [{id, source_event_id}]` and updates turn state to paused (`turn.update`). |
| `03-allow-resume.jsonl` | Q4 | Baseline turn 1 capture from turn creation through `tool.approval_required` and pause. |
| `03-allow-resume-sse.jsonl` | Q4 | Resumed turn SSE stream: shows paused turn continuation upon receiving approval event (`user.tool_approval`), status update to `running`, MCP tool handler execution, and final model response. |
| `03-deny-turn1.jsonl` | Q4 | Gated tool turn 1 (denial test): pauses at `tool.approval_required` and `turn.update` (`status: "paused"`). |
| `03-deny-resume.jsonl` | Q4 | Baseline turn 1 capture for denial test from turn creation through `tool.approval_required`. |
| `03-deny-resume-sse.jsonl` | Q4 | Resumed turn SSE stream (denial): shows paused turn continuation upon receiving denial approval event, MCP handler skipped (0 executions), model receives rejection error in `tool.response`, and adjusts response. |
| `03-wait-turn1.jsonl` | Q6 | Pause turn 1 before delayed resumption test. |
| `03-wait-resume-sse.jsonl` | Q6 | Resumed turn after ~60-second pause (`12:45:37Z` to `12:46:37Z`). Resumes cleanly with `allow` approval event. |
| `03-parallel-turn1.jsonl` | Q5 | 3 gated calls in single model message: emits `tool.approval_required` listing 3 pending call IDs, followed by `turn.update` (`status: "paused"`). |
| `03-parallel-resume-sse.jsonl` | Q5 | Parallel resumption: shows sequential submission of 3 individual approval events (`allow`, `deny`, `allow`) to the paused turn. Exactly 2 MCP handler executions observed. |
| `03-identical-turn1.jsonl` | Q14 | Baseline turn with 2 identical gated calls. |
| `03-identical-resume-sse.jsonl` | Q14 | Baseline identical call resumption stream. |
| `03b-identical-i-turn1.jsonl` | Q14 | Permutation i turn 1: 2 identical gated calls issued. |
| `03b-identical-i-resume-sse.jsonl` | Q14 | Permutation i resume: decisions submitted in order `[Call 2, Call 1]` with `[allow, deny]`. Exactly 1 execution. |
| `03b-identical-ii-turn1.jsonl` | Q14 | Permutation ii turn 1: 2 identical gated calls issued. |
| `03b-identical-ii-resume-sse.jsonl` | Q14 | Permutation ii resume: decisions submitted in order `[Call 1, Call 2]` with `[deny, allow]`. Exactly 1 execution. |
| `03b-identical-iii-turn1.jsonl` | Q14 | Permutation iii turn 1: 2 identical gated calls issued. |
| `03b-identical-iii-resume-sse.jsonl` | Q14 | Permutation iii resume: decisions submitted in order `[Call 1, Call 2]` with `[allow, deny]`. Exactly 1 execution. |
| `04-cancel-pre-fix.jsonl` | Q7 | Historical evidence preserving earlier parser ReferenceError during rapid cancellation. |
| `04-cancel.jsonl` | Q7 | Verified active streaming cancellation: `turn.done` with `state: {"status":"cancelled"}`. |
| `05-model-404.jsonl` | Q8 | Model error fixture (non-existent model): `turn.done` with `state: {"status":"error","message":"[Model Error] Request failed (404)..."}`. |
| `05-model-timeout.jsonl` | Q8 | Model error fixture (unreachable host): `turn.done` with `state: {"status":"error","message":"[Model Error] Cannot connect to API: Headers Timeout Error"}`. |
| `diagnostic-01-plain.jsonl` | Q2 | Supplemental clean plain text turn capture without debug wrappers. |
| `diagnostic-02-mcp-tool.jsonl` | Q3, Q14 | Supplemental MCP tool call capture verifying incoming headers and handler invocations. |

### 2.2 Local Supporting Evidence
- `scripts/spike/openapi-local.json`: Local, uncommitted OpenAPI v3 specification fetched directly from `GET /openapi.json` of the running TrueForge instance (`http://localhost:8790`). Confirms endpoint definitions, event submission schemas, field names (`require_approval_for_tools`), and payload schemas.

---

## 3. Complete Answers to Spike Questions (Q1 through Q17)

### Q1: Exact base path and auth of HTTP API in local mode; SDK vs raw HTTP
- **Answer**: TrueForge local mode listens by default on `http://localhost:8790`. All operational REST routes are exposed under `/api/v1/...` (e.g., `/api/v1/agents`, `/api/v1/sessions`, `/api/v1/sessions/{id}/turns`, `/api/v1/sessions/{id}/turns/{turn_id}/events`). In local mode, no authentication header or bearer token is required for `/api/v1/*` requests. Per ADR-10, raw HTTP via native Node `fetch` is used in place of `@truefoundry/trueforge-sdk`.
- **Evidence**: `scripts/spike/00-discover.mjs`, `scripts/spike/_lib.mjs`.
- **Status**: **VERIFIED** (Class 1 & Class 2).
- **Fallback Chosen**: None needed. Raw HTTP client adopted per ADR-10.

### Q2: Create agent, session, and turn from code; capture turn stream
- **Answer**: Agent manifests are created via `POST /api/v1/agents`, sessions via `POST /api/v1/sessions`, and turns via `POST /api/v1/sessions/{id}/turns`. Turns chain automatically via `previous_turn_id: "auto"`. SSE streaming (`GET /api/v1/sessions/{id}/turns/{turn_id}/events` or turn creation stream) opens with `turn.created` and closes with `turn.done`.
- **Evidence**: `fixtures/events/01-plain.jsonl`, `fixtures/events/diagnostic-01-plain.jsonl`, `scripts/spike/01-plain.mjs`.
- **Status**: **VERIFIED** (Class 1 & Class 2).
- **Fallback Chosen**: None needed.

### Q3: Local MCP server connectivity over HTTP with custom header auth
- **Answer**: TrueForge successfully connects to a local streamable HTTP MCP server running at `http://127.0.0.1:8792/mcp`. The agent manifest registers the server under `mcp_servers` with `transport: "http"` and includes custom headers (`{"x-forge-token": "<token>"}`). TrueForge forwards this header on all MCP POST requests.
- **Evidence**: `fixtures/events/02-tool.jsonl`, `fixtures/events/diagnostic-02-mcp-tool.jsonl`, `scripts/spike/02-mcp-tool.mjs`, `scripts/spike/mcp-server.mjs`.
- **Status**: **VERIFIED** (Class 1 & Class 2).
- **Fallback Chosen**: None needed. Loopback HTTP MCP transport is fully functional.

### Q4: Tool approval configuration and wire payload format
- **Answer**: Approval gating is configured per MCP server in the agent manifest using `require_approval_for_tools: ["<tool_name>"]` (verified live with `gated_echo`). When a gated tool is invoked, TrueForge emits `tool.approval_required` followed immediately by a `turn.update` event with `state: {"status": "paused"}` on the current turn. The raw `tool.approval_required` event payload is:
  ```json
  {
    "id": "<event_id>",
    "thread_id": "main",
    "tool_calls": [
      {
        "id": "<tool_call_id>",
        "source_event_id": "<model_message_event_id>"
      }
    ]
  }
  ```
  **Crucial Finding**: The event contains **neither tool names nor tool arguments**. The engine must resolve the tool name and call arguments by looking up `source_event_id` in the earlier `model.message` event.

  **Approval Wire Protocol**: Resuming does **not** create a new turn or pass an `input` array. Instead, approval decisions are submitted as individual events directly to the active, paused turn via:
  `POST /api/v1/sessions/{session_id}/turns/{turn_id}/events`

  The request body schema for allowing a tool call is:
  ```json
  {
    "events": [
      {
        "type": "user.tool_approval",
        "thread_id": "main",
        "tool_call_id": "<tool_call_id>",
        "approval": {
          "status": "allow"
        }
      }
    ]
  }
  ```
  The request body schema for denying a tool call with a truthful rejection reason is:
  ```json
  {
    "events": [
      {
        "type": "user.tool_approval",
        "thread_id": "main",
        "tool_call_id": "<tool_call_id>",
        "approval": {
          "status": "deny",
          "reason": "User rejected this tool call"
        }
      }
    ]
  }
  ```
  Upon receipt of the approval event, TrueForge emits `user.tool_approval` into the SSE stream, emits `turn.update` with `state: {"status": "running"}`, executes the tool on the MCP server (if allowed), or synthesizes a denial error response (if denied), and allows the model to complete the turn.
- **Evidence**: `fixtures/events/03-allow-turn1.jsonl` (line 7), `fixtures/events/03-allow-resume-sse.jsonl`, `fixtures/events/03-deny-resume-sse.jsonl`, `scripts/spike/_lib.mjs` (`submitApprovalEvent()`).
- **Status**: **VERIFIED** (Class 1 & Class 2).
- **Fallback Chosen**: Resolution from merged `model.message.toolCalls` via `source_event_id` implemented as primary architecture (F15).

### Q5: Parallel tool calls in a single message
- **Answer**: When a model emits multiple gated tool calls in one turn, TrueForge bundles them into a single `tool.approval_required` event containing all pending `tool_calls`, followed by `turn.update` (`status: "paused"`).
  
  The client resumes the turn by submitting each approval decision **individually in sequence** via `submitApprovalEvent()`:
  `POST /api/v1/sessions/{session_id}/turns/{turn_id}/events`
  with `{ events: [{ type: "user.tool_approval", thread_id, tool_call_id, approval }] }`.

  The client simultaneously monitors the continuation of the active turn via `subscribeTurnEvents(sessionId, turnId, { fromEventId })`. In live testing with 3 gated calls (`call_1`, `call_2`, `call_3`) and sequential decisions `[allow, deny, allow]`:
  1. Each event POST returned HTTP 201.
  2. TrueForge emitted corresponding `user.tool_approval` events for all three calls into the SSE stream.
  3. Once all decisions were received, TrueForge transitioned the turn with `turn.update` (`state: {"status": "running"}`).
  4. TrueForge executed the MCP handler **exactly 2 times** (for the 2 allowed calls), while skipping handler invocation for the denied call and generating a synthetic rejection `tool.response` (`{"error":[{"type":"text","text":"{\"error\":\"User denied tool call: User rejected this one\"}"}]}`).
  5. The model synthesized a final summary accounting for all three outcomes, and the turn concluded with `turn.done` (`status: "done"`).
- **Evidence**: `fixtures/events/03-parallel-turn1.jsonl`, `fixtures/events/03-parallel-resume-sse.jsonl`, `scripts/spike/03-approval.recovered.mjs`.
- **Status**: **VERIFIED** (Class 1 & Class 2).
- **Fallback Chosen**: None needed. Sequential event submission for multi-call batch approval is fully verified.

### Q6: Delayed approval (10+ minutes) and extension reload
- **Answer**:
  - **10-minute human review pause**: **VERIFIED LIVE** on 14 November 2026. A turn paused at an approval gate was held for 10 minutes (600 seconds) before sending `user.tool_approval` via `submitApprovalEvent()`. TrueForge returned HTTP 201, executed the MCP handler exactly once, and resumed the turn to completion (`done`).
  - **Committed Fixture**: To prevent excessive test suite runtimes, the committed fixture `fixtures/events/03-wait-resume-sse.jsonl` captures a ~60-second delay (`12:45:37Z` to `12:46:37Z`), successfully proving the identical pause-and-resume wire protocol.
  - **Extension reload across pause**: **NOT TESTED**. TrueForge state persistence across an extension restart remains unverified.
- **Evidence**: Live test logs (14 Nov 2026); `fixtures/events/03-wait-resume-sse.jsonl` (60s fixture).
- **Status**: **PARTIALLY VERIFIED** (Class 1 live 10-min test; Class 2 60s fixture; reload unverified).
- **Fallback Chosen**: Re-hydrate session state from persistent storage (`session_id` and pending proposal map). If session reconnection fails after reload, prompt user to resume or discard.

### Q7: Cancellation API during streaming and when paused
- **Answer**:
  - **Active streaming cancellation**: **VERIFIED**. Sending `POST /api/v1/sessions/{id}/cancel` while tokens were streaming returned HTTP 200 within ~13–28 ms. The SSE stream immediately yielded `turn.done` with `state: {"status":"cancelled"}` and closed cleanly without unhandled stream errors.
  - **Repeated cancellation**: A second immediate cancellation request returned **HTTP 200**. (This demonstrates that the server returned HTTP 200 rather than establishing a universal idempotency guarantee under all states).
  - **Paused cancellation**: Cancellation while paused at an approval gate was **NOT independently tested against TrueForge server endpoints**. Per architectural policy (ADR-04), paused cancellation is handled **client-side**: pending proposals are discarded locally, and the turn is either discarded or a new turn/session is created without sending approvals.
- **Evidence**: `fixtures/events/04-cancel.jsonl`, `fixtures/events/04-cancel-pre-fix.jsonl`, `scripts/spike/04-cancel.mjs`.
- **Status**: **PARTIALLY VERIFIED** (Class 1 & Class 2 for streaming cancel; Class 4 architectural policy for paused cancel).
- **Fallback Chosen**: Client-side proposal discard for paused turns.

### Q8: Model error surfacing (404, timeouts, invalid key, rate limits)
- **Answer**:
  - **Model 404 (non-existent model)**: Script execution logs confirm `POST /api/v1/sessions/{id}/turns` returned **HTTP 201 Created**. The error surfaced asynchronously in the SSE stream as `turn.done` with `state: {"status":"error","message":"[Model Error] Request failed (404): The model \`llama-3.3-70b-versatile\` does not exist or you do not have access to it."}`.
  - **Model Timeout (unreachable provider)**: Script execution logs confirm `POST /api/v1/sessions/{id}/turns` returned **HTTP 201 Created**. The error surfaced asynchronously in the SSE stream as `turn.done` with `state: {"status":"error","message":"[Model Error] Cannot connect to API: Headers Timeout Error"}`.
  - **Distinction of Proof**: The JSONL event fixtures prove the terminal SSE event structure; the execution logs prove that turn creation initially succeeds with HTTP 201.
  - **Untested**: HTTP 401/403 (invalid provider API key) and HTTP 429 (rate limiting) were not simulated.
- **Evidence**: `fixtures/events/05-model-404.jsonl`, `fixtures/events/05-model-timeout.jsonl`.
- **Status**: **PARTIALLY VERIFIED** (Class 1 & Class 2 for 404/timeout; Class 5 for 401/403/429).
- **Fallback Chosen**: Two-tiered error handler in Engine: inspect HTTP response on turn creation, and monitor stream for `turn.done` with `status: "error"` to surface clear diagnostic banners in the UI.

### Q9: Token granularity of deltas and argument completion
- **Answer**: Text tokens arrive incrementally in fine-grained chunks via `model.message.delta` events sharing the base message `id`. Tool call arguments in deltas arrive in fragments and are incomplete until the model finishes generating the tool call (indicated by `finish_reason: "tool_calls"`).
- **Evidence**: `fixtures/events/01-plain.jsonl`, `fixtures/events/02-tool.jsonl`, `fixtures/events/03-allow-turn1.jsonl`.
- **Status**: **VERIFIED** (Class 1 & Class 2).
- **Fallback Chosen**: The extension must never parse partial tool arguments; it buffers deltas and processes tool invocations only from the fully merged `model.message` event.

### Q10: Subagents and sandbox runtime toggles
- **Answer**: Subagent creation (`thread.created`/`thread.done`) and sandbox execution were not exercised in the Day-1 spike. The single-agent loop with MCP tools satisfies all requirements of Pack v2.3.5.
- **Evidence**: None.
- **Status**: **NOT VERIFIED** (Class 5).
- **Fallback Chosen**: Dynamic subagents disabled (`subagents: false` in agent spec). Operate exclusively on the single `"main"` thread.

### Q11: MCP payload limits and tool timeouts
- **Answer**: Maximum payload size accepted by TrueForge and tool execution timeout caps were not stress-tested during the Day-1 spike.
- **Evidence**: None.
- **Status**: **NOT VERIFIED** (Class 5).
- **Fallback Chosen**: Enforce strict client-side limits in the MCP server matching `docs/01-ARCHITECTURE.md` §3:
  - `runCommand`: Hard caps of **60 s execution timeout** and **6,000 characters of tail output** kept.
  - `readFile`: Hard caps of **200 lines / 1,500 tokens**, with `truncated` flag and secret-file denylist.
  - `createFile`: Hard cap of **<= 400 lines**.
  - `proposeEdit`: Hard cap of **<= 20 edits**, each `oldText` matching exactly once.
  - `searchWorkspace`: Hard cap of **20 hits, 160-char previews**.
  - `findSymbol`: Hard cap of **top 10**.
  - `repoMap`: Hard cap of **1,500 tokens**.
  - `reportContext`: Hard cap of **20 items**.
  - Cumulative `RunBudget`: Default **30,000 tokens** (`runToolBudgetTokens`) per run with seed <= 3,000 tokens and mentions <= 6,000 tokens.

### Q12: Extension Host Node version vs TrueForge SDK requirements
- **Answer**: The VS Code extension host runs Node.js 20.x, whereas `@truefoundry/trueforge-sdk` mandates Node >= 22.14. Per ADR-10, we bypass the SDK entirely and interact with TrueForge via standard HTTP `fetch` and SSE streams, eliminating any version mismatch.
- **Evidence**: ADR-10, `scripts/spike/_lib.mjs`.
- **Status**: **VERIFIED** (Class 1 & Class 4).
- **Fallback Chosen**: Raw HTTP client adopted as primary architecture.

### Q13: Port availability and collision handling
- **Answer**: Local mode reliably binds to default port 8790 (`http://localhost:8790`). The mock MCP server binds to 8792. Multi-instance collision handling and automatic discovery from startup logs have not been implemented.
- **Evidence**: `scripts/spike/00-discover.mjs`, `scripts/spike/mcp-server.mjs`.
- **Status**: **PARTIALLY VERIFIED** (Class 1).
- **Fallback Chosen**: Configurable `forge.baseUrl` in extension settings with probe sequence: test 8790 first, then 8791 (Docker compose port).

### Q14: MCP request headers and tool call correlation (Class B Finding)
- **Answer**:
  - **Headers**: Inspected incoming MCP `tools/call` requests contained `x-tfg-session-id`.
  - **Missing Identifiers**: **No `tool_call_id`**, thread ID, or correlation metadata was present in headers, request `_meta`, or tool arguments.
  - **Classification**: **Class B**. The MCP server cannot associate a tool invocation with an individual TrueForge `tool_call_id`.
  - **Architectural Consequence**: Tool invocations cannot be matched by `tool_call_id`. Instead, matching must use an `argsHash` lookup. When identical tool calls occur within a turn, they must be grouped into a single Proposal Item (Correlation Rule, `docs/01-ARCHITECTURE.md` §4.1). In the 03b permutations test, submitting allow/deny decisions for duplicate calls proved that exactly 1 handler execution occurs whenever 1 call is allowed, regardless of submission order.
- **Evidence**: `scripts/spike/mcp-server.mjs`, `fixtures/events/03b-identical-i-resume-sse.jsonl`, `fixtures/events/03b-identical-ii-resume-sse.jsonl`, `fixtures/events/03b-identical-iii-resume-sse.jsonl`.
- **Status**: **VERIFIED** (Class 1 & Class 2).
- **Fallback Chosen**: Group identical calls by `argsHash` into a single Proposal Item; submit identical approval decisions for all matching `tool_call_id`s.

### Q15: Agent manifest approval configuration spelling
- **Answer**: In the raw HTTP agent manifest, tool gating is configured using snake_case `require_approval_for_tools: [...]` inside the MCP server entry.
  - **Ordinary Tool Execution**: `02-mcp-tool.mjs` tested ordinary ungated MCP tool execution with `echo`; the tool executed immediately without requiring approval, confirming that tools not listed in `require_approval_for_tools` bypass the approval gate.
  - **Spike-Verified Approval Tool**: `gated_echo` was configured in `require_approval_for_tools: ["gated_echo"]` and verified live to trigger approval pauses across the approval tests in `03-approval.recovered.mjs`.
  - **Production Tools**: `proposeEdit` and `createFile` are the intended production tool names specified in `docs/01-ARCHITECTURE.md` §3. Gating for these specific tool names was **not live-verified** in this spike because the production MCP tool server (`src/mcp/`) is not yet implemented.
  - **Conclusion**: The literal name-based gating mechanism is proven on the harness via `gated_echo`, confirming that configuring literal tool names in `require_approval_for_tools` is supported by the TrueForge runtime. Supporting schema confirmed in local uncommitted OpenAPI schema `scripts/spike/openapi-local.json`.
- **Evidence**: `fixtures/events/03-allow-turn1.jsonl`, `scripts/spike/03-approval.recovered.mjs`, local uncommitted supporting evidence `scripts/spike/openapi-local.json`.
- **Status**: **VERIFIED** (Class 1, Class 2 & Class 3) for the gating mechanism and `gated_echo`; production tool names (`proposeEdit`, `createFile`) remain to be verified upon implementation.
- **Fallback Chosen**: Explicit literal tool names in `require_approval_for_tools` configured in the agent specification.

### Q16: API sessions visible in TrueForge Web UI
- **Answer**: Sessions created via the API persist in TrueForge's internal SQLite database and are queryable via `GET /api/v1/sessions`. However, visual confirmation of API-created sessions in the TrueForge Web UI and determination of their exact web route (e.g., `http://localhost:8790/sessions/{session_id}`) has not yet been documented.
- **Evidence**: API persistence confirmed; Web UI route unconfirmed.
- **Status**: **PARTIALLY VERIFIED** (Class 1 for API persistence; Class 5 for UI visibility).
- **Fallback Chosen**: Complete manual inspection of the TrueForge Web UI before final Task B video recording; record the exact navigation URL.

### Q17: Tool discovery under `preload: false` vs `preload: true`
- **Answer**: All spike scripts operated with `preload: true`, which successfully discovered and executed all registered MCP tools. A comparative 3-run evaluation comparing `preload: false` against `preload: true` was not executed.
- **Evidence**: `scripts/spike/02-mcp-tool.mjs` (contains configurable `$env:PRELOAD` harness).
- **Status**: **NOT VERIFIED** (Class 5).
- **Fallback Chosen**: Maintain `preload: true` explicitly on all MCP server configurations per ADR-13.

---

## 4. Approval Gating Deep-Dive (Q4, Q5, Q6, Q14, Q15)

The approval-gated interaction is the foundation of the editor extension's safety model. The spike thoroughly verified the gating lifecycle across 5 distinct execution modes.

### 4.1 Wire Event Sequence
1. **Model requests gated tool**:
   ```json
   {
     "id": "evt_1",
     "type": "model.message",
     "toolCalls": [
       {
         "id": "call_1",
         "name": "gated_echo",
         "arguments": "{\"text\":\"one\"}"
       }
     ]
   }
   ```
2. **TrueForge intercepts gated tool and emits `tool.approval_required`**:
   ```json
   {
     "id": "evt_2",
     "type": "tool.approval_required",
     "thread_id": "main",
     "tool_calls": [
       {
         "id": "call_1",
         "source_event_id": "evt_1"
       }
     ]
   }
   ```
3. **Turn state updates to paused**: TrueForge emits `turn.update` on the active turn without closing it:
   ```json
   {
     "id": "evt_3",
     "type": "turn.update",
     "thread_id": null,
     "state": {
       "status": "paused",
       "metrics": {
         "total_tokens": 1350
       }
     }
   }
   ```
4. **Client submits approval event to the active turn**:
   The client submits the decision using `POST /api/v1/sessions/{session_id}/turns/{turn_id}/events`.
   
   *Approval payload (`allow`)*:
   ```json
   {
     "events": [
       {
         "type": "user.tool_approval",
         "thread_id": "main",
         "tool_call_id": "call_1",
         "approval": {
           "status": "allow"
         }
       }
     ]
   }
   ```
   *Denial payload (`deny`)*:
   ```json
   {
     "events": [
       {
         "type": "user.tool_approval",
         "thread_id": "main",
         "tool_call_id": "call_1",
         "approval": {
           "status": "deny",
           "reason": "User rejected this one"
         }
       }
     ]
   }
   ```
5. **Turn resumes and completes**:
   - TrueForge echoes `user.tool_approval` into the SSE stream.
   - TrueForge emits `turn.update` with `state: {"status": "running"}`.
   - **If allowed**: TrueForge invokes the tool on the MCP server and emits `tool.response` with handler output (e.g. `content: "gated echo: one"`).
   - **If denied**: TrueForge skips tool invocation (0 executions) and emits synthetic `tool.response` containing the denial reason (`{"error":[{"type":"text","text":"{\"error\":\"User denied tool call: ...\"}"}]}`).
   - The model generates follow-up tokens (`model.message` / `model.message.delta`).
   - TrueForge closes the turn with `turn.done` (`state: {"status": "done"}`).

### 4.2 Delayed Approval: 10-Minute Live Test vs Committed Fixture
- **Live 10-Minute Test (14 Nov 2026)**: Conducted with `MODE=wait WAIT_MIN=10` using `03-approval.recovered.mjs`. The session paused at `tool.approval_required` and `turn.update` (`status: "paused"`) and was held for 600 seconds. Upon submitting `user.tool_approval` with `allow` via `POST /api/v1/sessions/{session_id}/turns/{turn_id}/events`, TrueForge returned HTTP 201, transitioned the turn to `running`, invoked the MCP handler exactly 1 time, and completed the turn with `turn.done` (`status: "done"`).
- **Committed Fixture**: In `fixtures/events/03-wait-resume-sse.jsonl`, the pause duration was ~60 seconds (`12:45:37Z` to `12:46:37Z`) to maintain reasonable test execution speeds while preserving an immutable record of the delayed resumption event stream.

### 4.3 Class B Finding & Identical-Call Capability Matrix
Because TrueForge does not pass `tool_call_id` to the MCP tool handler (Q14), concurrent duplicate tool calls cannot be individually matched by ID. To verify how TrueForge handles identical concurrent calls, we ran three specified permutations of `03-approval.recovered.mjs` (`MODE=identical`):

| Permutation | Decision Submission Order | Call 1 Decision | Call 2 Decision | Expected Handler Executions | Observed Executions | Fixtures Generated |
|---|---|---|---|:---:|:---:|---|
| **Permutation i** | `[Call 2, Call 1]` | `deny` | `allow` | 1 | 1 | `03b-identical-i-turn1.jsonl`<br>`03b-identical-i-resume-sse.jsonl` |
| **Permutation ii** | `[Call 1, Call 2]` | `deny` | `allow` | 1 | 1 | `03b-identical-ii-turn1.jsonl`<br>`03b-identical-ii-resume-sse.jsonl` |
| **Permutation iii** | `[Call 1, Call 2]` | `allow` | `deny` | 1 | 1 | `03b-identical-iii-turn1.jsonl`<br>`03b-identical-iii-resume-sse.jsonl` |

**Conclusion**: In all permutations, decisions were submitted sequentially via `POST /api/v1/sessions/{session_id}/turns/{turn_id}/events`. Exactly 1 execution occurred whenever 1 call was approved and 1 was denied, regardless of array submission order. However, because the MCP handler cannot distinguish which call was executed, the client engine must treat identical calls as a single grouped proposal item (Correlation Rule).

---

## 5. Streaming, Lifecycle & Cancellation (Q2, Q7, Q8, Q9)

### 5.1 Turn Streaming Lifecycle
Every turn stream conforms to a strict lifecycle:
- Opens with `turn.created` containing `turn_id` and metadata.
- Emits model message headers and incremental text fragments via `model.message.delta`.
- Emits intermediate state updates via `turn.update` (e.g., transitioning to `paused` when approval is required, and returning to `running` upon receiving approval events).
- Closes with exactly one terminal event: `turn.done`.
- Terminal states observed on `turn.done`: `done`, `cancelled`, and `error`.

### 5.2 Cancellation Findings
- **Active Streaming Cancellation**: Calling `POST /api/v1/sessions/{id}/cancel` while a turn is actively streaming terminates generation immediately (~13–28 ms response time). The server emits `turn.done` with `state: {"status": "cancelled"}`. Verified in `04-cancel.jsonl`.
- **Repeated Cancellation**: Issuing a second cancellation request against an already-cancelled session returned **HTTP 200**, confirming the request succeeds without crashing the harness.
- **Paused Cancellation**: Per ADR-04, turns paused at an approval gate are canceled client-side by discarding pending proposals. No server cancellation call is required for paused turns.

### 5.3 Model Error Handling
- Non-existent models (404) and unreachable providers (timeout) do not fail the initial `POST /api/v1/sessions/{id}/turns` request; the endpoint returns HTTP 201 Created.
- The failure appears asynchronously in the SSE event stream as a terminal `turn.done` event with `state: {"status": "error", "message": "..."}`.
- The engine stream parser maps these terminal error states directly to human-readable error notifications in the editor.

---

## 6. Agent Configuration & Manifest Status

### 6.1 Agent Manifest Schema
TrueForge local mode creates agents via `POST /api/v1/agents` using the following verified schema:
```json
{
  "name": "forge-dev-agent",
  "model": "google-gemini/gemini-2.5-flash",
  "instructions": "You are an expert coding assistant...",
  "mcp_servers": [
    {
      "name": "editor-tools",
      "transport": "http",
      "url": "http://127.0.0.1:8792/mcp",
      "headers": {
        "x-forge-token": "..."
      },
      "preload": true,
      "require_approval_for_tools": [
        "gated_echo"
      ]
    }
  ]
}
```
*Notes*:
- The schema spelling `require_approval_for_tools` is snake_case in the raw HTTP REST API, confirmed by the local uncommitted OpenAPI schema `scripts/spike/openapi-local.json`.
- `echo` in `02-mcp-tool.mjs` verified ordinary ungated MCP tool execution, confirming that unlisted tools execute without gating.
- `gated_echo` in `03-approval.recovered.mjs` was the literal tool name verified for the approval-gating pause and resume cycle. Production tools (`proposeEdit`, `createFile`) will be configured in the final manifest once their MCP server handlers are implemented.

### 6.2 Agent Manifest File Status: MISSING
The repository production agent manifest file:
```
forge/agent.spec.json
```
is currently **MISSING** (not yet created or committed). Its authoring is designated as the first implementation task of Developer 1 (Card S-03).

---

## 7. Action Items for Gate G0 Clearance

Gate G0 is currently **IN PROGRESS**. To achieve final clearance before beginning full engine-editor integration, the following actions are required:

1. **Verify Extension Host Reload Across Pause (Q6)**:
   - Run a live session paused at `tool.approval_required`, reload the extension host / restart the engine client, reconnect to the session via `subscribe_to_turn(after_sequence_number)` or `GET /api/v1/sessions/{id}/turns`, and resume by submitting `user.tool_approval` to `POST /api/v1/sessions/{session_id}/turns/{turn_id}/events`.
2. **Inspect TrueForge Web UI Navigation (Q16)**:
   - Open `http://localhost:8790` in a browser.
   - Verify that API-created sessions appear in the Sessions sidebar.
   - Record the exact URL pattern (e.g. `http://localhost:8790/sessions/{session_id}`) for the submission demo video.
3. **Author and Commit `forge/agent.spec.json`**:
   - Create the production manifest pinning model configuration, instructions, loopback MCP server configuration, and explicit `require_approval_for_tools: ["proposeEdit", "createFile"]`.
4. **Complete Comparative Preload Runs (Q17)**:
   - Execute the 3-run matrix comparing `$env:PRELOAD="false"` with `$env:PRELOAD="true"` to finalize documentation on deferred tool discovery.

---
*Report prepared for Forge-a-thon submission pack v2.3.5.*
