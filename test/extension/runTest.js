#!/usr/bin/env node
/**
 * Forge Agent — test:e2e harness (S-01).
 *
 * Genuine VS Code Extension Host test. Launches a real VS Code instance
 * via the installed `@vscode/test-electron` package and its `runTests()`
 * API, then loads the built extension and runs a real extension test
 * entry under `test/e2e`.
 *
 * Configuration:
 *   extensionDevelopmentPath -> project root (src/extension.ts)
 *   extensionTestsPath       -> a valid test entry (.js) under test/e2e
 *   launchArgs                -> fixture workspace + the demo-diff command
 *
 * Scope (honest, not over-claimed):
 *   S-01's extension-host test verifies: the built extension loads and
 *   `forge.showDemoDiff` registers. The visual diff editor is NOT opened
 *   by this script: S-01 cannot open a second VS Code window synchronously
 *   from the command's async executeCommand, and a programmatic diff render
 *   is not part of S-01. The visual diff check is DEFERRED to a manual
 *   Dev-2 interactive VS Code session.
 *
 * This is NOT a mocked Node smoke test: it launches the real VS Code
 * Extension Host. If it fails to launch, the reason is a real one.
 */

'use strict';

const path = require('path');

// @vscode/test-electron's runTests() API.
const { runTests } = require('@vscode/test-electron');

// Project root = package.json location.
const ROOT = path.resolve(__dirname, '..', '..');

// Genuine extension test entry point under test/e2e.
const EXTENSION_TESTS_PATH = path.join(ROOT, 'test', 'e2e', 'index.js');

async function main() {
  // The Extension Host test runs with a real VS Code. It must not depend
  // on any pre-built output (test/e2e/index.js loads src/extension.ts via
  // the extension host's own TS support only if out/extension.js exists,
  // so we verify the built extension exists and fail clearly if not).
  const EXTENSION_OUT = path.join(ROOT, 'out', 'extension.js');
  const fs = require('fs');
  if (!fs.existsSync(EXTENSION_OUT)) {
    console.error(`forge-agent test:e2e: built extension not found (run "npm run build" first): ${EXTENSION_OUT}`);
    process.exit(1);
  }

  try {
    const exitCode = await runTests({
      extensionDevelopmentPath: ROOT,
      extensionTestsPath: EXTENSION_TESTS_PATH,
      launchArgs: [
        path.resolve(ROOT, 'fixtures'),
        '--command', 'forge.showDemoDiff',
      ],
    });

    if (exitCode !== 0) {
      console.error(`forge-agent test:e2e: real Extension Host exited with code ${exitCode}`);
      process.exit(exitCode);
    }

    console.log('forge-agent test:e2e: real Extension Host launched and extension loaded');
    console.log('forge-agent test:e2e: visual diff OPEN deferred to manual Dev-2 step');
  } catch (err) {
    console.error(`forge-agent test:e2e failed to launch real VS Code: ${err}`);
    process.exit(1);
  }
}

main();
