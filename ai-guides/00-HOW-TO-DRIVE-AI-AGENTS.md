# How to drive an AI coding tool on this project

> Tool note (checked 11 Nov 2026): the free **Gemini CLI** sign-in ended on 18 Jun 2026 (Google moved free users to Antigravity CLI, free quota not officially stated). Any tool works: Freebuff, Antigravity CLI, Copilot, Cline/Continue/opencode with your own key, or Claude Code on a paid plan. Tools that do not auto-read `CLAUDE.md`/`GEMINI.md`/`AGENTS.md` simply need the Session start prompt below. Freebuff is ad-supported and may use prompts to personalise ads: keep its cloud/repo connection off and never paste keys, tokens or personal data into any AI tool.

The AI agent writes the code. You steer, verify and own understanding. Install the tool per its official docs. Run it **from the repo root in your own git worktree/branch** so two agents never touch the same checkout:
`git worktree add ../forge-dev1 -b dev1/<card> main` (Dev 2: `../forge-dev2`).

## The loop (one prompt card = one session = one small PR)
1. Start a **fresh** agent session (clean context). It auto-loads `CLAUDE.md`/`GEMINI.md` → `AGENTS.md`.
2. Paste the **Session start** prompt (below) with your role.
3. Paste the card's prompt. The agent must reply with a **plan**. Check: only your folders? tests included? any invented TrueForge fact? Reply `go` or correct it.
4. Agent implements and runs `npm run check`. You run the thing yourself (F5 / `engine-cli` / live test). "It compiles" ≠ "it works".
5. `git diff --stat` → revert anything outside your ownership. Commit, push, PR; teammate reviews against the card's *Acceptance* list.
6. Evening: ask the agent the **Explain ritual** and save the answer in `docs/notes-devN.md` in your own words.

## Session start prompt
```
Read AGENTS.md, docs/00-PROJECT-BIBLE.md, docs/01-ARCHITECTURE.md and src/types/contract.ts.
I am Developer <1|2>. Summarise in 6 lines: my owned paths, the hard rules, and the card I am about to give you.
Then wait. Do not edit anything yet.
```

## Standard prompt-card shape (every card below follows it)
**Goal · Read first · May edit · Prompt (paste) · Acceptance · Commit.**
The prompt always ends with the same footer (already included in each card):
`Plan first and wait for "go". Touch only the listed paths. Run npm run check and show the output. End with: what changed / how I verify by hand / what could go wrong.`

## Prompting rules that save days
- One card at a time. Never "build the whole thing".
- Paste real data: `fixtures/events/*.jsonl`, real error text, real spike report excerpts. Never let the agent guess TrueForge behaviour.
- If the agent wants to edit the contract or a teammate's folder: refuse, write it in `docs/contract-change-requests.md`.
- Ask for tests that fail first, then pass.
- When stuck: `Here is the error: <paste>. Explain the cause in 3 lines, propose the smallest fix, do not refactor.`
- Review prompt before every commit: `Review my uncommitted diff. List: files outside my ownership, any hardcoded key/path/task word, any direct provider call, any workspace write outside ApplyManager/UndoManager, any shell string, any missing test. Be strict.`
- Judge-mode prompt (weekly): `Act as a strict Techfest judge scoring docs/00 §11. For each criterion say which anchor our current code earns and the evidence, and list the cheapest improvement.`
