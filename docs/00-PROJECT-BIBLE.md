# 00 — Project Bible (single source of truth for the idea)

## 1. One-line pitch
**An editor-native coding agent on TrueForge that investigates a large repo on its own, proposes multi-file changes, lets you review every hunk before anything touches disk, then verifies the result by running tests — on any model.**

## 2. Problem
AI coding tools lose the file you care about, rewrite code you did not ask about, and edit symbols that do not exist. Trust breaks because the human cannot see *what the model saw* or *what it will change* until it is done.

## 3. Primary user
A developer working in an existing or unfamiliar codebase larger than a model's context window.

## 4. Product thesis
> The agent investigates and proposes autonomously. The developer controls every consequential change.

## 5. Seven product principles (design tie-breakers)
1. **Understand before modifying** — explore with tools before proposing.
2. **Autonomy with boundaries** — the agent decides what to read; the human decides what lands.
3. **Context transparency** — "files chosen and why" plus a live budget meter, always visible.
4. **No silent writes** — proposals live in memory; only ApplyManager writes, only after per-hunk acceptance.
5. **Verification on real state** — tests run *after* apply, on disk state that actually contains the accepted hunks.
6. **Permission-controlled execution** — tools and commands run under explicit, separate permissions (accepting a diff ≠ allowing a command).
7. **Recoverability** — cancel, failure, failover and stale files never leave a half-applied workspace; every apply is undoable.

## 6. Core workflow
`Explore → Understand → Propose → Review → Apply → Verify` — all inside **one run** (several TrueForge turns hidden behind one UI run).

## 7. Scope
**In (mandatory 5):** inline edit (Ctrl+K), agent mode, context assembly (@file/@symbol + auto retrieval), diff review (per-hunk + undo), streaming + cancellation.
**In (scoring depth):** approval-driven review via TrueForge tool approval; model fallback via two agents; one context-engineering harness feature; safe terminal; cumulative context budget; retrieval eval on a second repo.
**Out (do not spend time):** tab completion, fine-tuning/hosting models, hosted backend/DB, accounts/auth, Marketplace publishing, embeddings/vector DB, temp-copy sandbox workspace, multi-root workspaces, auto-fix loops without review.
**Stretch (cut first when behind, docs/06 cut line 3):** second-repo retrieval eval, full extension-host e2e matrix.

## 8. What makes it better than a baseline submission
| Differentiator | Why judges notice |
|---|---|
| Review is *driven by* TrueForge `tool.approval_required` (pause → human hunk review → `user.tool_approval`) | Makes B4 = 7+ credible; visible in the session view |
| Edits are search/replace (`proposeEdit`), not whole-file rewrites | Unrelated code stays byte-identical; fits weak models; cheap on tokens |
| Stale-file protection (hash + version snapshot) | Directly answers "never silently overwrite" |
| Budget meter + per-run cumulative cap | B1 anchor 15 is "visible size budget at work" |
| Argv-level terminal policy with 3 tiers | Honest security story instead of a deny-list |
| Model-swap drill (primary, fallback, local weak model) | Organisers may repeat Task A on their model |
| Retrieval eval (recall@k, 2 repos, filename-free prompts) | Evidence, not claims |

## 9. Architecture in 10 lines (details: `01-ARCHITECTURE.md`)
1. VS Code extension = **client** of TrueForge (`localhost:8790` default).
2. Extension hosts a **local MCP server** (streamable HTTP, `127.0.0.1`, token-protected) exposing editor tools.
3. Two saved TrueForge agents: `forge-primary`, `forge-fallback` (different models, same instructions + MCP tools).
4. `proposeEdit`/`createFile` are approval-gated: TrueForge pauses the turn, extension shows hunks.
5. User decisions → ApplyManager writes accepted hunks → engine resumes with `user.tool_approval`.
6. Agent continues, runs allowlisted tests on real disk, reports.
7. Cancel = cancel running turn / discard paused proposals. Nothing was ever written before acceptance.
8. Failover = new session on `forge-fallback`, replay the request; forbidden after any apply.
9. Context = mentions → budgeted seed → capped tools → cumulative cap → `reportContext`.
10. Everything TrueForge-specific is isolated in `ForgeClient.ts` + `eventMapper.ts`.

