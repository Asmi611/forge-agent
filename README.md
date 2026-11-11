# Forge-a-thon pack v2.3.5 — TrueForge VS Code coding agent

Everything the two developers and their AI coding agents (Freebuff, Antigravity CLI, Copilot, Cline/Continue/opencode, Claude Code on a paid plan, Codex...) need.
**Start here, in this order (30 min):**

| # | File | Read it to |
|---|---|---|
| 1 | `docs/00-PROJECT-BIBLE.md` | understand the idea, principles, scope, decisions, scoring target |
| 2 | `docs/01-ARCHITECTURE.md` | understand the design (approval-gated proposals, state machine, cancel, failover) |
| 3 | `docs/02-TRUEFORGE-FACTS.md` | know what is verified about TrueForge and what the spike must prove |
| 4 | `docs/06-SCHEDULE-AND-GATES.md` | follow the day-by-day plan (4 Nov → submit 18 Nov) |
| 5 | `ai-guides/00-HOW-TO-DRIVE-AI-AGENTS.md` | run the AI agents correctly |
| 6 | `ai-guides/01-SHARED-CARDS.md` | S-01 bootstrap and S-02 spike (do these first, today) |
| 7 | `ai-guides/02-DEV1-ENGINE-CARDS.md` or `03-DEV2-EDITOR-CARDS.md` | your prompt cards |

Beginner walkthroughs, regenerated for v2.3.5 (embed every card, plain-words explanations, how to verify by hand): `guides/DEVELOPER_1_GUIDE.pdf`, `guides/DEVELOPER_2_GUIDE.pdf`.

Reference: `docs/03-SECURITY.md`, `04-CONTEXT-ENGINE.md`, `05-TESTING-QA.md`, `07-SUBMISSION-KIT.md`, `08-CHANGES-FROM-V1.md`.
Agent rules: `AGENTS.md` (+ `CLAUDE.md`, `GEMINI.md`). Contract: `contract/contract.ts` (passes `tsc --strict --noEmit`; `CONTRACT_VERSION = '2.1.0-draft2'` is the pre-freeze version, the Gate G1 contract-only PR changes it to `2.1.0`; becomes `src/types/contract.ts`).
Prompts/config for TrueForge: `forge/` (`setup.example.json` = our settings, `models.example.json` = the example model configuration the organisers require; keys never live in the repo). CI + CODEOWNERS: `.github/`.

## First hour
1. Confirm registration + Team ID. Star github.com/truefoundry/trueforge. Node ≥ 22.14 (if either of you is on native Windows, check early that `npx @truefoundry/trueforge@latest` runs; the repo documents WSL2 for source development).
2. Dev 1: run card **S-01** (bootstrap) in your AI coding tool, push, invite Dev 2, enable branch protection. **Before the first PR replace `@DEV1_GITHUB` and `@DEV2_GITHUB` in `.github/CODEOWNERS` with your real GitHub usernames.**
3. Both: card **S-02** (spike). Do not write engine code before `docs/spike-report.md` exists.

> Note: `.github/workflows/ci.yml` and its forbidden-pattern greps only become meaningful after S-01 creates `package.json` and `src/`. The pack itself contains specs, not a running project.
