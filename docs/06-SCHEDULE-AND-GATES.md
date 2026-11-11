# 06 — Schedule, gates, cut lines, risks

Plan started **Wed 4 Nov 2026** (Day 1); this pack (v2.3.5) is dated **Wed 11 Nov (Day 8)**; the table below is the ORIGINAL plan and the re-baseline section underneath is what applies from today. Registration closes **15 Nov**. Submission deadline **Fri 20 Nov 23:59 IST**. Plan to submit **Wed 18 Nov**; 19–20 Nov are emergency buffer only (never planned work).
Both devs: confirm registration + Team ID **today**.

| Day | Date | Dev 1 (Engine) | Dev 2 (Editor) | Gate / integration check |
|---|---|---|---|---|
| 1 | Wed 4 Nov | S-01 bootstrap, **S-02 spike** | S-01 scaffold, spike help, U-01 hunkText | **G0** spike answers (EOD or D2 noon) |
| 2 | Thu 5 | contract v2 amend from spike → **G1 freeze** (morning); E-01 ForgeClient, E-02 mapper | U-02a CodeLens-in-diff spike (20 min, docs/01 §7.1) then U-02 DiffReviewer+CodeLens, U-04 UiHost skeleton | G1 frozen; real tokens stream into Output channel |
| 3 | Fri 6 | E-03 orchestrator, E-04 MCP + read tools | U-03 ApplyManager+Undo | **Cut line #1** (see below) |
| 4 | Sat 7 | E-05 ProposalStore/proposeEdit, E-06 approval bridge | U-05 Ctrl+K, EventRouter | **I-1: Task A end-to-end** |
| 5 | Sun 8 | E-07 prompts/agent def/loop guards | U-06 indexer+ranker | agent proposes 1 file via approval |
| 6 | Mon 9 | E-08 cancel, E-10 terminal policy | U-07 ContextProviderImpl, U-08 panel | cancel matrix 1–3 pass |
| 7 | Tue 10 | tune Task B; budget cap | U-09 multi-file batch apply | **I-2: Task B first 3-file diff** |
| 8 | Wed 11 | E-11 harness feature; E-09 resilience | U-10 eval harness + second repo | Task B 2/3 |
| 9 | Thu 12 | E-09 finish, chaos drills | U-11 cancel/failure UX + e2e | **I-3: Task C** |
| 10 | Fri 13 | E-12 live integration + verify scripts, security tests | perf, a11y, polish; eval report | model-swap drill |
| 11 | Sat 14 | integration + regression day (no new features) | same | **G5 feature freeze EOD; fresh-clone rehearsal #1** |
| 12 | Sun 15 | P0/P1 fixes; README; write-up §1,2,3,5,7,8 | P0/P1 fixes; write-up §4,6 draft | **registration closes** (must be done) |
| 13 | Mon 16 | rehearsal #2 (3× each, other machine) | video rough cut | all ATs 3/3 |
| 14 | Tue 17 | final video record + write-up PDF | same | |
| 15 | Wed 18 | submit; verify links logged-out | submit | **G6 submitted** |
| – | 19–20 | emergency only | | |

## Gates
- **G0 Spike done** (see 02 §C). **G1 Contract frozen** (joint PR, version bumped to 2.1.0). **G5 Feature freeze** (Sat 14 EOD; after: P0/P1 only). **G6 Submitted.**

## Cut lines (in order of protection)
1. If by end of **Day 2** the real session + MCP registration + approval pause/resume don't work → ADR-2b (stage-then-ack), drop explorer subagent, protect Tasks A/B/C.
2. If Task B < 2/3 on **Day 8** → freeze scope: prompt/tool-description tuning + retrieval only; drop harness feature if it destabilises.
3. If behind on **Day 8–10** → FIRST drop the STRETCH items: U-10's second repo (keep 12 Flask cases, report honestly) and U-11's full extension-host matrix (keep automated diff-safety + cancel unit tests and one manual run of each matrix item that appears on camera). THEN drop fuzzy retry, a11y polish, second local-model drill (keep the cancel matrix, undo, fallback).
4. Never cut: per-hunk review, undo, clean cancel, fallback, video quality, write-up scorecard honesty.

