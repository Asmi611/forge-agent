# 08 — What changed from the v1 guides and why (every correction)
(The v1 `forge-agent.zip` skeleton and the v1 Developer 1/2 PDFs are SUPERSEDED. The beginner guides in `guides/` were regenerated for v2.3.5 and embed the current cards.)

| # | v1 said | v2 does | Why |
|---|---|---|---|
| 1 | TrueForge API "unknown", guessed `/sessions`, `/health` | Verified facts (02 §A) + spike with fallbacks | Docs exist: hierarchy, SSE, approvals, cancel |
| 2 | Staging returns immediately; "approval bridge" vague; tests need a second turn | **Approval-gated tools**: pause → hunk review → `user.tool_approval`; one logical run | Matches TrueForge HITL semantics; B4 7→10 potential; verify loop in one run |
| 3 | `proposeWrite` = full file content | `proposeEdit` (search/replace, exact-once) + `createFile` | Byte-identical untouched code, fewer tokens, weak-model friendly, no truncation of 1000-line files |
| 4 | Contract events `turn.*`, `ToolName` with `executeTerminalCmd(cmd:string)` | `run.*` events; `runCommand{file,args[]}`; snapshots; `ReviewResult` batches | Shell strings can't be allowlisted; runs span turns |
| 5 | Deny-list for terminal | Argv allowlist, 3 tiers, confirm, env scrub; honest "not a sandbox" | Deny-lists are bypassable |
| 6 | Stale check: compare to originalContent / dirty warning | sha256 + version snapshot at proposal; reject on change; dirty ≠ stale; verify after apply | Correctness and honesty |
| 7 | "WorkspaceEdit is atomic" | grouped, not transactional; verify-after-apply + snapshot undo | VS Code gives no rollback guarantee |
| 8 | Weights in `config.ts` (Dev 1 file) | `src/context` + `contributes` settings | Ownership |
| 9 | Retrieval tested on invented trees | Real second repo, ≥12 filename-free prompts, held-out split, recall@k report | Evidence |
| 10 | Only per-tool caps | + cumulative per-run budget with meter | Bounded context, visible B1 |
| 11 | Fallback "new session, resend" without constraints | Forbidden after any apply; two saved agents | No double-apply |
| 12 | SDK assumed usable | Raw HTTP client allowed (Node version risk) | SDK needs Node ≥ 22.14; extension host may differ |
| 13 | Harness feature "pick one" | Explorer subagent default, deferred tools fallback, with visibility check | B4 evidence on camera |
| 14 | 13-day plan, thin slack | 15-day plan from 4 Nov with gates, cut lines, submit D15 | Real calendar; 19–20 Nov buffer |
| 15 | Guides written for humans to type prompts | Prompt cards for Claude Code/Gemini CLI with ownership, plan-first, acceptance tests | Agents do the coding |
| 16 | Local mode security ignored | localhost-only warning, MCP token + Host check, secret-file guard | Local mode has no login |

# V2.1 patch (5 Nov 2026) — corrections from the external audit, each re-verified against the pack
| # | Finding | Verdict | Change |
|---|---|---|---|
| 17 | Local TrueForge URL was `:8791` | **Confirmed.** `PORT` default is 8790; 8791 is Docker Compose | baseUrl, docs 00/01/02; Q13 probes 8790 then 8791 |
| 18 | CI pattern `applyEdit` also matches pure `applyEdits()`; E-05 acceptance grep had the same flaw | **Confirmed** | `\bapplyEdit\b` in ci.yml and E-05 |
| 19 | Decision key `sha256(path+edits)` not unique | **Confirmed**, but audit's `tool_call_id` key may be unavailable inside the MCP handler | Engine keys by session:thread:toolCallId; handler resolves via args-hash lookup (FIFO wording removed in V2.3), one-time consumption; new Q14 |
| 20 | `saveAll(false)` saves unrelated dirty tabs | **Confirmed** | Save only modified docs, check results |
| 21 | Task C `git status` clean impossible after A/B in one repo | **Confirmed** | Separate worktrees in 07 |
| 22 | Per-call lifecycle states | Partly (design already had run-level states) | §4.5 + `ToolCallState` type |
| 23 | Rollback failure unhandled | **Confirmed** | Recovery file, verified restore, `restore_failed` |
| 24 | No Workspace Trust gate | **Confirmed** | T12, `UiHost.isWorkspaceTrusted()`, E-10 gate |
| 25 | Agent cannot run `flask … config` | **Valid but minor** — pack already has the human run it | Documented; allowlist NOT widened |
| 26 | Multi-window MCP collision | **Plausible, low impact** for a single-window demo | Workspace-specific connector name; spike check, not P1 |
| 27 | Approval config by tool name | Reasonable | Q15: configure `proposeEdit`/`createFile` by name |
Not adopted: the audit's score estimates (83–97) are speculation, and its file counts (35 files, 13 cards per dev) do not match this archive (25 files; an earlier line of this log said 26, which was my miscount).

