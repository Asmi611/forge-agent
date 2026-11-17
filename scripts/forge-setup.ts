#!/usr/bin/env node
/**
 * Forge Agent — forge:setup CLI placeholder (S-01).
 *
 * Minimal runnable stub for `npm run forge:setup`.
 *
 * NOT a TrueForge setup tool. This is a bootstrap placeholder only; the
 * real forge:setup creates/updates agents (forge-primary, forge-fallback)
 * and registers the MCP server via the TrueForge API (Dev 1, card E-01).
 * No model-provider calls, no shell commands, no workspace writes.
 *
 * Purpose: keep `npm run forge:setup` runnable in the S-01 bootstrap so
 * the script declaration in package.json resolves to a valid, exit-0
 * entry point without fabricating TrueForge agent setup or MCP
 * registration.
 */

import * as path from 'node:path';

function printUsage(): void {
  console.log(`forge-agent forge:setup (S-01 placeholder)

Usage:
  npm run forge:setup

This is a bootstrap stub. Real forge:setup (Dev 1, card E-01) creates the
forge-primary and forge-fallback agents and registers the MCP server
through the TrueForge API. That is beyond S-01 scope and is NOT
implemented here.

Settings: forge/setup.example.json -> forge/setup.local.json (gitignored)
Model config: forge/models.example.json  -> forge/models.local.json (gitignored)
`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  console.log('forge:setup placeholder: no agent creation, no MCP registration (S-01 bootstrap only).');
  console.log('forge:setup placeholder: refer to forge/README.md and docs/06-SCHEDULE-AND-GATES.md.');
}

main();