## Risk register
| # | Risk | P | I | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | TrueForge can't reach local MCP / approval semantics differ | M | H | spike Q3/Q4, Discord, ADR-2b | D1 |
| R2 | SDK experimental, breaking changes | M | M | pin versions, ForgeClient isolation, fixtures | D1 |
| R3 | Extension-host Node < SDK requirement | M | M | raw HTTP client | D1 |
| R4 | Weak/other model fails tool use in live call | M | H | simple schemas, short descriptions, retry-on-invalid-args, model-swap drill | D1 |
| R5 | Retrieval overfits Flask | M | H | second repo, held-out eval, no hardcoding | D2 |
| R6 | Stale/partial apply bugs | L | H | matrix tests, verify-after-apply, snapshot undo | D2 |
| R7 | Editor freezes during indexing/streaming | M | M | chunking, lag measurement | D2 |
| R8 | Merge conflicts | M | L | ownership, daily PRs, contract frozen | both |
| R9 | AI-generated code nobody understands | M | H | nightly explain ritual, notes, live-call prep | both |
| R10 | Video re-record needed late | M | M | rehearse, record D14, buffer D15 | D2 |
| R11 | Fallback model also misconfigured on demo day | L | H | two agents tested daily; drill script | D1 |
| R12 | Time lost on polish | H | M | G5 freeze | both |
| R13 | CodeLens does not render in `vscode.diff` (per-hunk review = 20 pts) | M | H | Day-2 spike, fallback ladder docs/01 §7.1, panel per-hunk buttons always built | D2 |
| R14 | Deferred MCP tool discovery makes weak/organiser models miss our tools | M | H | `preload: true`, Q17, model-swap drill | D1 |
| R15 | API-created sessions not visible in TrueForge's UI (gate wants the session on camera) | L | H | Q16 at G0; find the session route or create via the UI-compatible path | D1 |

## Round 2 preparation (16–18 Dec 2026, on campus; bring the photo ID used at registration)
Round 2 includes a pull request to github.com/truefoundry/trueforge (a harness contribution, reviewed as part of the score). TrueForge's CONTRIBUTING asks for issue reports and analysis over large code changes and says fork PRs change source only, so aim for ONE small, well-evidenced PR (a doc fix, a bug fix with a failing test, or a clearly specified improvement). Start now: keep `docs/friction-log.md` from the spike onward (every doc gap, surprising behaviour, error message or missing API field, with the exact reproduction). After G6 (18 Nov) pick the best entry and read CONTRIBUTING.md. Do not spend Round 1 time on it.

## Questions for the organisers (portal "Doubt" section; email is not answered)
1. Task C wording: "a second model takes over automatically" and "`git status` shows no files changed". We read this as: the fallback's diff is shown and deliberately NOT applied. Is that the intended reading?
2. Task B: where should "the TrueForge session" be shown: TrueForge's own Sessions UI at the local URL? (Ask only if Q16 shows a problem.)
3. Is a second TrueForge agent for the fallback model acceptable as "a second configured model" (rather than native model fallback)?

## Daily ritual (15 min morning, 10 min evening)
Morning: `git pull`, read yesterday's notes, agree the day's cards. Evening: merge PR by 9 pm, run the day's integration check on `main`, each dev pastes the AI's "what changed / what could go wrong" into `docs/notes-devN.md`.

## Re-baseline from Wed 11 Nov (Day 8) — applies if the spike and G1 are not yet done
Nothing in this archive proves Gate G0 passed (no `docs/spike-report.md`, empty `fixtures/events/`). Treat G0 as **open** until the spike report exists with raw fixtures. Remaining calendar: 11-14 Nov (4 days to the original G5), 15 Nov registration closes, 16-17 Nov record and write up, **submit by Wed 18 Nov**, 19-20 Nov emergency only.
| Day | Date | Must happen (both devs) |
|---|---|---|
| 8 | Wed 11 | **Today:** registration + Team ID, S-01 bootstrap, S-02 spike, decide ADR-2b by tonight if Q3/Q4/Q16 fail. Dev 2: U-01, then U-02 CodeLens 20-minute spike. |
| 9 | Thu 12 | G1 contract freeze (morning). Dev 1: E-01-E-03. Dev 2: U-02, U-03, U-04. |
| 10 | Fri 13 | Dev 1: E-04-E-06. Dev 2: U-05 and U-08 (panel). **I-1 Task A end to end by night.** |
| 11 | Sat 14 | Dev 1: E-07, E-08, E-10. Dev 2: U-06, U-07, U-09. **I-2 first Task B diff.** |
| 12 | Sun 15 | Dev 1: E-09 resilience. Dev 2: polish the three tasks. **Feature freeze at end of day (G5, moved from Sat 14).** Registration closes. |
| 13 | Mon 16 | Rehearse A/B/C 3x from a fresh clone; model-swap drill; fix P0/P1 only. Write-up drafts. |
| 14 | Tue 17 | Record video, finish write-up PDF. |
| 15 | Wed 18 | Submit; open all three links logged-out. |
Cut harder than the original plan: **U-10 (second-repo eval) and U-11 (full e2e matrix) become minimum versions**, E-11 (explorer sub-agent) only if Task B already passes 2 of 3, and E-12 is reduced to the verify scripts plus the adversarial suite items that guard review and secrets. Never cut: per-hunk review, undo, clean cancel, fallback, video, honest write-up. If Q3 (MCP) fails and the organisers cannot help, ADR-2b is mandatory.
