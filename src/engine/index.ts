/**
 * Public engine entrypoint and factory for Forge Agent.
 *
 * Exposes createEngine() to construct a fully configured EngineApi instance
 * binding the UI host, configuration, TrueForge client, and single-flight orchestrator.
 */

import type { EngineApi, UiHost } from '../types/contract.ts';
import { loadConfig, type EngineConfig } from './config.ts';
import { ForgeClient } from './ForgeClient.ts';
import {
  SessionOrchestrator,
  type EngineLogger,
  type OrchestratorOptions,
} from './SessionOrchestrator.ts';

/**
 * Options for creating an EngineApi instance via createEngine().
 */
export interface CreateEngineOptions {
  /**
   * Path to the directory containing forge configuration files (e.g. setup.local.json).
   * Must be explicitly supplied; no default is assumed.
   */
  forgeDir: string;

  /**
   * Optional pluggable logger for orchestrator diagnostics and transitions.
   */
  logger?: EngineLogger;

  /**
   * Optional pre-loaded engine configuration. If omitted, loaded from forgeDir.
   */
  config?: EngineConfig;

  /**
   * Optional pre-constructed ForgeClient instance. If omitted, constructed from config.setup.
   */
  client?: ForgeClient;
}

/**
 * Synchronous factory creating a configured EngineApi instance.
 *
 * @param host - UI host providing editor capabilities and context providers
 * @param options - Engine creation options requiring an explicit forgeDir
 * @returns EngineApi interface for inline and agent runs
 */
export function createEngine(host: UiHost, options: CreateEngineOptions): EngineApi {
  if (!options || typeof options.forgeDir !== 'string' || options.forgeDir.trim() === '') {
    throw new Error('createEngine requires an explicit non-empty options.forgeDir');
  }

  const config =
    options.config ??
    loadConfig({
      workspaceRoot: host.workspaceRoot,
      forgeDir: options.forgeDir,
    });

  const client = options.client ?? new ForgeClient(config.setup);

  const orchestrator = new SessionOrchestrator(host, client, config, {
    logger: options.logger,
  });

  return orchestrator.toApi();
}

export {
  SessionOrchestrator,
  type EngineLogger,
  type OrchestratorOptions,
};

export {
  startToolServer,
  type StartToolServerOptions,
  type ToolServerHandle,
  type ProposalHandlerProvider,
  type ToolServerLogger,
} from '../mcp/startToolServer.ts';