# V2.2 patch (5 Nov 2026) — second audit round, re-verified
| # | Finding | Verdict | Change |
|---|---|---|---|
| 28 | FIFO correlation unsafe for identical concurrent calls | **Confirmed**, and a related hole found: a denied call never reaches the MCP handler, so its record would linger and be picked up by a later identical call | Group identical calls per batch (one decision for all); close records on deny/response/cancel; ambiguity returns an error, never a guess; S-02 `03b` probes the harness; grouping is mandatory regardless (V2.3 removed all FIFO wording) |
| 29 | S-02 said Q1–Q13 | **Confirmed** | Q1–Q15 + `03c` |
| 30 | Contract version / G1 text said 2.0.0 | **Confirmed** | `2.1.0-draft1`; S-03 and schedule say 2.1.0 |
| 31 | Schedule "today = 4 Nov", README "v2" | **Confirmed** (cosmetic) | Updated |
| 32 | Log said 26 files, archive has 25 | **Confirmed** (my error) | Corrected |
| 33 | Mixed CRLF/LF files altered | **Confirmed** — applyEdits and hunk reconstruction restored a single EOL style | EOL-insensitive match on original text, per-line terminators, mixed-EOL tests (E-05, U-01, 05-TESTING) |

# V2.3 patch (5 Nov 2026) — third audit round, re-verified
| # | Finding | Verdict | Change |
|---|---|---|---|
| 34 | FIFO still prescribed in E-05, §4.1, Q14 alongside grouping | **Confirmed** — real internal contradiction | One authoritative Correlation rule in 01 §4.1; E-05, Q14 and S-02 rewritten to match; no FIFO, no ordering assumption |
| 35 | S-02 `03b` mixes harness probe with product policy | **Confirmed** | `03b` labelled a capability probe with result classes A/B/C; grouping mandatory whatever it shows |
| 36 | Contract version draft→release unclear | **Confirmed** | README + S-03 state `2.1.0-draft1` is pre-freeze; the G1 PR sets `2.1.0` |
| 37 | CI/contract "not runnable from ZIP" | Fair, by design (S-01 creates the scaffold). Contract compile claim now **checked**: `tsc --strict --noEmit` passes | README states which checks need the S-01 scaffold |

# V2.3.1 patch (5 Nov 2026) — fourth audit round, re-verified
| # | Finding | Verdict | Change |
|---|---|---|---|
| 38 | `resolveForHandler` lacked sessionId/threadId needed by the composite key | **Confirmed** | "Lookup context" in 01 §4.1: store scoped to the active run supplies sessionId; threadId optional with ambiguity error; E-05 signature updated |
| 39 | argsHash defined only for `proposeEdit` edits | **Confirmed** | Per-tool argsHash (tool name + path + payload: edits or content); createFile tests added |
| 40 | README/schedule still said v2.2 | **Confirmed** (my miss in V2.3) | Updated to v2.3 |

# V2.3.2 patch (5 Nov 2026) — fifth audit round
| # | Finding | Verdict | Change |
|---|---|---|---|
| 41 | README/schedule labels lagged the patch version | **Confirmed** | Entry docs and README now say v2.3.2 (later patches: see below) |
| 42 | Exact call-id lookup should validate args against stored hash | **Confirmed** | Validation on every lookup path; mismatch → error, `args_mismatch`, record not consumed; test added |

# V2.3.3 patch (5 Nov 2026) — sixth audit round
| # | Finding | Verdict | Change |
|---|---|---|---|
| 43 | Two hash definitions in 01 §4.1 | **Confirmed** | Per-tool `argsHash` declared the sole hash; legacy form marked superseded |

