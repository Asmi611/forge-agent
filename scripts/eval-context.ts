#!/usr/bin/env node
/**
 * Forge Agent — eval:context CLI placeholder (S-01).
 *
 * Minimal runnable stub for `npm run eval:context`.
 *
 * NOT a context engine. This is a bootstrap placeholder only; the real
 * context assembly (seed, @mentions, ranker, budget) is Dev 1 card work
 * and is NOT implemented here. No model-provider calls, no shell commands,
 * no workspace writes.
 *
 * Purpose: keep `npm run eval:context` runnable in the S-01 bootstrap so
 * the script declaration in package.json resolves to a valid, exit-0
 * entry point without fabricating context-engine functionality.
 */

import * as path from 'node:path';

function printUsage(): void {
  console.log(`forge-agent eval:context (S-01 placeholder)

Usage:
  npm run eval:context -- <prompt>

This is a bootstrap stub. Real context assembly is card work, not yet
implemented.

Example:
  npm run eval:context -- "say hello"
`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const prompt = args[0];
  if (!prompt) {
    console.error('forge-agent eval:context: missing prompt argument');
    printUsage();
    process.exit(1);
  }

  console.log(`eval:context placeholder: prompt="${prompt}"`);
  console.log('eval:context placeholder: no context assembly run (S-01 bootstrap only).');
}

main();
