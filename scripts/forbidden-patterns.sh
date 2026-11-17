#!/usr/bin/env bash
#
# forbidden-patterns.sh -- CI forbidden-pattern grep implementation.
#
# Mirrors .github/workflows/ci.yml. Under bash -e a failing `! cmd` is exempt,
# so every check records its own failure via fail=1 and the script exits
# non-zero at the end if anything was found.
set -u

fail=0

# 1) Directory presence (grep exits 2 if a directory is missing).
for d in src/engine src/mcp src/ui media; do
  if [ ! -d "$d" ]; then
    echo "missing dir $d"
    fail=1
  fi
done

# 2) Forbidden patterns in src/engine + src/mcp (write APIs / vscode.workspace.applyEdit / rm / unlink).
if grep -rEn "writeFile|appendFile|createWriteStream|\bapplyEdit\b|rmSync|unlinkSync" src/engine src/mcp; then
  fail=1
fi

# 3) No direct model-provider calls.
if grep -rEn "api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis" src; then
  fail=1
fi

# 4) No shell strings (shell: true in src).
if grep -rEn "shell: *true" src; then
  fail=1
fi

# 5) No review bypass via user.tool_approval_policy.
if grep -rn "tool_approval_policy" src; then
  fail=1
fi

# 6) No innerHTML in webview (media + src/ui).
if grep -rn "innerHTML" media src/ui; then
  fail=1
fi

# 7) No secrets (sk- / AIza patterns) in the repo except docs.
if git grep -nEI "sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}" -- . ':!docs' 2>/dev/null; then
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "FORBIDDEN PATTERNS FOUND"
  exit 1
fi

echo "forbidden patterns: clean"
exit 0
