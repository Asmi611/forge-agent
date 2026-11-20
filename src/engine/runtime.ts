/**
 * Single-call runtime bootstrapper and lifecycle manager for Forge Agent (Milestone I-0).
 *
 * Bootstraps configuration, TrueForge health pre-check, in-process MCP server,
 * dynamic proposal handlers, and single-flight engine orchestration.
 * Never throws or rejects; failures are captured cleanly as typed RuntimeError values.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EngineApi, UiHost } from '../types/contract.ts';
import { loadConfig, ConfigError, type EngineConfig } from './config.ts';
import { ForgeClient } from './ForgeClient.ts';
import { SessionOrchestrator, type EngineLogger } from './SessionOrchestrator.ts';
import {
  startToolServer,
  type ToolServerLogger,
  type ToolServerHandle,
} from '../mcp/startToolServer.ts';

/** Error categories describing all failure modes of createRuntime(). */
export type RuntimeErrorKind =
  | 'config_missing'
  | 'config_invalid'
  | 'token_missing'
  | 'service_unreachable'
  | 'port_collision'
  | 'mcp_registration_failed'
  | 'unexpected';

/** Structured error detail returned when createRuntime() fails. */
export interface RuntimeError {
  kind: RuntimeErrorKind;
  message: string;
  detail?: string;
  actionHint: string;
}

/** Operational metadata about the running engine and MCP endpoint. */
export interface RuntimeInfo {
  baseUrl: string;
  mcpUrl: string;
  connectorName: string;
  port: number;
}

/** Active handle returned on successful runtime initialization. */
export interface ForgeRuntime {
  engine: EngineApi;
  stop(): Promise<void>;
  info: RuntimeInfo;
}

/** Discriminated union result returned by createRuntime(). */
export type CreateRuntimeResult =
  | { ok: true; runtime: ForgeRuntime }
  | { ok: false; error: RuntimeError };

/** Options supplied to createRuntime() for host binding and configuration. */
export interface CreateRuntimeOptions {
  host: UiHost;
  forgeDir: string;
  config?: EngineConfig;
  client?: ForgeClient;
  logger?: EngineLogger & ToolServerLogger;
}

/** Redacts any occurrence of the sensitive token from text fields. */
function redactToken(text: string, token?: string): string {
  if (!token || token.trim().length === 0) {
    return text;
  }
  return text.split(token).join('[REDACTED]');
}

/**
 * Bootstraps the full Forge engine runtime with loopback MCP server and TrueForge registration.
 *
 * This function NEVER throws or rejects. All errors during initialization are captured
 * and returned as a typed RuntimeError.
 *
 * @param options - UI host, forgeDir, and optional injected client/config/logger
 * @returns Result object containing either running ForgeRuntime or typed RuntimeError
 */