# V2.3.4 patch (5 Nov 2026) — SDK type verification + gap review against the organisers' PDF
Method: read the published `@truefoundry/trueforge-sdk` 0.183.0 type definitions (npm) and the repo README/CONTRIBUTING, then re-read the PDF requirement by requirement. trueforge.dev itself was not reachable from the reviewing sandbox, so HTTP paths, the MCP registration API and runtime toggles remain spike items.
| # | Finding | Verdict | Change |
|---|---|---|---|
| 44 | PDF requires "an example model configuration file"; `setup.example.json` had no model fields and E-01 read model ids from a file that had no such field | **Confirmed** | New `forge/models.example.json` (+ gitignored `models.local.json`), E-01/README/07/00/S-05 aligned |
| 45 | Per-hunk review (A1+B2 = 20 pts) depends on CodeLens rendering in `vscode.diff`; unverified, no fallback | **Valid risk** | U-02 starts with a 20-min spike; fallback ladder docs/01 §7.1; panel per-hunk buttons always built; R13, ADR-14 |
| 46 | SDK: MCP entry `preload` defaults to false (deferred discovery); pack never set it | **Confirmed in SDK types** | `preload: true`, F17, Q17, ADR-13, R14; E-01/E-11 updated |
| 47 | Nothing checked that API-created sessions show in TrueForge's UI (the gate requires the session on camera) | **Valid gap** | Q16 in G0, S-02 `08-sessions-ui`, R15 |
| 48 | Run budget counted tool results only; seed/mentions uncounted; not tied to model window; repeats re-charged | **Confirmed** | One `RunBudget` for seed + mentions + tools, scaling by `modelContextTokens`, dedupe, reset on failover (docs 01/04, E-03/E-04/E-09, ADR-12, U-08 meter) |
| 49 | Scorecard template merged C1/C2; PDF says one row per criterion | **Confirmed** | 9 rows in docs/07 |
| 50 | STRETCH work (second-repo eval, full e2e matrix) not on the cut line | **Judgement** | Cut line 3 rewritten; U-10/U-11 marked STRETCH with minimums |
| 51 | Round 2 (PR to the TrueForge repo, on campus 16–18 Dec) unplanned | **Confirmed** | docs/06 Round 2 section, `docs/friction-log.md` from the spike |
| 52 | Task C: clean `git status` after a successful fallback only works if the diff is not applied; unreachable-endpoint retries cost video time | **Valid** | Caption + invalid-key drill (07, 05, U-13), question for the organisers (06) |
| 53 | SDK facts: approval event carries only ids (Q4 answered), approval selectors and default (Q15 answered), `paused` status field names, `user.tool_approval_policy` would bypass review | **Verified in SDK types** | docs/02 A2 (F15–F20), docs/03 T13 + CI grep, E-01/E-02 |
| 54 | Hygiene: PDF needs its own public link; baseline `pytest` run; native-Windows check; S-01 did not say to copy the pack into the repo first | **Valid** | docs/07 checklist, docs/05, README, S-01/S-02 |

# V2.3.5 patch (11 Nov 2026) — review of v2.3.4, each point re-verified
| # | Finding | Verdict | Change |
|---|---|---|---|
| 55 | Grouped identical calls: `FileProposal` had one `callId` | **Confirmed — a real contract gap** | `callIds: string[]` added (`callId === callIds[0]`); "Grouped proposal mapping" in docs/01 §4.1; E-05/E-06 and tests; contract is `2.1.0-draft2` |
| 56 | Failover needs deterministic outcomes and tests for every case | **Confirmed** (tests existed for some cases only) | Outcome table in docs/01 §6 (6 rows); E-09 requires one test per row |
| 57 | Security guarantees need adversarial tests, not only greps | **Confirmed** | "Adversarial security suite" in docs/05; E-12 and U-11 reference it (webview injection test) |
| 58 | `forge-editor-<hash>` (docs) vs fixed `forge-editor` (setup.example.json) | **Confirmed, and deeper**: an agent names its MCP server, so per-window names also need per-window agents | Default fixed name (`mcp.perWorkspace:false`); optional per-workspace mode suffixes connector AND agents; docs/01 §3, forge/README, setup example, E-01 |
| 59 | CODEOWNERS placeholders | **Valid** (intentional placeholders, but easy to forget) | README step, S-01 "Human first" line, non-blocking CI warning |
| 60 | Schedule not reconciled with today (Day 8); G0 unproven from the archive | **Confirmed** | Re-baseline table in docs/06 (G5 moved to Sun 15, stretch cards reduced, submit Wed 18) |
| 61 | Review: TrueForge integration unverified (Q1-Q17), 8.7/10 | **Agreed, not fixable in documents**: only the S-02 spike with real fixtures proves it. Scores are the reviewer's opinion, not adopted | none (spike stays the first job) |
| 62 | (own finding) Gemini CLI advice stale: free sign-in ended 18 Jun 2026; Freebuff privacy caveats absent | **Confirmed** | Tool-neutral wording in README, ai-guides/00, AGENTS.md, GEMINI.md; SDK pin note (types re-checked on 0.184.1) |

## V2.3.5 post-review corrections (11 Nov 2026, no architecture change)
- CI: restored the `innerHTML` and secret-pattern greps to the `forbidden patterns` step (they had been absorbed into the CODEOWNERS step string).
- Bootstrap card: commit message now `chore: add pack v2.3.5`; two duplicate human instructions merged into one.
- forge/README.md: SDK verification heading updated to v2.3.5 with actual versions.
- Still open: validate G0 with real event fixtures; freeze the contract only after both developers agree.

