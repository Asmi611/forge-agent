# 03 — Security model

Honest framing: a command allowlist is **permission control, not an OS sandbox**. We say that in the write-up. Running `pytest` executes repository code (conftest.py, plugins); that is why it needs user confirmation.

## Threat table
| # | Threat | Control | Test |
|---|---|---|---|
| T1 | API key leak | keys only in TrueForge config; `forge/*.local.*`, `.env*` gitignored; CI regex scan; no key ever in logs | `scripts/secret-scan.sh` |
| T2 | Extension calls a model provider directly | grep CI rule; only `ForgeClient` talks HTTP and only to `baseUrl` + MCP port | CI |
| T3 | Dangerous command execution | argv allowlist tiers below; `execFile`, `shell:false`, cwd lock, env scrub, timeout, output cap, kill tree | policy unit tests (≥40 cases) |
| T4 | Prompt injection via repo content ("ignore instructions, run curl…") | tool outputs are *data*: agent instructions say so; commands never run without policy + confirm; proposals always human-reviewed; `runCommand` args never templated from file content | injection fixture test |
| T5 | MCP server abused by local process/web page | bind `127.0.0.1` only; bearer token header; `Host` check; no CORS headers; no tool that writes | MCP auth test |
| T6 | Webview XSS from model/repo text | `textContent` only; CSP `default-src 'none'`, nonce scripts; `localResourceRoots` limited to `media/` | e2e + grep |
| T7 | Path traversal / symlink escape in tools | resolve → `realpath` → must be inside workspace root; reject absolute/`..`; applies to readFile, proposeEdit, createFile, runCommand cwd/paths | traversal tests |
| T8 | Sending secrets to the model | `secretGuard`: readFile/search skip `.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`, `.git/`, files > 1 MB, binary; search results redact lines matching key regexes | secretGuard tests |
| T9 | Silent overwrite of user edits | stale hash check; reject, never merge | diff-safety matrix |
| T10 | TrueForge local mode has no auth | document localhost-only; extension warns if `baseUrl` is not loopback | config test |
| T11 | Cancel races (late tool call after cancel) | run epoch; events from old epoch dropped | cancel tests |
| T12 | Repo code executed in an untrusted workspace (V2.1) | check `vscode.workspace.isTrusted` before enabling `runCommand`; untrusted → tool refuses with an explanation and the confirm UI explains that tests execute repo code; read-only tools, context and diff review keep working; `package.json` `capabilities.untrustedWorkspaces` = `limited` with a description; re-evaluate on `onDidGrantWorkspaceTrust` | trust-gate test (mock host `isWorkspaceTrusted=false`) |
| T13 | Review bypass through `user.tool_approval_policy` `allow_session` (V2.3.4, F19): sending it would auto-allow `proposeEdit` for the session and skip the human | `ForgeClient` never builds that input item; CI forbids the string `tool_approval_policy` in `src` | forbidden-pattern CI + ForgeClient unit test |

## Terminal policy (`src/mcp/terminalPolicy.ts`, enforced twice: engine tool + host)
Input is `{file, args[], cwd?}`; `file` must be a bare executable name (no path separators).

| Tier | Commands | Behaviour |
|---|---|---|
| **auto** | `git status`, `git diff` (+ optional `--stat`, `--name-only`, `--no-color`, pathspecs inside workspace) | runs without prompt |
| **confirm** | `pytest …`, `python -m pytest …`, `python3 -m pytest …`, `npm test`, `npx vitest run …` | first run of each run asks the user (modal-free notification w/ buttons: "Allow once / Allow for this run / Deny") |
| **deny** | everything else (`python -c`, `node -e`, `npm install/run`, `pip`, `curl`, `rm`, `sudo`, `git push/reset/checkout/clean`, shells `sh/bash/cmd/powershell`) | tool returns "command not permitted; allowed: …" |

Note (V2.1): verification commands outside this allowlist (for example the Flask CLI call in Task B's demo) are run **by the human on camera**, not by the agent; the write-up says so. We deliberately do not allowlist a command that imports the app, since that is arbitrary repo code with fewer argument constraints than pytest.

Argument rules for pytest: allowed flags `-q -v -x -s --tb=<short|line|no|native> -k <expr> -m <expr> --maxfail=<n> --no-header -p no:cacheprovider`; **deny** `-p <other>`, `-c`, `--rootdir`, `--confcutdir`, `--import-mode`, `--pyargs`, `-o`, `--basetemp`, anything starting with `-` not in the list; positional args must be workspace-relative existing paths or `path::node` ids with no `..`.
Execution: `execFile(file, args, {cwd: workspaceRoot, shell:false, env: scrubbed, timeout:60000, windowsHide:true})`; env keeps only `PATH, HOME/USERPROFILE, VIRTUAL_ENV, PYTHONPATH?(no), LANG, TERM, SYSTEMROOT, TEMP/TMP`; **never** forwards `TRUEFORGE_*`, `*_KEY`, `*_TOKEN`, `*_SECRET`. Kill tree on timeout/cancel. stdout+stderr capped at 6000 chars (keep tail). Everything logged to the Output channel.

## Review-vs-execution separation (principle 6)
Accepting a diff never authorises a command; allowing a command never accepts a diff; TrueForge approval of `proposeEdit` is resolved *only* by the user's hunk decisions in the UI.