export async function createRuntime(options: CreateRuntimeOptions): Promise<CreateRuntimeResult> {
  let effectiveToken: string | undefined;

  const buildError = (
    kind: RuntimeErrorKind,
    message: string,
    actionHint: string,
    detail?: string,
  ): CreateRuntimeResult => {
    return {
      ok: false,
      error: {
        kind,
        message: redactToken(message, effectiveToken),
        actionHint: redactToken(actionHint, effectiveToken),
        detail: detail !== undefined ? redactToken(detail, effectiveToken) : undefined,
      },
    };
  };

  try {
    const { host, forgeDir } = options;

    if (!forgeDir || typeof forgeDir !== 'string' || forgeDir.trim() === '') {
      return buildError(
        'config_missing',
        'Forge directory path was not provided or is empty.',
        'Ensure forge.forgeDir or extensionPath/forge is passed to createRuntime.',
      );
    }

    if (!options.config) {
      if (!fs.existsSync(forgeDir)) {
        return buildError(
          'config_missing',
          `Forge directory not found at '${forgeDir}'.`,
          'Ensure forge.forgeDir is set correctly or the forge directory exists in the extension.',
        );
      }
      const setupExample = path.resolve(forgeDir, 'setup.example.json');
      const modelsExample = path.resolve(forgeDir, 'models.example.json');
      if (!fs.existsSync(setupExample) || !fs.existsSync(modelsExample)) {
        return buildError(
          'config_missing',
          `Required base configuration files (*.example.json) are missing in '${forgeDir}'.`,
          'Ensure setup.example.json and models.example.json exist in the forge directory.',
        );
      }
    }

    // 1. Load or accept injected engine configuration
    let config: EngineConfig;
    try {
      config =
        options.config ??
        loadConfig({
          workspaceRoot: host.workspaceRoot,
          forgeDir,
        });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof ConfigError) {
        return buildError(
          'config_invalid',
          `Invalid configuration in '${forgeDir}': ${msg}`,
          'Check syntax and schema of configuration files in the forge directory.',
          msg,
        );
      }
      return buildError(
        'config_invalid',
        `Failed to parse configuration in '${forgeDir}': ${msg}`,
        'Check syntax and schema of configuration files in the forge directory.',
        msg,
      );
    }

    // 2. Resolve MCP token: config.setup.mcp.token (from setup.local.json) or FORGE_MCP_TOKEN
    effectiveToken =
      config.setup.mcp.token && config.setup.mcp.token.trim().length > 0
        ? config.setup.mcp.token.trim()
        : process.env.FORGE_MCP_TOKEN && process.env.FORGE_MCP_TOKEN.trim().length > 0
        ? process.env.FORGE_MCP_TOKEN.trim()
        : undefined;

    if (!effectiveToken) {
      return buildError(
        'token_missing',
        'No MCP authentication token available in forge/setup.local.json or FORGE_MCP_TOKEN.',
        'Run npm run forge:setup in the forge-agent repository.',
      );
    }

    // 3. Construct or use injected ForgeClient and check health
    const client = options.client ?? new ForgeClient(config.setup);
    try {
      const health = await client.health();
      if (!health.ok) {
        return buildError(
          'service_unreachable',
          `TrueForge service is unreachable at ${config.setup.baseUrl}: ${health.detail ?? 'Service unhealthy'}`,
          'Start TrueForge: npx @truefoundry/trueforge@latest (default http://localhost:8790)',
          health.detail,
        );
      }
    } catch (healthErr: unknown) {
      const msg = healthErr instanceof Error ? healthErr.message : String(healthErr);
      return buildError(
        'service_unreachable',
        `TrueForge health check failed at ${config.setup.baseUrl}: ${msg}`,
        'Start TrueForge: npx @truefoundry/trueforge@latest (default http://localhost:8790)',
        msg,
      );
    }

    // 4. Construct SessionOrchestrator
    const orchestrator = new SessionOrchestrator(host, client, config, {
      logger: options.logger,
    });
    const engine = orchestrator.toApi();

    // 5. Start in-process MCP tool server with dynamic proposal routing & registration
    let toolServer: ToolServerHandle;
    try {
      toolServer = await startToolServer({
        host,
        client,
        proposalProvider: orchestrator,
        budgetProvider: () => orchestrator.getActiveBudget(),
        name: config.setup.mcp.name,
        port: config.setup.mcp.port,
        token: effectiveToken,
        logger: options.logger,
      });
    } catch (serverErr: unknown) {
      const msg = serverErr instanceof Error ? serverErr.message : String(serverErr);
      const code = (serverErr as NodeJS.ErrnoException).code;

      if (code === 'EADDRINUSE' || msg.includes('EADDRINUSE')) {
        return buildError(
          'port_collision',
          `MCP server port collision: ${msg}`,
          'Free up loopback ports or configure a different mcp.port.',
          msg,
        );
      }

      if (
        msg.includes('Failed to register MCP server with TrueForge') ||
        msg.includes('registerMcp')
      ) {
        return buildError(
          'mcp_registration_failed',
          msg,
          'Verify TrueForge container logs and permissions.',
          msg,
        );
      }

      return buildError(
        'unexpected',
        `Failed to start in-process MCP tool server: ${msg}`,
        'Check extension and engine logs for details.',
        msg,
      );
    }

    let isStopped = false;
    const stop = async (): Promise<void> => {
      if (isStopped) {
        return;
      }
      isStopped = true;
      await toolServer.stop();
    };

    return {
      ok: true,
      runtime: {
        engine,
        stop,
        info: {
          baseUrl: config.setup.baseUrl,
          mcpUrl: toolServer.url,
          connectorName: config.setup.mcp.name,
          port: toolServer.server.info.port,
        },
      },
    };
  } catch (unexpectedErr: unknown) {
    const msg = unexpectedErr instanceof Error ? unexpectedErr.message : String(unexpectedErr);
    return buildError(
      'unexpected',
      `Unexpected error initializing Forge runtime: ${msg}`,
      'Check extension and engine logs for details.',
      msg,
    );
  }
}
