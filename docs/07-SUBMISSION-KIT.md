# 07 — Submission kit (video, write-up, README, checklist, live-call prep)

## Demo workspaces (V2.1 — do this before recording)
Tasks A, B and C each dirty the repo, so a single checkout makes the Task C and Stop `git status` claims meaningless. Create three worktrees pinned to the same Flask 3.1.3 commit and open one per segment:
`git worktree add ../flask-A <tag>` · `../flask-B` · `../flask-C` (plus `../flask-stop` for the Stop segment, or `git restore .` and show `git status` clean before it). Record the commit SHA in the write-up. The `git status` shots then show: C and Stop clean because nothing was applied, A and B changed only by accepted hunks.

## Video script (≤ 4:00; zoomed editor; exact task wording pasted from a file)
| Time | Shot | Evidence for |
|---|---|---|
| 0:00–0:12 | Voice/caption: what it is. Split screen: TrueForge terminal + VS Code on Flask 3.1.3, `git status` clean | C1 |
| 0:12–1:05 | **Task A**: select `get_debug_flag` → Ctrl+K → paste exact instruction → (no cut) diff appears → accept hunks individually → Apply → terminal prints `False` → press Undo, then redo quickly | A1, B2 |
| 1:05–2:45 | **Task B**: paste exact instruction (no mentions) → tool timeline + "Files chosen and why" + budget meter → TrueForge session tab (turns, tool calls, `tool.approval_required`, explorer thread) for ~10 s → multi-file review (source, test, docs) → accept hunks → Apply → agent runs `pytest` (confirm prompt shown) → run `pytest tests/test_cli.py -q` → run `flask --app … config` showing `"***"` | A2, B1, B4, A3 |
| 2:45–3:35 | **Task C**: break primary key (INVALID key: instant failover) → repeat Task A → "retrying/failover…" → failover toast → diff appears from fallback, with an on-screen caption "fallback diff shown — deliberately not applied" → `git status` empty | B3 |
| 3:35–3:55 | **Stop** mid-stream → cancelled → `git status` clean; editor still typing/scrolling | A3 |
| 3:55–4:00 | Closing caption | |
Rules: don't cut between instruction and diff; model waiting may be cut elsewhere; 1080p; big font; hide notifications; note timestamps live.

## Write-up (PDF, 1–3 pages) — fill these exactly, in order
1. **Team** — names, college/employer, GitHub handles, team name.
2. **Starting point** — "From scratch." Key libraries + licences (TrueForge MIT, diff, MCP SDK, vitest…).
3. **Architecture on TrueForge** — paste the diagram from 01 §1; extension = client; MCP tools table; approval-gated proposals (`tool.approval_required` ↔ `user.tool_approval`); run state machine in 3 lines; harness feature used + why + what it improved (with session evidence timestamp).
4. **How context is selected** — layers/budgets table (04); retrieval method; eval numbers (recall@k) and one honest failure case.
5. **Model setup** — table: model | where it ran | role (primary/fallback/drill) | approx cost; how to switch (`Forge: Switch Model`, two TrueForge agents).
6. **Scorecard** — table: criterion | video timestamp | one-line claim. **One row per judging criterion: A1, A2, A3, B1, B2, B3, B4, C1, C2 (9 rows).** Only claim what the video shows.
7. **Tools used** — Claude Code / Gemini CLI / others, libraries, Flask 3.1.3, OBS.
8. **Known limitations & next month** — be specific: allowlist ≠ sandbox; token estimate chars/4; lexical retrieval; single-root workspace; paused session lost on window reload; Ctrl+K chord conflict; SDK experimental. Next: embeddings reranker, sandboxed verification, resume after reload, multi-root.

## Scorecard template
| Criterion | Time | Claim |
|---|---|---|
| A1 | __:__ | Ctrl+K renders in-editor diff; per-hunk accept/reject |
| A2 | __:__ | Agent found and edited N files (src, test, docs) without any being named |
| A3 | __:__ | Tokens stream live; Stop is immediate; `git status` clean |
| B1 | __:__ | Seed ≤ budget; panel lists files + reasons; cumulative budget meter |
| B2 | __:__ | Per-hunk review before any write; Undo restores files |
| B3 | __:__ | Primary failed → automatic fallback; workspace unchanged |
| B4 | __:__ | Editor tools as MCP; TrueForge tool approval drives review; explorer subagent visible |
| C1 | whole video | Tasks A, B, C in order, each verified on screen, legible |
| C2 | n/a | This document: architecture, context strategy, model setup, trade-offs, scorecard, honest limitations |

## Repo README must contain
What it is · fork point: **"From scratch"** · prerequisites (Node ≥ 22.14, Python 3.10+, VS Code) · 5-minute setup from clean clone · how to start TrueForge (`npx @truefoundry/trueforge@latest`) · how to create the two agents (`npm run forge:setup` script that creates/updates `forge-primary` and `forge-fallback` from `forge/agent-instructions.md` + models) · how to add models (TrueForge UI → model provider; **keys never in repo**) · `forge/setup.example.json` + `forge/models.example.json` (the example model configuration; keys are entered in TrueForge, never in the repo) · run (F5) · mock mode · switch models · run the three tasks (`scripts/verify-task-*.sh` + PowerShell equivalents) · tests · licence · troubleshooting · declared models & cost.

## Final checklist
- [ ] Registered, Team ID saved, TrueForge repo starred
- [ ] Repo public (check in a private window), LICENSE, README works on another machine
- [ ] `forge/agent-instructions.md` + agent spec committed and identical to the one in the video
- [ ] `git grep -nEI "sk-|api_key|secret"` shows only placeholders; no `*.local.*` committed
- [ ] CI green; AT-A/B/C 3/3 on fresh clone; cancel + diff-safety matrices pass
- [ ] Video ≤ 4:00, A→B→C in order, TrueForge session shown in B, link public (open logged-out)
- [ ] Write-up PDF ≤ 3 pages, 8 headings, timestamps match video
- [ ] The write-up PDF has its own public link (committed under `docs/` in the public repo, or Drive "anyone with the link"); that link is what goes into the portal. Same for the video
- [ ] `forge/models.example.json` committed (no keys); `forge/models.local.json` and `forge/setup.local.json` are NOT
- [ ] Baseline `pytest tests/test_cli.py -q` passes on clean Flask 3.1.3 on both machines (recorded in `docs/rehearsal-log.md`)
- [ ] Rule 6: no employer or private code anywhere in the repo
- [ ] Models declared (where ran, cost); AI tools declared
- [ ] Three links pasted into the portal by Wed 18 Nov; re-open each logged-out
- [ ] Optional social posts with #TrueForge #Forgeathon #<TeamName> (15 Oct–18 Dec)

## Live-call prep (10 min; Task A repeated with organisers' model)
Both devs must answer without notes:
1. Walk through what happens between Ctrl+K and the diff (events, MCP call, approval pause).
2. Why `proposeEdit` instead of whole-file writes? 3. How do you know the file wasn't edited during review?
4. What does cancel do in each of the five moments? 5. How does failover avoid double-applying?
6. What exactly is allowed in the terminal and what is *not* guaranteed? 7. How is context chosen and bounded?
8. What breaks if the model is weak? 9. Where is TrueForge isolated in your code? 10. What would you do with another month?
Keep a **model swap script**: `scripts/swap-model.md` (steps to point `forge-primary` at the organisers' model in < 2 minutes) and test it.