## 10. Decision log (ADRs)
| # | Decision | Reason | Revisit if |
|---|---|---|---|
| 1 | Start from scratch, no fork | Upstream loops make us ineligible; delta scoring is simpler | never |
| 2 | Approval-gated proposals (blocking design) | TrueForge pauses turns durably; no timeout risk; best B4 | spike Q4/Q5 fail → ADR-2b: stage-then-ack, accept B4=4–7 |
| 3 | Verify **after** apply, on real disk | A temp workspace breaks imports/venvs; costs days | never |
| 4 | `proposeEdit` search/replace + `createFile` | robustness, cost, byte-identical untouched code | weak models fail exact match → add fuzzy whitespace retry |
| 5 | Terminal = argv allowlist, 3 tiers, confirm | blacklist is bypassable; allowlist is permission control, not OS sandbox (say so) | never |
| 6 | Stale check = sha256 + `document.version` snapshot (dirty ≠ stale) | unsaved base edits are legitimate | — |
| 7 | WorkspaceEdit is grouped, **not transactional**; verify after apply; own snapshot undo | VS Code gives no rollback guarantee | — |
| 8 | Lexical BM25F + structure signals, weights configurable in `src/context` | fast, explainable, model-free; embeddings out of scope | recall@k < 0.8 on eval |
| 9 | Fallback = two saved agents, not a harness feature | model is part of the agent definition (to verify Q8) | spike shows native fallback |
| 10 | Raw HTTP/SSE client behind `ForgeClient` (SDK optional) | SDK needs Node ≥ 22.14; VS Code's extension host Node may be older | spike Q13 shows compatible Node |
| 11 | Harness feature = dynamic subagent "explorer" (visible `thread.*` events) | visible in session, small context for main agent | spike Q10 shows it unavailable → deferred tool loading |
| 12 | Cumulative per-run budget counting seed + mentions + tool results (default 30k, scaled by the model's context window, repeats deduplicated) | per-tool caps alone don't bound context; a small model needs a smaller budget | spike shows TrueForge's own compaction makes this redundant |
| 13 | Our MCP server is `preload: true`; approval gated by literal names | SDK default is deferred discovery (weak models may not find tools) and default approval selectors are `@write/@destructive` (F16/F17) | spike Q17 shows deferral is harmless |
| 14 | Per-hunk review has a fallback ladder and panel buttons are always built | CodeLens inside a diff editor is unverified (20 points depend on it) | Day-2 spike shows CodeLens renders |

## 11. Scoring map and honest target
| Criterion | Max | What earns the top anchor | Realistic target |
|---|---|---|---|
| A1 Inline edit | 10 | per-hunk accept/reject in editor | 10 |
| A2 Agent mode | 10 | 3+ files, none named | 8–10 (model dependent, mitigated by retrieval + prompt) |
| A3 Stream/cancel | 10 | immediate cancel, consistent workspace | 10 |
| B1 Context | 15 | budget + strategy + visible in Task B | 13–15 |
| B2 Diff safety | 10 | per-hunk + undo on screen | 10 |
| B3 Resilience | 10 | automatic fallback, workspace unchanged | 10 |
| B4 TrueForge depth | 10 | MCP + approval drives review + context feature | 8–10 |
| C1 Video | 10 | three tasks, verified, legible | 10 |
| C2 Write-up | 15 | arch + context + model + scorecard + honest limits | 14–15 |
| **Total** | 100 | | **~88–98** |

## 12. Definition of "10/10 ready"
- [ ] Gate G0 passed (spike report filled; unknowns resolved or fallback ADR chosen).
- [ ] Contract frozen at G1; CI green; forbidden-pattern greps pass.
- [ ] Tasks A, B, C each succeed 3 of 3 from a **fresh clone** with the primary model, and Task A with a second, different model.
- [ ] Cancel matrix (5 moments) leaves `git status` clean; diff-safety matrix passes; undo verified.
- [ ] Retrieval eval report committed (recall@k, 2 repos, ≥12 filename-free prompts).
- [ ] Video ≤ 4:00 with verification for A, B, C; TrueForge session shown in B.
- [ ] Write-up PDF 1–3 pages, 8 headings in order, scorecard timestamps match the video.
- [ ] Repo public, README works on another machine, LICENSE, example model config (`forge/models.example.json`) + `forge/setup.example.json`, no secrets.
- [ ] Both developers can explain every file in their folders (live call).

## 13. Glossary
Agent (reusable definition) → Session (conversation) → Turn (one request cycle; one active per session) → Event → Delta (streaming fragment). **Pause**: a turn ends with `tool.approval_required`; the client resumes with a new turn containing `user.tool_approval`. **Hunk**: one contiguous change. **Seed**: automatic initial context. **Run**: one user request, possibly many turns.
