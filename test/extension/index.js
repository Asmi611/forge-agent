#!/usr/bin/env node
/**
 * Forge Agent — extension test entry point (S-01).
 *
 * Real VS Code extension test entry: loads the built extension and
 * verifies forge.showDemoDiff is registered. S-01 has no real extension
 * test, so this is the honest bootstrap placeholder that makes the
 * @vscode/test-electron runTests() path valid and loadable, while the
 * visual diff remains a manual Dev-2 step.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Module = require('module');

// Mock the `vscode` namespace so the built CJS extension loads outside
// VS Code (the extension host normally injects `vscode` as a global).
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return require('./mockVscode');
  }
  return originalLoad.apply(this, arguments);
};

const ROOT = path.resolve(__dirname, '..', '..');
const EXTENSION_OUT = path.join(ROOT, 'out', 'extension.js');

async function main() {
  if (!fs.existsSync(EXTENSION_OUT)) {
    throw new Error(`extension output not found: ${EXTENSION_OUT}`);
  }
  // Load the built extension as CommonJS (the built artifact is CJS).
  const built = require(EXTENSION_OUT);

  const mock = require('./mockVscode');
  const context = { subscriptions: [] };
  built.registerDemoDiffCommand(context);

  // Verify the command registered into the mock sink.
  const registered = mock.vscode.commands.__forgedCommandId === 'forge.showDemoDiff';
  assert.strictEqual(registered, true, 'forge.showDemoDiff was not registered into the mock vscode.commands sink');

  console.log('forge-agent test/extension/index.js: extension loaded and forge.showDemoDiff registered');
}

main().catch((err) => {
  console.error('forge-agent test/extension/index.js: failed:', err);
  process.exit(1);
});
