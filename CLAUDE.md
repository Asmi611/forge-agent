@AGENTS.md

# Claude Code specifics
- Use plan mode for every card; only leave it after the human approves the plan.
- Prefer small diffs. After edits run `npm run check` yourself and paste the tail of the output.
- For VS Code API questions consult https://code.visualstudio.com/api, for TrueForge use `docs/02-TRUEFORGE-FACTS.md` (do not guess).
- Do not spawn subagents that edit files outside the owner's paths.
