#!/usr/bin/env node
/**
 * Forge Agent — engine CLI placeholder (S-01).
 *
 * Minimal runnable stub for `npm run engine-cli`.
 *
 * NOT a real engine. This is a bootstrap placeholder only; the real
 * engine loop (SessionOrchestrator, ResilienceManager, ProposalStore,
 * TrueForge HTTP/SSE client) is Dev 1 card work and is NOT implemented
 * here. No model-provider calls, no shell commands, no workspace writes.
 *
 * Purpose: keep `npm run engine-cli` runnable in the S-01 bootstrap so
 * the script declaration in package.json resolves to a valid, exit-0
 * entry point without fabricating engine or TrueForge functionality.
 */

import * as path from 'node:path';

// The extension host does not resolve __dirname in ESM output, so resolve
// the project root from the current working directory.

function printUsage(): void {
  console.log(`forge-agent engine CLI (S-01 placeholder)

Usage:
  npm run engine-cli -- "<prompt>"

This is a bootstrap stub. The real engine loop runs on TrueForge and is
card work, not yet implemented.

Env:
  FORGE_BASE_URL   TrueForge base URL (default: http://localhost:8790)
  FORGE_AGENT      Primary agent id (default: forge-primary)

Example:
  npm run engine-cli -- "say hello"
`);
}

function main(): void {
  const args = process.argv.slice(2);
  const prompt = args[0];

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  if (!prompt) {
    console.error('forge-agent engine-cli: missing prompt argument');
    printUsage();
    process.exit(1);
  }

  console.log(`engine-cli placeholder: prompt="${prompt}"`);
  console.log('engine-cli placeholder: no engine loop run (S-01 bootstrap only).');
}

main();
