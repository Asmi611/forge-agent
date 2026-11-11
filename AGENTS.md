# AGENTS.md — rules for every AI coding agent in this repo
(Claude Code reads CLAUDE.md, Gemini-style tools read GEMINI.md, Codex/others read this file; tools that read none of them: paste the Session start prompt from ai-guides/00. All point here.)

## Project in one paragraph
A VS Code extension coding agent whose agent loop runs on **TrueForge** (TrueFoundry's open-source harness, local mode).
The extension is a *client*: it creates sessions/turns, renders streamed events, and exposes editor capabilities to the agent
as **MCP tools**. Changes are *proposed* by the agent, *reviewed per hunk* by the human, and only then *applied* by the extension.
Read `docs/00-PROJECT-BIBLE.md` and `docs/01-ARCHITECTURE.md` before your first task.

## Who you are working for
You are acting for **Developer 1 (Engine)** or **Developer 2 (Editor)**. The human tells you which. Ownership:

| Path | Owner |
|---|---|
| `src/types/contract.ts`, `fixtures/` | SHARED. Never edit alone. Frozen after Gate G1. |
| `src/engine/`, `src/mcp/`, `forge/`, `scripts/`, `test/engine/`, `src/mocks/MockUiHost.ts`, `README.md`, root configs, `package.json` deps/scripts | Dev 1 |
| `src/extension.ts`, `src/ui/`, `src/review/`, `src/context/`, `media/`, `test/ui/`, `test/context/`, `test/e2e/`, `src/mocks/MockEngine.ts`, `package.json` → `contributes` only | Dev 2 |
| `docs/` | Dev 1 owns 01-03, 07 (submission sections 1,2,3,5,7,8); Dev 2 owns 04, 05 and sections 4,6 |

If a task needs a file you do not own: STOP, say which file and why, and let the human coordinate. Do not "just fix it".

## Hard rules (violating any = reject your own work)
1. **No direct model-provider calls** from the extension or engine. Only TrueForge (HTTP/SDK). No OpenAI/Anthropic/Google SDKs.
2. **Only `src/review/ApplyManager.ts` and `UndoManager.ts` may modify workspace files** (via `WorkspaceEdit`). Nothing in `src/engine` or `src/mcp` imports `fs` write APIs or `vscode.workspace.applyEdit`. CI greps for this.
3. **Tools never write.** `proposeEdit`/`createFile` only stage. The approval-gated flow is in `docs/01-ARCHITECTURE.md` §4.
4. **No shell strings.** Commands are `{file, args[]}` run with `execFile`, `shell:false`. Policy in `docs/03-SECURITY.md`.
5. **No task-specific hints** anywhere (no `cli.py`, `flask config`, `get_debug_flag` in prompts, ranker, tools or tests of production code). Fixtures/eval files may mention Flask.
6. **No secrets.** Never print, log, or commit keys. `forge/*.local.*` and `.env*` are gitignored. Tools refuse to read secret-like files.
7. **Never edit the contract alone.** Need a change? Write the proposal in `docs/contract-change-requests.md` and stop.
8. **Streams never throw; runs end with exactly one terminal event.**
9. **Webview: `textContent` only, strict CSP with nonce.** No `innerHTML` with model/repo text.
10. **TypeScript strict. No `any`** unless commented with why. Every exported function has a one-line doc comment.
11. **Do not install dependencies** without the human's OK (Dev 1 owns `package.json` deps).
12. **TrueForge facts come from `docs/02-TRUEFORGE-FACTS.md` and `docs/spike-report.md` only.** If a fact is marked UNVERIFIED and your task depends on it: stop and say so. Do not invent endpoints.

## Working protocol (every task)
1. Read this file, the card's "Read first" list, and `src/types/contract.ts`.
2. **Write a plan first** (files to touch, tests to add, risks). Wait for the human's "go" unless the card says AUTO.
3. Write tests first or alongside. Pure logic must be vscode-free and unit-tested.
4. Run `npm run check` (typecheck + lint + unit tests + forbidden-pattern grep). Report the real output. Never claim "works" without running it.
5. Run `git diff --stat`. If any file outside your ownership changed, revert it.
6. Commit with Conventional Commits (`feat(review): per-hunk CodeLens`). One card = one small PR.
7. End with: what changed, how to verify by hand, what could go wrong (5 lines; the human pastes this into `docs/notes-devN.md`).

## Commands
`npm run check` · `npm run build` · `npm test` · `npm run test:e2e` (extension host) · `npm run engine-cli -- "<prompt>"` · `npm run eval:context` · `FORGE_LIVE=1 npm test` (live TrueForge integration)
