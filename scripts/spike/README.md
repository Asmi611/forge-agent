# S-02 spike scripts

Run from the repo root with TrueForge already running (`npx @truefoundry/trueforge@latest`, default http://localhost:8790).
Needs `npm i @modelcontextprotocol/sdk zod` (see package.json). Plain Node, no build.

| Script | Answers |
|---|---|
| `00-discover.mjs` | Q1, Q13: base URL, API routes, models, existing agents |
| `01-plain.mjs` | Q2, Q9, Q16 (plain turn fixture) |
| `02-mcp-tool.mjs` | Q3, Q14, Q15, Q17 (`$env:PRELOAD="false"` for the comparison) |
| `03-approval.mjs` | Q4, Q5, Q6, Q14 (`$env:MODE` = allow, deny, parallel, identical, wait) |
| `04-cancel.mjs` | Q7 |

Set `$env:TF_MODEL="<model name>"` (run any script once without it to list models).
Never put a provider key here: keys live only inside TrueForge's UI. `MCP_TOKEN` is a throw-away local value.
