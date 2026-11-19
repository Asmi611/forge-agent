#!/usr/bin/env node
/**
 * Forge Agent -- engine CLI entrypoint.
 *
 * Runs the engine with MockUiHost (or injected host) against a workspace path,
 * streaming EngineEvents to stdout as JSON lines with health pre-check and error logging.
 */

import * as path from 'node:path';
import type { EngineApi, UiHost } from '../src/types/contract.ts';
import {
  createEngine,
  startToolServer,
  type StartToolServerOptions,
  type ToolServerHandle,
  type ProposalHandlerProvider,
} from '../src/engine/index.ts';
import { ForgeClient } from '../src/engine/ForgeClient.ts';
import { loadConfig, type EngineConfig } from '../src/engine/config.ts';
import { MockUiHost } from '../src/mocks/MockUiHost.ts';

/**
 * Pluggable dependencies for testing runCli() in isolation.
 */
export interface CliDependencies {
  host?: UiHost;
  engine?: EngineApi;
  client?: ForgeClient;
  config?: EngineConfig;
  healthCheck?: (client: ForgeClient) => Promise<{ ok: boolean; detail?: string }>;
  startToolServer?: (opts: StartToolServerOptions) => Promise<ToolServerHandle>;
  skipToolServer?: boolean;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  workspaceRoot?: string;
  forgeDir?: string;
}

/**
 * Parsed CLI options.
 */
interface ParsedCliArgs {
  prompt?: string;
  forgeDir?: string;
  workspaceRoot?: string;
  mode: 'agent' | 'inline';
  profile?: 'primary' | 'fallback';
  help: boolean;
}

/**
 * Result of parsing CLI arguments.
 */
type ParseResult =
  | { success: true; parsed: ParsedCliArgs }
  | { success: false; error: string };

/**
 * Parses raw command line arguments with strict validation.
 */
function parseCliArgs(args: string[]): ParseResult {
  const parsed: ParsedCliArgs = {
    mode: 'agent',
    help: false,
  };

  const positional: string[] = [];
  let endOfOptions = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (endOfOptions) {
      positional.push(arg);
      continue;
    }

    if (arg === '--') {
      endOfOptions = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }

    // --forgeDir / --forge-dir
    if (arg === '--forgeDir' || arg === '--forge-dir') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        return { success: false, error: `Missing value for option '${arg}'` };
      }
      parsed.forgeDir = args[++i];
      continue;
    }
    if (arg.startsWith('--forgeDir=')) {
      const val = arg.slice('--forgeDir='.length);
      if (!val) {
        return { success: false, error: `Missing value for option '--forgeDir'` };
      }
      parsed.forgeDir = val;
      continue;
    }
    if (arg.startsWith('--forge-dir=')) {
      const val = arg.slice('--forge-dir='.length);
      if (!val) {
        return { success: false, error: `Missing value for option '--forge-dir'` };
      }
      parsed.forgeDir = val;
      continue;
    }

    // --workspace / -w
    if (arg === '--workspace' || arg === '-w') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        return { success: false, error: `Missing value for option '${arg}'` };
      }
      parsed.workspaceRoot = args[++i];
      continue;
    }
    if (arg.startsWith('--workspace=')) {
      const val = arg.slice('--workspace='.length);
      if (!val) {
        return { success: false, error: `Missing value for option '--workspace'` };
      }
      parsed.workspaceRoot = val;
      continue;
    }
    if (arg.startsWith('-w=')) {
      const val = arg.slice('-w='.length);
      if (!val) {
        return { success: false, error: `Missing value for option '-w'` };
      }
      parsed.workspaceRoot = val;
      continue;
    }

    // --mode / -m
    if (arg === '--mode' || arg === '-m') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        return { success: false, error: `Missing value for option '${arg}'` };
      }
      const val = args[++i];
      if (val !== 'agent' && val !== 'inline') {
        return { success: false, error: `Invalid value for '${arg}': '${val}' (expected 'agent' or 'inline')` };
      }
      parsed.mode = val;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      const val = arg.slice('--mode='.length);
      if (val !== 'agent' && val !== 'inline') {
        return { success: false, error: `Invalid value for '--mode': '${val}' (expected 'agent' or 'inline')` };
      }
      parsed.mode = val;
      continue;
    }
    if (arg.startsWith('-m=')) {
      const val = arg.slice('-m='.length);
      if (val !== 'agent' && val !== 'inline') {
        return { success: false, error: `Invalid value for '-m': '${val}' (expected 'agent' or 'inline')` };
      }
      parsed.mode = val;
      continue;
    }

    // --profile / -p
    if (arg === '--profile' || arg === '-p') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        return { success: false, error: `Missing value for option '${arg}'` };
      }
      const val = args[++i];
      if (val !== 'primary' && val !== 'fallback') {
        return { success: false, error: `Invalid value for '${arg}': '${val}' (expected 'primary' or 'fallback')` };
      }
      parsed.profile = val;
      continue;
    }
    if (arg.startsWith('--profile=')) {
      const val = arg.slice('--profile='.length);
      if (val !== 'primary' && val !== 'fallback') {
        return { success: false, error: `Invalid value for '--profile': '${val}' (expected 'primary' or 'fallback')` };
      }
      parsed.profile = val;
      continue;
    }
    if (arg.startsWith('-p=')) {
      const val = arg.slice('-p='.length);
      if (val !== 'primary' && val !== 'fallback') {
        return { success: false, error: `Invalid value for '-p': '${val}' (expected 'primary' or 'fallback')` };
      }
      parsed.profile = val;
      continue;
    }

    // Reject unknown options starting with '-'
    if (arg.startsWith('-')) {
      return { success: false, error: `Unknown option: '${arg}'` };
    }

    positional.push(arg);
  }

  if (positional.length > 0) {
    parsed.prompt = positional.join(' ');
  }

  return { success: true, parsed };
}

