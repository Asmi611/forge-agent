# Shared cards (both developers)

Footer for every card: *Plan first and wait for "go". Touch only the listed paths. Run `npm run check` and show the output. End with: what changed / how I verify by hand / what could go wrong.*

---
## S-01 Bootstrap the repo (Dev 1 runs; Dev 2 clones after merge) — Day 1
**Goal:** compiling skeleton, CI, mocks, folder ownership, working "Show demo diff" command.
**Human first (5 minutes, BEFORE running the prompt so the agent can read the specs):** copy the ENTIRE pack contents (docs/, ai-guides/, contract/, forge/, guides/, .github/, AGENTS.md, CLAUDE.md, GEMINI.md, .gitignore, README.md; include hidden files) into the new repo root, replace `@DEV1_GITHUB`/`@DEV2_GITHUB` in `.github/CODEOWNERS` with real usernames, then commit as `chore: add pack v2.3.5` and push.
**Read first:** AGENTS.md, docs/01-ARCHITECTURE.md §12, contract/contract.ts (copy to `src/types/contract.ts`).
**May edit:** everything (bootstrap only).
**Prompt:**
```
Bootstrap a VS Code extension in TypeScript (strict) named "forge-agent": esbuild bundling, vitest, eslint, @vscode/test-electron stub,
scripts: check (tsc --noEmit + eslint + vitest run + scripts/forbidden-patterns.sh), build, test, test:e2e, engine-cli, eval:context, forge:setup (placeholder).
Create the folder layout from docs/01-ARCHITECTURE.md §12 with .gitkeep files. Copy contract/contract.ts to src/types/contract.ts verbatim.
Add src/mocks/MockEngine.ts (scripted run: tokens, tool.call/result, context.report, 3 proposals for fixture paths, review.required, run.completed;
scenarios selectable by prompt text: "mock:error", "mock:failover", "mock:cancel") and src/mocks/MockUiHost.ts (reads files from disk, simple text search, snapshot(), runCommand stub).
Add one command "Forge: Show Demo Diff (mock)" that opens a vscode.diff for fixtures/demo-proposal.json (create the fixture: one file, two hunks).
Add scripts/forbidden-patterns.sh implementing the greps in .github/workflows/ci.yml. Keep .github/ and .gitignore as provided. LICENSE: MIT with our team name placeholder.
Add launch.json configs: "Run Extension (mock)" and "Run Extension on Flask" (opens ../flask).
Do not implement real features. Make `npm run check` pass with at least 3 tests.
```
**Acceptance:** `npm ci && npm run check` green on a clean clone; F5 → demo diff opens; CI green on GitHub.
**Commit:** `chore: bootstrap skeleton, contract v2 draft, mocks, CI`

