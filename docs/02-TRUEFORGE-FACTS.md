# 02 — TrueForge: verified facts, unknowns, and the Day-1 spike

Facts below were read from public TrueForge/TrueFoundry docs and the GitHub repo on 4 Nov 2026; section A2 was added on 5 Nov from the type definitions inside the published npm package `@truefoundry/trueforge-sdk` 0.183.0 (`@truefoundry/trueforge` 0.183.1: MIT, Node ≥ 22.14 re-confirmed). The SDK is labelled **experimental** in its docs and "will have breaking changes", so **pin the version** you spike against and re-check release notes before submitting.

## A. VERIFIED (from docs; still reproduce in the spike)
| # | Fact | Source |
|---|---|---|
| F1 | MIT licence, TypeScript, **Node ≥ 22.14**, packages `@truefoundry/trueforge`, `-core`, `-sdk`, `-ui` | github.com/truefoundry/trueforge |
| F2 | Local mode: `npx @truefoundry/trueforge@latest` — one process, SQLite, no login, keep on localhost; default `PORT` **8790** → `http://localhost:8790` (8791 is the Docker Compose deployment, not `npx` local mode — V2 had this wrong; confirm in the startup log during the spike) | TrueForge CONTRIBUTING.md + config reference (PORT default 8790; compose on 8791) |
| F3 | Hierarchy Agent → Session → Turn → Event → Delta. **One turn runs at a time per session; creating a new turn while one runs cancels it.** Turns chain via `previous_turn_id: "auto"` | TrueFoundry blog + SDK docs |
| F4 | Turn SSE stream always opens with `turn.created` (carries `turn_id`) and closes with `turn.done` (state `done`/`cancelled`/`error`, final `output` or `required_actions`) | turn events reference |
| F5 | Every event has `id`, `thread_id` (`"main"` for root, sub-agent id, or null for turn-level), `created_at`; streamed events also `sequence_number` | turn events reference |
| F6 | `model.message` base event then `model.message.delta` fragments sharing its `id`; merge in place; `list_events` returns merged events | SDK overview |
| F7 | **No top-level `tool.call` event**; requested calls are on `model.message.toolCalls`; `tool.response` has `tool_call_id` + `content` | agent-events explainer |
| F8 | Gated tool → harness emits `tool.approval_required`, **ends the turn**, waits. Resume with a new turn whose input has one `user.tool_approval` per pending call: `{type:"user.tool_approval", thread_id, tool_call_id, approval:{status:"allow"}|{status:"deny", reason?}}`. Deny → reason used as the tool result | HITL doc + runtime API reference |
| F9 | `tool.response_required` (client-side tool) and `mcp.auth_required` are also pauses; MCP auth resume needs empty input | same |
| F10 | Stream reconnect: `subscribe_to_turn(after_sequence_number)`; `cancel` on a session cancels the running turn and is **idempotent**; `list_turn_events` for completed turns | runtime API reference |
| F11 | Models: catalog providers (OpenAI, Anthropic, Gemini…) **or any OpenAI-compatible endpoint** (add provider with base URL) | README, local-models article |
| F12 | MCP: remote servers (streamable HTTP) registered by URL with header auth or OAuth; Settings → Connectors → *Add MCP Server*; also an API/SDK path (MCP Servers resource) | quickstart, API reference groups |
| F13 | Context features: subagents (dynamic sub-agents toggle), deferred tool loading, Code Mode, large-tool-response offloading, compaction; runtime toggles in the agent builder (several default ON); some need the optional sandbox | README, overview |
| F14 | Release notes mention MCP tool annotations and "destructive-tool detection" — approval may be driven by annotations as well as agent config | releases |

## A2. VERIFIED from the SDK type definitions (v2.3.4; re-checked 11 Nov 2026 on `@truefoundry/trueforge-sdk` 0.184.1: F15, F16, F17, F19 unchanged; `@truefoundry/trueforge` is at 0.184.2) — pin the exact versions and still capture fixtures in the spike
| # | Fact | Consequence |
|---|---|---|
| F15 | `tool.approval_required` = `{id, createdAt, threadId, toolCalls: [{id, sourceEventId}]}`. **No tool name and no arguments.** `sourceEventId` is the `model.message` that requested the call | Engine resolves name + args from the merged `model.message.toolCalls` via `sourceEventId`; this is the PRIMARY path, not a fallback (answers Q4) |
| F16 | Approval gating is configured **per MCP-server entry of the agent**: `requireApprovalForTools` accepts `@all`, `@write`, `@destructive` or literal tool names; **default `["@write","@destructive"]`** | Set literal names `["proposeEdit","createFile"]` explicitly (answers Q15). SDK field names are camelCase; confirm the raw-HTTP spelling in the spike |
| F17 | Same entry: `preload` (**default false = deferred tool discovery**), `preloadTools`, `enableTools`, `disableTools` | Set `preload: true` for our server (ADR-13). Deferral only for rarely used tools if we choose it as the B4 feature |
| F18 | Stream `turn.done.state` ∈ done / cancelled / error. A finished turn that needs actions carries `requiredActions`; a separate `paused` status carries `actionRequiredOnEvents` | `mapTerminal` reads BOTH field names and treats them identically |
| F19 | The inbound item `user.tool_approval_policy` with `{type:"allow_session"}` exists and would auto-allow a tool for the session | **Never send it** (it would skip our review). CI greps for `tool_approval_policy` (docs/03 T13) |
| F20 | `previous_turn_id` defaults to `auto`; `sessions.cancel` cancels the running last turn ("only the creator may cancel": fine in local mode) | Nothing to do; consistent with F3/F10 |

