#!/usr/bin/env node
/**
 * Forge Agent — forge:setup CLI.
 *
 * Idempotently registers the MCP connector and configures primary and
 * fallback agents in TrueForge using native fetch and verified schemas.
 *
 * No model-provider calls, no shell strings, no workspace writes.
 */

import * as path from 'node:path';
import { loadConfig, ConfigError } from '../src/engine/config.ts';
import { ForgeClient, ForgeClientError, HttpError, NetworkError } from '../src/engine/ForgeClient.ts';

function printUsage(): void {
  console.log(`forge-agent forge:setup (Card E-01)

Usage:
  npm run forge:setup [-- [options]]

Options:
  --help, -h          Print this help message
  --allow-remote      Allow non-loopback baseUrl (disables strict loopback guard)
  --workspace <path>  Specify workspace root (defaults to current working directory)

Configuration:
  Settings: forge/setup.example.json -> forge/setup.local.json (gitignored)
  Models:   forge/models.example.json -> forge/models.local.json (gitignored)
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const allowRemote = args.includes('--allow-remote');
  const wsIdx = args.indexOf('--workspace');
  const workspaceRoot = wsIdx !== -1 && args[wsIdx + 1] ? path.resolve(args[wsIdx + 1]) : process.cwd();

  console.log('=== Forge Agent: TrueForge Setup ===\n');

  // 1. Load and validate configuration
  let config;
  try {
    config = loadConfig({
      workspaceRoot,
      allowNonLoopback: allowRemote,
    });
    console.log(`[config] Base URL: ${config.setup.baseUrl} (loopback: ${config.setup.isLoopback ? 'yes' : 'no'})`);
    if (config.setup.loopbackWarning) {
      console.warn(`[security warning] ${config.setup.loopbackWarning}`);
    }
    console.log(`[config] Agents: primary='${config.setup.agents.primary}', fallback='${config.setup.agents.fallback}'`);
    console.log(`[config] MCP Connector: '${config.setup.mcp.name}' (perWorkspace: ${config.setup.mcp.perWorkspace})`);
  } catch (err: unknown) {
    if (err instanceof ConfigError) {
      console.error(`\n[config error] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const client = new ForgeClient(config.setup);

  // 2. Connectivity probe
  console.log('\n[probe] Checking TrueForge connectivity...');
  const health = await client.health();
  if (!health.ok) {
    console.error(`\n[connectivity error] ${health.detail}`);
    console.error(`\nTrueForge does not appear to be running at ${config.setup.baseUrl}.`);
    console.error('To start TrueForge in local mode, run:');
    console.error('  npx @truefoundry/trueforge@latest');
    console.error('Then re-run this setup script.');
    process.exit(1);
  }
  console.log(`[probe] ${health.detail}`);

  // 3. Register or reuse MCP connector
  const mcpPort = config.setup.mcp.port;
  const mcpPath = config.setup.mcp.path.startsWith('/') ? config.setup.mcp.path : `/${config.setup.mcp.path}`;
  const mcpUrl = `http://127.0.0.1:${mcpPort}${mcpPath}`;
  const mcpToken = process.env.FORGE_MCP_TOKEN || 'forge-editor-local-token';

  console.log(`\n[mcp] Registering connector '${config.setup.mcp.name}' at ${mcpUrl}...`);
  try {
    const regResult = await client.registerMcp({
      name: config.setup.mcp.name,
      url: mcpUrl,
      token: mcpToken,
    });
    if (regResult.reused) {
      console.log(`[mcp] Connector '${config.setup.mcp.name}' already configured with matching parameters (reused safely).`);
    } else {
      console.log(`[mcp] Connector '${config.setup.mcp.name}' registered successfully.`);
    }
  } catch (err: unknown) {
    if (err instanceof ForgeClientError) {
      console.error(`\n[mcp error] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // 4. Upsert primary and fallback agents
  const primaryModel = config.models.profiles.primary.modelId;
  const fallbackModel = config.models.profiles.fallback.modelId;
  if (primaryModel.includes('YOUR_') || fallbackModel.includes('YOUR_')) {
    console.error('\n[models error] forge/models.local.json has not been configured.');
    console.error('The model IDs are still set to placeholder values from forge/models.example.json:');
    console.error(`  primary:  '${primaryModel}'`);
    console.error(`  fallback: '${fallbackModel}'`);
    console.error('\nPlease copy forge/models.example.json to forge/models.local.json (gitignored) and');
    console.error('set valid provider/model IDs configured in your local TrueForge instance.');
    process.exit(1);
  }

  console.log('\n[agents] Configuring agents in TrueForge...');
  try {
    const agentsResult = await client.ensureAgents(config.models, workspaceRoot);
    console.log(`[agents] Primary agent '${config.setup.agents.primary}' ensured: ${agentsResult.primary}`);
    console.log(`[agents] Fallback agent '${config.setup.agents.fallback}' ensured: ${agentsResult.fallback}`);
  } catch (err: unknown) {
    if (err instanceof ForgeClientError || err instanceof HttpError || err instanceof NetworkError) {
      console.error(`\n[agent setup error] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // 5. Setup Summary
  console.log('\n=== TrueForge Setup Summary ===');
  console.log(`- Base URL:             ${config.setup.baseUrl}`);
  console.log(`- MCP Connector:        ${config.setup.mcp.name} -> ${mcpUrl}`);
  console.log(`- Approval Tools:       proposeEdit, createFile (preload: true)`);
  console.log(`- Primary Agent:        ${config.setup.agents.primary} (model: ${config.models.profiles.primary.modelId})`);
  console.log(`- Fallback Agent:       ${config.setup.agents.fallback} (model: ${config.models.profiles.fallback.modelId})`);
  console.log(`- Ownership Marker:     [managed-by:forge-agent]`);
  console.log('\nSetup completed successfully.');
}

main().catch((err) => {
  console.error('\n[unexpected error]', err);
  process.exit(1);
});
