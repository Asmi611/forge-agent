# 05 — Testing & QA plan

## Test layers
| Layer | Tool | Where | Runs in CI |
|---|---|---|---|
| Unit (pure) | vitest | `test/engine`, `test/context`, `test/ui` (vscode-free) | yes |
| Fixture replay | vitest + `fixtures/events/*.jsonl` | eventMapper, orchestrator with fake ForgeClient | yes |
| MCP | vitest + MCP client | tools, auth, caps, secretGuard | yes |
| Extension e2e | `@vscode/test-electron` | `test/e2e` | optional locally |
| Live | `FORGE_LIVE=1` | real TrueForge + real model | manual |
| Eval | `npm run eval:context` | recall@k report | manual + CI smoke |

## Must-have unit suites
- **hunkText:** all-accepted==proposed; all-rejected==original; mixed; pure insert; pure delete; start/end of file; no trailing newline; CRLF; empty file; 200 random edit sets (property test: rebuild == expected).
- **applyEdits:** exact once; zero match → error; multi match → error; overlapping edits; CRLF/LF matching; mixed-EOL file keeps untouched bytes identical; unicode.
- **ProposalStore:** hunks numbering (`newStart` computed), rebuild round-trip, zero-hunk proposal, new file.
- **terminalPolicy:** ≥40 cases incl. `python -c`, `pytest -p evil`, `pytest ../x`, `git -c core.pager=…`, `git diff --output=…`, absolute paths, Windows `.exe`, args with spaces/quotes, unicode.
- **secretGuard / path guard:** `.env`, symlink to outside, `..`, absolute, case variants, Windows drive paths.
- **ResilienceManager:** auth→failover; ECONNREFUSED×3→failover; both fail→single error; failover forbidden after apply; cancel in backoff; failure at session-create / turn-start / mid-stream.
- **SessionOrchestrator:** exactly one terminal event; busy; late events dropped after cancel; pause→review→resume; deny path; stale path; multi-proposal batch.
- **ranker/indexer/mentions/budget:** see 04.

## Diff-safety matrix (extension e2e or integration with fake document)
multi-hunk file · insert+delete · multi-file batch · file edited externally after proposal (hash differs → rejected, nothing written) · unsaved base edits that exist at proposal time (accepted) · edit made during review (rejected) · partial accept then undo · undo after file edited since (warn) · new-file create + undo (deleted) · apply failure injected (restored) · cancel while reviewing (nothing written) · save failure.

## Cancel matrix (assert `git status --porcelain` empty unless hunks were accepted)
(1) mid-stream tokens (2) during `runCommand` (3) while paused awaiting review (4) during retry backoff (5) right after Apply of batch 1 while agent resumes. Plus double-cancel and cancel-then-immediately-rerun.

## Chaos / resilience drills (Task C)
**Filmed drill = INVALID KEY on primary** (auth → immediate failover, no retry wait). The unreachable-endpoint drill (3 retries, about 7 s before failover) is rehearsed but not filmed, to protect the 4:00 limit; the instruction → diff segment may not be cut.
TrueForge not running · wrong key primary / good fallback · wrong key both · unreachable endpoint · rate-limit simulated (proxy returning 429) · stream cut mid-way · MCP port taken · TrueForge restarted mid-run.

## Model-swap drill (organisers may repeat Task A with their model)
Run Task A with (a) primary cloud model, (b) fallback model, (c) a small local OpenAI-compatible model. Record success, #tool calls, failure modes. If (c) fails, fix **tool descriptions/schemas/prompts**, not task hints. Keep a table in `docs/model-drill.md`.

## Performance budgets
Ctrl+K → first token UI update: < 300 ms of our overhead · index Flask < 5 s · event-loop lag p95 < 50 ms while streaming 5 000 tokens · panel handles 500 tool rows · diff open < 200 ms.

## Acceptance tests (the three fixed tasks, on a fresh clone, Flask 3.1.3 @ 22d92470)
**Baseline first (V2.3.4):** on a clean Flask 3.1.3 checkout, on BOTH machines, run `pytest tests/test_cli.py -q` and confirm it passes before any agent run; record the Python version in `docs/rehearsal-log.md`. Otherwise an environment problem looks like an agent failure.
- **AT-A:** Ctrl+K on `get_debug_flag` with the exact text → diff shows only that function (≤1–3 hunks) → accept → `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` prints `False`; also check `n`, `OFF`, `Off`.
- **AT-B (session proof = TrueForge's own UI, Q16):** exact text, no mentions → diff touches ≥3 files (source, test, docs) → accept → `pytest tests/test_cli.py -q` passes → `flask --app <app> config` prints JSON with `"***"` for SECRET/PASSWORD/TOKEN/KEY keys → TrueForge session shows turns + tool calls (+ explorer subagent).
- **AT-C:** break primary → repeat A → fallback takes over (or clear message) → `git status` empty.
Run each 3× consecutively; success must be 3/3 on the final candidate, otherwise tune and repeat. Record in `docs/rehearsal-log.md`.

## Bug triage
P0 = breaks a fixed task or can write unreviewed data → fix immediately. P1 = visible glitch on camera. P2 = rest. After Gate G5 only P0/P1.

## Adversarial security suite (V2.3.5; a grep cannot prove these)
| Area | Cases that must be automated (owner) |
|---|---|
| MCP server auth | no token, wrong token, token in the wrong header, forged `Host` (DNS rebinding), request from a non-loopback address, replayed old session token → all 401/403, nothing executed (Dev 1) |
| Path and secret guard | `..`, absolute paths, Windows drive paths, symlink to outside the workspace, `.env*`, `*.pem`, `id_rsa*`; search previews with key-like strings are redacted (Dev 1) |
| Terminal policy | the ≥40 argv cases in E-10, plus Unicode lookalikes, `--` option terminators, env-var prefixes (Dev 1) |
| Prompt injection | a repo file telling the agent to run a command or edit an unrelated file → no command, no proposal outside the user's request (Dev 1) |
| Review bypass | `user.tool_approval_policy` is never produced (ForgeClient unit test + CI) (Dev 1) |
| Cancel races | late tool call after cancel, double cancel, cancel then immediate new run (Dev 1) |
| Webview | script/HTML/link injection from model or repo text stays inert; CSP blocks inline script (Dev 2, U-11) |
