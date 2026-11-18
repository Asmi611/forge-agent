# S-02 spike scripts

After cloning the repository, install the dependencies recorded in `package-lock.json`:

```powershell
npm ci
```

Run all scripts from the repository root using plain Node (`node scripts/spike/<script>.mjs`), no build required. TrueForge must already be running before executing the spike scripts (`npx @truefoundry/trueforge@latest`, default http://localhost:8790).

## Script inventory

| Script | Answers / Focus |
|---|---|
| `00-discover.mjs` | Q1, Q13: base URL, API routes, models, existing agents |
| `01-plain.mjs` | Q2, Q9, Q16 (plain turn fixture) |
| `02-mcp-tool.mjs` | Q3, Q14, Q15, Q17 (`$env:PRELOAD="false"` for comparison) |
| `03-approval.recovered.mjs` | Q4, Q5, Q6, Q14: approval pause/resume across 5 modes, bounded timeout, and identical-call capability probe |
| `04-cancel.mjs` | Q7: cancel during active streaming; repeated cancellation request behavior |

> **Note on approval scripts:** `scripts/spike/03-approval.recovered.mjs` is the authoritative, live-verified script used to generate all `03-*` fixtures (supporting turn event subscriptions, bounded session cancellation on timeout, exact execution count assertions, and identical-call permutations). `scripts/spike/03-approval.mjs` is retained as a historical prototype illustrating the earlier turn-based input approach prior to verifying TrueForge's same-turn `/events` wire protocol. Both scripts are retained in the repository for auditability.

## Running the approval script (`03-approval.recovered.mjs`)

The approval workflow script supports the following configuration via environment variables:

- `MODE=allow`: single gated call approved (expected handler executions: 1).
- `MODE=deny`: single gated call denied with truthful reason (expected handler executions: 0).
- `MODE=wait`: pauses for `WAIT_MIN` minutes (default 10) before resuming allow (expected handler executions: 1).
- `MODE=parallel`: 3 gated calls in one message; decisions: allow, deny, allow (expected handler executions: 2).
- `MODE=identical`: 2 identical gated calls in one message with `PERM=i`, `ii`, or `iii`.

### Identical-call permutations (`MODE=identical`)

| PERM | Decision submission order | Call 1 | Call 2 | Expected handler executions |
|---|---|---|---|---|
| i | [2,1] | deny | allow | 1 |
| ii | [1,2] | deny | allow | 1 |
| iii | [1,2] | allow | deny | 1 |

Example command (PowerShell):
```powershell
$env:MODE="identical"; $env:PERM="i"; node scripts/spike/03-approval.recovered.mjs
```

## Setup, Localhost URLs, and Model Configuration

- **TrueForge Base URL:** `http://localhost:8790`
- **MCP Test Server:** `http://127.0.0.1:8792/mcp` (started automatically by test scripts using `mcp-server.mjs`)
- **Model configuration:** Set `$env:TF_MODEL="<model name>"`. If unset, running a script prints available models returned by `GET /api/v1/models`.

## Fixture Preservation and Security

- **Execution from repository root:** Scripts must be run from the root of the repository.
- **Fixture preservation:** Existing fixtures in `fixtures/events/` are protected against overwriting. If a fixture file already exists, `saveFixture()` skips writing and preserves the existing recording.
- **Security warning:** Never put a provider key in scripts, configuration files, or command lines. Model provider keys reside solely inside TrueForge's own UI settings. `MCP_TOKEN` is a local throw-away authentication token for the loopback MCP server.