## B. UNVERIFIED — the spike must answer (each has a fallback)
| Q | Question | If answer is bad → |
|---|---|---|
| Q1 | Exact base path/auth of the HTTP API in local mode; SDK vs raw HTTP | raw HTTP via OpenAPI at trueforge.dev/api-reference |
| Q2 | Create agent (manifest fields: model, instructions, MCP servers+tools, approval config) and create session/turn from code; save one raw stream to `fixtures/events/` | Discord #help; use UI to create agents, document manifest JSON |
| Q3 | Can TrueForge (local) call an MCP server at `http://127.0.0.1:<port>/mcp` with a custom auth header registered **via API**? Does it accept dynamic ports (re-register)? | try `localhost`; fixed port; ask Discord. No MCP = ineligible → raise via portal "Doubt" section **immediately** |
| Q4 | **(Answered by F15/F16; still capture the raw fixture.)** How is a tool marked approval-required (agent spec per tool? MCP annotation? global)? Raw `tool.approval_required` payload: does it include tool name **and arguments**? | if no args: read args from merged `model.message.toolCalls` for that `tool_call_id` |
| Q5 | Several `proposeEdit` calls in one model message → several pending approvals in one turn? Resume with N items in one turn? What happens to *non-gated* calls in the same message (executed before pause?) | if sequential only: review per file, still one apply group per resume batch |
| Q6 | Is a paused session still resumable after 10+ min (human review time) and after extension reload? | document limitation; offer "Resume" later |
| Q7 | Cancel API during streaming; behaviour when no turn is running (paused) | treat paused-cancel as local discard + new session |
| Q8 | Two agents with two models; how do invalid key / unreachable endpoint / rate limit surface (HTTP status on create-turn vs `turn.done` state `error` with message)? | classify on both channels; write mapping table into spike report |
| Q9 | Token granularity of deltas; are tool-call args in deltas complete only at the end? | act on merged event only |
| Q10 | Runtime toggles default state; is dynamic sub-agents available without sandbox? Do `thread.created/done` events show in the stream for a sub-agent? | choose deferred tool loading or compaction; capture evidence either way |
| Q11 | Maximum MCP tool result size accepted; timeouts per tool call | lower caps |
| Q12 | Does the extension host's Node version satisfy the SDK? (`process.version` in the extension host) | raw HTTP client (ADR-10) |
| Q13 | Ports 8790/8792 free? Behaviour if TrueForge already running from a previous `npx`? Read the real URL from the startup log. | `forge.baseUrl` setting + health probe (probe 8790 first, then 8791, and show which one answered) |
| Q14 | Does an MCP `tools/call` request from TrueForge carry anything that identifies the session/thread/`tool_call_id` (e.g. `_meta`, extra header)? If not, the MCP handler only sees tool name + args. | If yes → exact lookup by call id. If no → argsHash lookup over live records, made safe by grouping identical calls (01 §4.1 Correlation rule). No ordering assumption either way. |
| Q15 | **(Answered by F16; confirm the raw-HTTP field spelling.)** Is approval configurable per tool **by name** in the agent manifest (`require_approval_for_tools`: `proposeEdit`, `createFile`)? Prefer explicit names over relying on annotations (F14). | Set by name; keep annotations as a second signal |
| Q16 | Do sessions created **through the API** appear in TrueForge's own Sessions UI with turns, tool calls, approvals and sub-agent threads? (The eligibility gate requires the video to show the TrueForge session for Task B.) | If hidden: find the URL/route to open a session by id, or create the session via the UI-compatible endpoint; decide before G0 |
| Q17 | With the default `preload:false` (deferred discovery) does the agent find and call `readFile` unaided on a weak model? With `preload:true`? Record 3 runs each | Keep `preload:true`; deferral only for rare tools |

## C. Spike protocol (S-02 card; both devs, first half-day, then Dev 1 finishes)
Deliverables: `docs/spike-report.md` (every Q answered with evidence), `fixtures/events/*.jsonl` (raw samples: plain text turn, tool call + response, approval_required, resume allow, resume deny, cancelled, invalid-key error, unreachable error, sub-agent thread), `scripts/spike/*.ts` (rerunnable).
**Gate G0 (end of Day 1 or Day 2 at the latest):** Q2, Q3, Q4, Q5(or sequential fallback), Q7, Q8, Q16 resolved; Q17 recorded.
**Cut rule:** if Q3 or Q4 are unresolved at end of Day 2 → ask organisers via the portal and Discord, switch to ADR-2b (stage-then-ack, B4 capped), and protect Tasks A/B/C + cancel + undo.
