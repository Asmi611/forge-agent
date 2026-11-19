/**
 * In-process MCP Tool Server startup helper and lifecycle manager (Milestone E-06b).
 *
 * Spawns McpToolServer on loopback (127.0.0.1) with port collision scanning,
 * wires approval-gated proposal handlers dynamically, registers with TrueForge,
 * and ensures idempotent, leak-free teardown.
 */

import * as crypto from 'node:crypto';
import type { UiHost } from '../types/contract.ts';
import type { ForgeClient } from '../engine/ForgeClient.ts';
import type { RunBudget } from '../engine/budget.ts';
import {
  McpToolServer,
  DEFAULT_MCP_PORT,
  DEFAULT_MCP_CONNECTOR_NAME,
  type proposeEditInputSchema,
  type createFileInputSchema,
} from './McpToolServer.ts';
import type { ToolExecutionContext, ToolCallResult } from './limits.ts';
import type { z } from 'zod';

/** Minimal duck-typed provider interface avoiding circular import with SessionOrchestrator. */
export interface ProposalHandlerProvider {
  getProposalHandlers(): {
    proposeEdit: (args: z.infer<typeof proposeEditInputSchema>, ctx: ToolExecutionContext) => Promise<ToolCallResult>;
    createFile: (args: z.infer<typeof createFileInputSchema>, ctx: ToolExecutionContext) => Promise<ToolCallResult>;
  };
}

/** Logger interface for MCP tool server lifecycle diagnostics without leaking secrets. */
export interface ToolServerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug?(message: string, meta?: Record<string, unknown>): void;
}

/** Configuration options for startToolServer helper. */
export interface StartToolServerOptions {
  host: UiHost;
  client?: ForgeClient;
  proposalProvider?: ProposalHandlerProvider;
  name?: string;
  port?: number;
  token?: string;
  // TODO E-06c: per-run budget wiring
  budget?: RunBudget;
  logger?: ToolServerLogger;
}

/** Active handle returned by startToolServer for consumption and teardown. */
export interface ToolServerHandle {
  url: string;
  token: string;
  server: McpToolServer;
  stop: () => Promise<void>;
}

/**
 * Starts McpToolServer on loopback (127.0.0.1) with random token and dynamic proposal resolution.
 *
 * @param opts - Startup configuration options
 * @returns Running ToolServerHandle with bound endpoint and idempotent stop function
 */
export async function startToolServer(opts: StartToolServerOptions): Promise<ToolServerHandle> {
  const token = opts.token ?? crypto.randomBytes(32).toString('hex');
  const port = opts.port ?? DEFAULT_MCP_PORT;
  const name = opts.name ?? DEFAULT_MCP_CONNECTOR_NAME;

  const server = new McpToolServer(opts.host, {
    name,
    port,
    token,
    budget: opts.budget,
  });

  // Wire proposal handlers dynamically through proposalProvider
  server.setProposalHandlers({
    proposeEdit: async (args, ctx) => {
      if (!opts.proposalProvider) {
        return {
          content: [{ type: 'text', text: 'no active run' }],
          isError: true,
        };
      }
      const handlers = opts.proposalProvider.getProposalHandlers();
      return handlers.proposeEdit(args, ctx);
    },
    createFile: async (args, ctx) => {
      if (!opts.proposalProvider) {
        return {
          content: [{ type: 'text', text: 'no active run' }],
          isError: true,
        };
      }
      const handlers = opts.proposalProvider.getProposalHandlers();
      return handlers.createFile(args, ctx);
    },
  });

  // Start HTTP listener on 127.0.0.1 with port scanning fallback
  const info = await server.start();

  // Register bound endpoint with TrueForge if client is provided
  if (opts.client) {
    try {
      await opts.client.registerMcp({
        name: server.name,
        url: info.url,
        token: server.token,
      });
    } catch (err: unknown) {
      await server.stop();
      const rawMessage = (err as Error).message ?? String(err);
      const safeMessage = rawMessage.replace(server.token, '[REDACTED]');
      throw new Error(`Failed to register MCP server with TrueForge: ${safeMessage}`);
    }
  }

  // Diagnostics: token is strictly omitted from log metadata
  opts.logger?.info('tool_server:started', {
    name: server.name,
    port: info.port,
    url: info.url,
  });

  let isStopped = false;
  const stop = async (): Promise<void> => {
    if (isStopped) {
      return;
    }
    isStopped = true;
    opts.logger?.info('tool_server:stopping', {
      name: server.name,
      port: info.port,
    });
    await server.stop();
  };

  return {
    url: info.url,
    token: server.token,
    server,
    stop,
  };
}