---
## S-02 The TrueForge spike (both; Dev 1 leads) — Day 1, Gate G0
**Goal:** replace every UNVERIFIED item in docs/02 §B with evidence.
**Read first:** docs/02-TRUEFORGE-FACTS.md (all), https://trueforge.dev/quickstart and the SDK/API reference pages (open them yourself; paste excerpts to the agent).
**May edit:** `scripts/spike/`, `fixtures/events/`, `docs/spike-report.md`, `forge/agent.spec.json`.
**Human steps first (15 min):** `npx @truefoundry/trueforge@latest`; add one model provider in the UI (cloud key or local OpenAI-compatible endpoint); chat once in TrueForge's own UI. Note the port, `node -v`. On native Windows confirm `npx` runs (the repo documents WSL2 for source development). Create `docs/friction-log.md` and note every doc gap or surprise from now on (Round 2 PR seed, docs/06).
**Prompt:**
```
We must answer Q1–Q17 in docs/02-TRUEFORGE-FACTS.md §B with EVIDENCE (Q4 and Q15 are already answered by the SDK types, F15/F16: confirm them with raw fixtures). Write small rerunnable TypeScript scripts in scripts/spike/ (raw fetch, no SDK first; then try the SDK) that:
 01-health-and-agent: find the API base path, create an agent with a model, instructions and NO tools; create a session; create a turn "say hi"; stream SSE; save every raw event line to fixtures/events/01-plain.jsonl.
 02-mcp: start a minimal MCP server (use @modelcontextprotocol/sdk, streamable HTTP, 127.0.0.1:8792/mcp) exposing tools echo (no side effect) and gated_echo; require header x-forge-token; register it with TrueForge via the API (not the UI); attach to the agent; run a turn that calls echo; save fixtures/events/02-tool.jsonl.
 03-approval: configure gated_echo to require approval (find out how: agent spec per tool? MCP annotation?). Run until tool.approval_required; save raw event (does it contain tool name AND arguments?). Resume with user.tool_approval allow (fixtures 03-allow.jsonl) and with deny+reason (03-deny.jsonl). Test two parallel gated calls in one model message and resume both in one turn. Test resuming after 10 minutes.
 03b-identical-calls (HARNESS CAPABILITY PROBE; the product policy is already fixed by docs/01 §4.1 and does not depend on this result): make the agent emit TWO gated calls with IDENTICAL arguments in one message. (i) Resume with allow for call 2 and deny for call 1, input items in order [2,1]; (ii) repeat in order [1,2]; (iii) repeat with the decisions swapped. For each run record which tool_call_id the MCP server sees executing (order; any _meta/header carrying the call id → Q14) and what tool.response each tool_call_id receives; record that a DENIED call never reaches the MCP handler. Save fixtures/events/03b-*.jsonl. RESULT FORMAT: (A) harness passes a call id → handler uses exact lookup; (B) it does not → handler uses argsHash lookup and grouping is what keeps it safe; (C) in either case note whether per-call decisions were honoured in all orderings (informational). PASS = the three runs are recorded with fixtures and the result is classified A or B. The grouping rule is mandatory regardless.
 03c-config: confirm that approval can be set per tool BY NAME (Q15, SDK field requireApprovalForTools) and record the raw-HTTP spelling of requireApprovalForTools / preload / enableTools / disableTools / preloadTools on the agent's MCP entry.
 04-cancel: cancel during streaming; cancel when paused; double cancel. Save outputs.
 05-errors: second agent with a deliberately wrong key; another pointing to an unreachable base URL; record exactly how each surfaces (HTTP status on create-turn vs turn.done state error + message). Save fixtures 05-*.jsonl.
 06-features: list runtime toggles and defaults; trigger a dynamic sub-agent if possible; save thread.created/done samples; note whether sandbox is needed.
 07-env: print process.versions in a VS Code extension host (tiny test extension command) and compare with SDK engines requirement.
 08-sessions-ui (Q16): after any API-created session with a tool call and an approval pause, open TrueForge's own UI and record whether that session is listed and shows turns, tool calls, the approval and any sub-agent thread; screenshot it; note the route/URL.
 09-preload (Q17): attach the echo MCP server once with the default (deferred) setting and once with preload true; ask a weak/small model to call echo; record success over 3 runs each.
After each script, append findings to docs/spike-report.md in the format: Q#, answer, evidence file, fallback chosen. Do not guess: if something fails, record the exact error and what you tried.
```
**Acceptance (Gate G0):** spike-report answers Q2, Q3, Q4, Q5 (or sequential fallback), Q7, Q8, Q16 with fixtures (Q17 recorded); `forge/agent.spec.json` is a manifest that actually works; Dev 2 reads the report.
**Commit:** `docs(spike): TrueForge facts, fixtures and fallbacks`

---
## S-03 Contract freeze (both) — Day 2 morning, Gate G1
**Prompt (Dev 1's agent):**
```
Read docs/spike-report.md and src/types/contract.ts. List every place the contract disagrees with real TrueForge behaviour or fixtures
(event naming, approval payload, error kinds, review batch shape). Propose the minimal diff to the contract. Do not edit the file yet; output the diff and a one-paragraph rationale.
```
Then both devs read the diff, agree, Dev 1 commits it in a **contract-only PR** bumping `CONTRACT_VERSION` from `2.1.0-draft2` to `2.1.0` (or `2.2.0` if the spike changes the shape); Dev 2 approves; merge; both rebase. After this: change requests only via `docs/contract-change-requests.md` + joint PR.

---
## S-04 Integration checks (both, at the gates) — see docs/06 table
- **I-1 (Day 4) Task A end-to-end** on Flask 3.1.3 clean checkout with exact wording. Debug with the Output channel state-machine log.
- **I-2 (Day 7) Task B** 3 runs; record files touched and success.
- **I-3 (Day 9) Task C** wrong key primary → fallback; `git status` empty; plus "TrueForge not running".
- **I-4 (Day 11, 13) Fresh-clone rehearsal** on a second machine following only README.
**Prompt (either dev's agent, to prepare a rehearsal log):**
```
Create docs/rehearsal-log.md with a table for AT-A, AT-B, AT-C × 3 runs: date, model, success (Y/N), files touched, seconds, failure notes.
Add scripts/verify-task-a.sh, verify-task-b.sh, verify-task-c.sh (+ .ps1 equivalents) per docs/05 acceptance tests. Scripts only verify; they never edit files.
```

---
## S-05 Release (Day 14–15)
**Prompt (Dev 1's agent):**
```
Run the final checklist in docs/07-SUBMISSION-KIT.md. For each item output PASS/FAIL with command output as evidence (secret scan, forbidden patterns, clean-clone build in a temp dir, README step dry-run, license present, setup.example.json and models.example.json have no keys, write-up PDF and video links are public, agent-instructions identical to forge/agent.spec.json's instructions).
Do not fix anything; just report.
```
Then the humans fix, record/submit, and re-open all three links logged-out.
