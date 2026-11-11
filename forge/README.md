# forge/ — TrueForge-side assets
- `agent-instructions.md` / `.inline.md`: the system prompts (committed; identical to what the video uses).
- `agent.spec.json`: the agent manifest you create during the spike (model, instructions, MCP server + tool selection, approval-required tools, runtime toggles). **Fill from docs/spike-report.md; do not guess fields.**
- `setup.example.json`: our own settings (no keys, no model ids). Copy to `setup.local.json` (gitignored).
- `models.example.json`: **the example model configuration** (provider + model id + context window per saved agent; no keys). Copy to `models.local.json` (gitignored).
- `npm run forge:setup` (Dev 1, card E-01) creates/updates agents `forge-primary` and `forge-fallback` and registers the MCP server via the TrueForge API.
- Models and keys are added in TrueForge (UI → model providers). Never commit keys.

## MCP-server entry fields verified in the SDK types (v2.3.5: verified on `@truefoundry/trueforge-sdk` 0.183.0, re-checked 11 Nov 2026 on 0.184.1; `@truefoundry/trueforge` 0.184.2; put these in `agent.spec.json`, confirm raw-HTTP spelling in the spike)
| Field | Our value | Why |
|---|---|---|
| `name` | `forge-editor` (default). Optional `mcp.perWorkspace: true` suffixes connector and both agents with `-<first 8 hex of sha256(workspaceRoot)>` | the agent refers to its MCP server by name, so per-window names need per-window agents (docs/01 §3) |
| `preload` | `true` | default is deferred discovery; weak/organiser models may not find tools (Q17, ADR-13) |
| `requireApprovalForTools` | `["proposeEdit","createFile"]` | default is `["@write","@destructive"]`; literal names are explicit (Q15, F16) |
| `enableTools` / `disableTools` | all eight tools / none | keep the tool surface small and known |
| `preloadTools` | only if deferral is chosen as the B4 feature: preload the core tools, defer `runCommand`/`createFile` | docs/00 ADR-13 |
Never send the inbound item `user.tool_approval_policy` (would skip review, docs/03 T13).