/**
 * Prints usage and command options to the specified writer.
 */
function printUsage(writer: (msg: string) => void): void {
  writer(`Forge Agent Engine CLI

Usage:
  npx vite-node --script scripts/engine-cli.ts --forgeDir <path> [options] "<prompt>"

Options:
  --forgeDir <path>     Path to forge directory containing setup and models configuration (required)
  --workspace <path>    Path to workspace root directory (default: current working directory)
  --mode <mode>         Run mode: 'agent' or 'inline' (default: 'agent')
  --profile <profile>   Model profile: 'primary' or 'fallback' (default: 'primary')
  -h, --help            Show this help message and exit

Exit codes:
  0   Success (completed or help)
  1   Failed run, invalid arguments, or unreachable TrueForge service
  130 Run was cancelled
`);
}

/**
 * Runs the CLI entrypoint with support for test dependency injection.
 *
 * @param args - Command line arguments (excluding node and script name)
 * @param deps - Optional dependency overrides for testing
 * @returns Exit code: 0 on success, 1 on error/failure, 130 on cancellation
 */
export async function runCli(args: string[], deps?: CliDependencies): Promise<number> {
  const stdout = deps?.stdout ?? ((msg: string) => console.log(msg));
  const stderr = deps?.stderr ?? ((msg: string) => console.error(msg));

  const parseResult = parseCliArgs(args);
  if (!parseResult.success) {
    stderr(`Error: ${parseResult.error}`);
    printUsage(stderr);
    return 1;
  }
  const parsed = parseResult.parsed;

  if (parsed.help) {
    printUsage(stdout);
    return 0;
  }

  if (!parsed.prompt || parsed.prompt.trim() === '') {
    stderr('Error: missing required prompt argument');
    printUsage(stderr);
    return 1;
  }

  const rawForgeDir = parsed.forgeDir ?? deps?.forgeDir;
  if (!rawForgeDir || rawForgeDir.trim() === '') {
    stderr('Error: missing required --forgeDir argument');
    printUsage(stderr);
    return 1;
  }

  const workspaceRoot = path.resolve(parsed.workspaceRoot ?? deps?.workspaceRoot ?? process.cwd());
  const forgeDir = path.isAbsolute(rawForgeDir)
    ? rawForgeDir
    : path.resolve(workspaceRoot, rawForgeDir);

  // 1. Load engine configuration
  let config = deps?.config;
  if (!config) {
    try {
      config = loadConfig({ workspaceRoot, forgeDir });
    } catch (err: unknown) {
      stderr(`Failed to load engine configuration from '${forgeDir}': ${(err as Error).message}`);
      return 1;
    }
  }

  // 2. Construct one ForgeClient instance and share it with health check and createEngine
  const client = deps?.client ?? new ForgeClient(config.setup);

  // 3. Health pre-check using the same ForgeClient instance
  const healthFn = deps?.healthCheck ?? ((c: ForgeClient) => c.health());
  try {
    const health = await healthFn(client);
    if (!health.ok) {
      stderr(`TrueForge service is unreachable at ${config.setup.baseUrl}: ${health.detail ?? 'Service unhealthy'}`);
      return 1;
    }
  } catch (err: unknown) {
    stderr(`TrueForge health check failed at ${config.setup.baseUrl}: ${(err as Error).message}`);
    return 1;
  }

  // 4. Construct UI host and engine using the exact same client instance
  const host = deps?.host ?? new MockUiHost(workspaceRoot);
  const engine =
    deps?.engine ??
    createEngine(host, {
      forgeDir,
      config,
      client,
    });

/** Type guard checking if an engine instance exposes getProposalHandlers() without blind casting. */
function isProposalHandlerProvider(obj: unknown): obj is ProposalHandlerProvider {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'getProposalHandlers' in obj &&
    typeof (obj as ProposalHandlerProvider).getProposalHandlers === 'function'
  );
}

  // 5. Select model profile if requested
  if (parsed.profile && typeof engine.switchModel === 'function') {
    try {
      await engine.switchModel(parsed.profile);
    } catch (err: unknown) {
      stderr(`Failed to switch model profile to '${parsed.profile}': ${(err as Error).message}`);
      return 1;
    }
  }

  // 6. Start MCP tool server unless skipToolServer or injected deps
  let toolServer: ToolServerHandle | null = null;
  const shouldStartServer =
    !deps?.skipToolServer &&
    (deps?.startToolServer !== undefined || (!deps?.engine && !deps?.client));

  if (shouldStartServer) {
    const startFn = deps?.startToolServer ?? startToolServer;
    const proposalProvider = isProposalHandlerProvider(engine) ? engine : undefined;
    try {
      toolServer = await startFn({
        host,
        client,
        proposalProvider,
        name: config.setup.mcp.name,
        port: config.setup.mcp.port,
      });
    } catch (err: unknown) {
      stderr(`Failed to start MCP tool server: ${(err as Error).message}`);
      return 1;
    }
  }

  // 7. Execute run stream and verify terminal event outcome
  let terminalReceived = false;
  let exitCode = 1;

  try {
    const stream =
      parsed.mode === 'inline'
        ? engine.runInline({
            prompt: parsed.prompt,
            path: 'inline.txt',
            selectedText: parsed.prompt,
            range: { startLine: 1, endLine: 1 },
          })
        : engine.runAgent({
            prompt: parsed.prompt,
            mentions: [],
          });

    for await (const event of stream) {
      stdout(JSON.stringify(event));

      if (event.type === 'run.completed') {
        terminalReceived = true;
        exitCode = 0;
      } else if (event.type === 'run.cancelled') {
        terminalReceived = true;
        exitCode = 130;
        stderr('Run was cancelled');
      } else if (event.type === 'run.failed') {
        terminalReceived = true;
        exitCode = 1;
        stderr(`Run failed [${event.error.kind}]: ${event.error.message}`);
      }
    }
  } catch (err: unknown) {
    stderr(`CLI execution error: ${(err as Error).message}`);
    return 1;
  } finally {
    if (toolServer) {
      try {
        await toolServer.stop();
      } catch (stopErr: unknown) {
        stderr(`Failed to stop MCP tool server: ${(stopErr as Error).message}`);
      }
    }
  }

  if (!terminalReceived) {
    stderr('Stream ended unexpectedly without a terminal event');
    return 1;
  }

  return exitCode;
}

/**
 * Pure guard checking if this file is the direct CLI entrypoint.
 * Avoids import.meta, require, __filename, or top-level await.
 */
function isDirectExecution(): boolean {
  if (typeof process === 'undefined' || !process.argv || !process.argv[1]) {
    return false;
  }
  const entry = process.argv[1].replace(/\\/g, '/');
  return /scripts\/engine-cli\.(?:[cm]?[jt]s)$/.test(entry) || entry.endsWith('engine-cli');
}

if (isDirectExecution()) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error('Fatal CLI execution error:', err);
      process.exitCode = 1;
    });
}
