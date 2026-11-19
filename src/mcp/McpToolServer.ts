/**
 * Streamable HTTP MCP Tool Server (Milestone E-04).
 *
 * Exposes workspace capabilities as an in-process MCP server over loopback HTTP
 * (127.0.0.1:<port>/mcp) using @modelcontextprotocol/sdk v1.32.2.
 *
 * Enforces strict Host authority validation, constant-time x-forge-token authentication,
 * request body size limits, and registers all eight contract v2.1.0 tools (five active read tools
 * and three safe deferred stubs for proposeEdit, createFile, and runCommand).
 */

import * as http from 'node:http';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { UiHost } from '../types/contract.ts';
import type { RunBudget } from '../engine/budget.ts';
import type { ToolExecutionContext, ToolCallResult } from './limits.ts';
import {
  REPO_MAP_TOOL_NAME,
  REPO_MAP_TOOL_DESCRIPTION,
  repoMapInputSchema,
  handleRepoMap,
} from './tools/repoMap.ts';
import {
  SEARCH_WORKSPACE_TOOL_NAME,
  SEARCH_WORKSPACE_TOOL_DESCRIPTION,
  searchWorkspaceInputSchema,
  handleSearchWorkspace,
} from './tools/searchWorkspace.ts';
import {
  FIND_SYMBOL_TOOL_NAME,
  FIND_SYMBOL_TOOL_DESCRIPTION,
  findSymbolInputSchema,
  handleFindSymbol,
} from './tools/findSymbol.ts';
import {
  READ_FILE_TOOL_NAME,
  READ_FILE_TOOL_DESCRIPTION,
  readFileInputSchema,
  handleReadFile,
} from './tools/readFile.ts';
import {
  REPORT_CONTEXT_TOOL_NAME,
  REPORT_CONTEXT_TOOL_DESCRIPTION,
  reportContextInputSchema,
  handleReportContext,
} from './tools/reportContext.ts';

/** Default MCP server listening port. */
export const DEFAULT_MCP_PORT = 8792;

/** Maximum port scan range when default port is occupied. */
export const MAX_PORT_SCAN_ATTEMPTS = 50;

/** Default connector name in TrueForge agent manifest. */
export const DEFAULT_MCP_CONNECTOR_NAME = 'forge-editor';

/** Maximum allowed HTTP request body size (2 MB). */
export const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

/** Frozen contract input schema for proposeEdit (Milestone E-05). */
export const proposeEditInputSchema = z.object({
  path: z.string().min(1).describe('Workspace-relative path of the file to edit'),
  edits: z
    .array(
      z.object({
        oldText: z.string().describe('Exact text to be replaced (must match uniquely)'),
        newText: z.string().describe('Replacement text to splice into the file'),
      })
    )
    .describe('List of search/replace edits against the current document'),
  rationale: z.string().describe('Reason for proposing these changes'),
});

/** Frozen contract input schema for createFile (Milestone E-05). */
export const createFileInputSchema = z.object({
  path: z.string().min(1).describe('Workspace-relative path of the new file to create'),
  content: z.string().describe('Complete initial content of the new file'),
  rationale: z.string().describe('Reason for creating the file'),
});

/** Frozen contract input schema for runCommand (Milestone E-10). */
export const runCommandInputSchema = z.object({
  file: z.string().min(1).describe('Executable name without path separators (e.g. pytest, npm)'),
  args: z.array(z.string()).describe('Array of command line arguments'),
  cwd: z.string().optional().describe('Workspace directory to execute command in'),
});

/** Options for configuring McpToolServer. */
export interface McpToolServerOptions {
  name?: string;
  port?: number;
  token?: string;
  budget?: RunBudget;
}

/** Information snapshot of a running MCP tool server. */
export interface McpServerInfo {
  name: string;
  port: number;
  url: string;
  token: string;
  isRunning: boolean;
}

/**
 * Compares two token strings in constant time to prevent timing attacks.
 *
 * @param expected - The known authoritative token
 * @param provided - The token provided in the HTTP request header
 * @returns True if both tokens are non-empty and byte-identical
 */
export function timingSafeTokenCompare(expected: string, provided?: string): boolean {
  if (!provided || typeof provided !== 'string') {
    return false;
  }
  const expectedBuf = Buffer.from(expected, 'utf-8');
  const providedBuf = Buffer.from(provided, 'utf-8');
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Streamable HTTP MCP Server serving editor capabilities to TrueForge.
 */
export class McpToolServer {
  private readonly host: UiHost;
  private readonly configuredName: string;
  private readonly configuredPort: number;
  private serverToken: string;
  private budget?: RunBudget;

  private httpServer: http.Server | null = null;
  private actualPort: number | null = null;
  private actualUrl: string | null = null;
  private readonly activeSockets = new Set<net.Socket>();

  // Pluggable handler overrides for future milestones
  private customProposeEditHandler?: (
    args: z.infer<typeof proposeEditInputSchema>,
    ctx: ToolExecutionContext
  ) => Promise<ToolCallResult>;

  private customCreateFileHandler?: (
    args: z.infer<typeof createFileInputSchema>,
    ctx: ToolExecutionContext
  ) => Promise<ToolCallResult>;

  private customRunCommandHandler?: (
    args: z.infer<typeof runCommandInputSchema>,
    ctx: ToolExecutionContext
  ) => Promise<ToolCallResult>;

  constructor(host: UiHost, options?: McpToolServerOptions) {
    this.host = host;
    this.configuredName = options?.name ?? DEFAULT_MCP_CONNECTOR_NAME;
    this.configuredPort = options?.port ?? DEFAULT_MCP_PORT;
    this.serverToken = options?.token ?? crypto.randomBytes(32).toString('hex');
    this.budget = options?.budget;
  }

  /** Gets the connector name registered with TrueForge. */
  public get name(): string {
    return this.configuredName;
  }

  /** Gets the actual bound listening port, or null if stopped. */
  public get port(): number | null {
    return this.actualPort;
  }

  /** Gets the full streamable HTTP endpoint URL, or null if stopped. */
  public get url(): string | null {
    return this.actualUrl;
  }

  /** Gets the 32-byte secret authentication token. */
  public get token(): string {
    return this.serverToken;
  }

  /** Gets true if the HTTP server is currently listening. */
  public get isRunning(): boolean {
    return this.httpServer !== null && this.actualPort !== null;
  }

  /** Gets a complete snapshot of server metadata. */
  public get info(): McpServerInfo {
    return {
      name: this.name,
      port: this.actualPort ?? 0,
      url: this.actualUrl ?? '',
      token: this.serverToken,
      isRunning: this.isRunning,
    };
  }

  /** Attaches or updates the active RunBudget instance. */
  public setBudget(budget?: RunBudget): void {
    this.budget = budget;
  }

  /** Pluggable hook allowing Milestone E-05 to attach production proposal handlers. */
  public setProposalHandlers(handlers: {
    proposeEdit?: (args: z.infer<typeof proposeEditInputSchema>, ctx: ToolExecutionContext) => Promise<ToolCallResult>;
    createFile?: (args: z.infer<typeof createFileInputSchema>, ctx: ToolExecutionContext) => Promise<ToolCallResult>;
  }): void {
    if (handlers.proposeEdit) {
      this.customProposeEditHandler = handlers.proposeEdit;
    }
    if (handlers.createFile) {
      this.customCreateFileHandler = handlers.createFile;
    }
  }

  /** Pluggable hook allowing Milestone E-10 to attach production command handlers. */
  public setCommandHandlers(handlers: {
    runCommand?: (args: z.infer<typeof runCommandInputSchema>, ctx: ToolExecutionContext) => Promise<ToolCallResult>;
  }): void {
    if (handlers.runCommand) {
      this.customRunCommandHandler = handlers.runCommand;
    }
  }

  /**
   * Starts the MCP server on loopback (127.0.0.1) with automatic port collision fallback.
   *
   * @returns Server metadata containing actual listening port and URL
   */
  public async start(): Promise<McpServerInfo> {
    if (this.isRunning) {
      return this.info;
    }

    let portCandidate = this.configuredPort;
    const maxCandidate = portCandidate + MAX_PORT_SCAN_ATTEMPTS;

    while (portCandidate <= maxCandidate) {
      try {
        await this.bindServer(portCandidate);
        break;
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === 'EADDRINUSE' && portCandidate < maxCandidate) {
          portCandidate++;
          continue;
        }
        throw err;
      }
    }

    return this.info;
  }

  /**
   * Stops the MCP server, destroys all open sockets, and releases the listening port.
   * Safe to call multiple times (idempotent).
   */
  public async stop(): Promise<void> {
    if (!this.httpServer) {
      return;
    }

    // 1. Destroy all active socket connections immediately
    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch {
        // Ignore socket destroy errors during teardown
      }
    }
    this.activeSockets.clear();

    // 2. Close HTTP listener
    const serverToClose = this.httpServer;
    this.httpServer = null;
    this.actualPort = null;
    this.actualUrl = null;

    await new Promise<void>((resolve) => {
      serverToClose.close(() => resolve());
    });
  }

  /**
   * Internal method binding the Node HTTP server to 127.0.0.1 on a specific port.
   */
  private bindServer(targetPort: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res).catch((err: unknown) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(`Internal Server Error: ${(err as Error).message}`);
          }
        });
      });

      // Track active sockets for immediate teardown on stop()
      server.on('connection', (socket) => {
        this.activeSockets.add(socket);
        socket.on('close', () => {
          this.activeSockets.delete(socket);
        });
      });

      const errorHandler = (err: Error) => {
        server.close();
        reject(err);
      };
      server.once('error', errorHandler);

      server.listen(targetPort, '127.0.0.1', () => {
        server.removeListener('error', errorHandler);
        const addr = server.address() as net.AddressInfo;
        this.httpServer = server;
        this.actualPort = addr.port;
        this.actualUrl = `http://127.0.0.1:${addr.port}/mcp`;
        resolve();
      });
    });
  }

  /**
   * Handles incoming HTTP requests: validates authority, auth token, method, body,
   * then attaches a fresh stateless McpServer instance and StreamableHTTPServerTransport.
   */
  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const currentPort = this.actualPort;
    if (!currentPort) {
      res.writeHead(503, { 'Content-Type': 'text/plain' }).end('Service Unavailable');
      return;
    }

    // 1. Strict Host authority validation (must include the exact listening port)
    const rawHost = (req.headers.host ?? '').trim().toLowerCase();
    const allowedAuthorities = new Set([
      `127.0.0.1:${currentPort}`,
      `localhost:${currentPort}`,
    ]);

    if (!rawHost || !allowedAuthorities.has(rawHost)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: invalid or untrusted Host authority');
      return;
    }

    // 2. Strict endpoint path check (only /mcp is served)
    const reqUrl = req.url?.split('?')[0];
    if (reqUrl !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found: MCP server endpoint is at /mcp');
      return;
    }

    // 3. Constant-time token authentication check
    const providedToken = req.headers['x-forge-token'] as string | undefined;
    if (!timingSafeTokenCompare(this.serverToken, providedToken)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized: missing or invalid x-forge-token');
      return;
    }

    // 4. HTTP method validation (stateless Streamable HTTP uses POST and GET)
    const method = req.method?.toUpperCase();
    if (method !== 'POST' && method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed: only GET and POST are supported');
      return;
    }

    // 5. Read body for POST requests with size cap and JSON validation
    let parsedBody: unknown = undefined;
    if (method === 'POST') {
      // Content-type check
      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.includes('application/json')) {
        res.writeHead(415, { 'Content-Type': 'text/plain' });
        res.end('Unsupported Media Type: Content-Type must be application/json');
        return;
      }

      let rawBody = '';
      let receivedBytes = 0;

      for await (const chunk of req) {
        const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += bufferChunk.length;
        if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end('Payload Too Large: request body exceeds 2 MB limit');
          return;
        }
        rawBody += bufferChunk.toString('utf-8');
      }

      if (rawBody.trim()) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request: malformed JSON payload');
          return;
        }
      }
    }

    // 6. Create dedicated McpServer instance and stateless transport per request
    // This guarantees concurrent requests never conflict or overwrite transport handles
    const mcpInstance = this.createMcpInstance();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
      enableJsonResponse: true,
    });

    const cleanup = () => {
      transport.close().catch(() => {});
      mcpInstance.close().catch(() => {});
    };

    res.once('close', cleanup);
    res.once('error', cleanup);

    await mcpInstance.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  }

  /**
   * Factory constructing a fresh McpServer instance with all eight frozen contract tools registered.
   */
  private createMcpInstance(): McpServer {
    const server = new McpServer({
      name: this.configuredName,
      version: '2.1.0',
    });

    const executionContext: ToolExecutionContext = {
      host: this.host,
      budget: this.budget,
    };

    // 1. repoMap
    server.registerTool(
      REPO_MAP_TOOL_NAME,
      {
        description: REPO_MAP_TOOL_DESCRIPTION,
        inputSchema: repoMapInputSchema,
      },
      async (args) => {
        return handleRepoMap(args, executionContext);
      }
    );

    // 2. searchWorkspace
    server.registerTool(
      SEARCH_WORKSPACE_TOOL_NAME,
      {
        description: SEARCH_WORKSPACE_TOOL_DESCRIPTION,
        inputSchema: searchWorkspaceInputSchema,
      },
      async (args) => {
        return handleSearchWorkspace(args, executionContext);
      }
    );

    // 3. findSymbol
    server.registerTool(
      FIND_SYMBOL_TOOL_NAME,
      {
        description: FIND_SYMBOL_TOOL_DESCRIPTION,
        inputSchema: findSymbolInputSchema,
      },
      async (args) => {
        return handleFindSymbol(args, executionContext);
      }
    );

    // 4. readFile
    server.registerTool(
      READ_FILE_TOOL_NAME,
      {
        description: READ_FILE_TOOL_DESCRIPTION,
        inputSchema: readFileInputSchema,
      },
      async (args) => {
        return handleReadFile(args, executionContext);
      }
    );

    // 5. reportContext
    server.registerTool(
      REPORT_CONTEXT_TOOL_NAME,
      {
        description: REPORT_CONTEXT_TOOL_DESCRIPTION,
        inputSchema: reportContextInputSchema,
      },
      async (args) => {
        return handleReportContext(args, executionContext);
      }
    );

    // 6. proposeEdit (Milestone E-05 deferred stub or custom handler)
    server.registerTool(
      'proposeEdit',
      {
        description:
          'Propose search/replace edits to an existing workspace file (approval-gated).\nUse when modifying existing code after reviewing its content.',
        inputSchema: proposeEditInputSchema,
      },
      async (args) => {
        if (this.customProposeEditHandler) {
          return this.customProposeEditHandler(args, executionContext);
        }
        return {
          content: [
            {
              type: 'text',
              text: 'proposeEdit handler deferred to Milestone E-05 (ProposalStore & approval bridge).',
            },
          ],
          isError: true,
        };
      }
    );

    // 7. createFile (Milestone E-05 deferred stub or custom handler)
    server.registerTool(
      'createFile',
      {
        description:
          'Propose creating a new workspace file with initial content (approval-gated).\nUse when adding a new source file, test, or document.',
        inputSchema: createFileInputSchema,
      },
      async (args) => {
        if (this.customCreateFileHandler) {
          return this.customCreateFileHandler(args, executionContext);
        }
        return {
          content: [
            {
              type: 'text',
              text: 'createFile handler deferred to Milestone E-05 (ProposalStore & approval bridge).',
            },
          ],
          isError: true,
        };
      }
    );

    // 8. runCommand (Milestone E-10 deferred stub or custom handler)
    server.registerTool(
      'runCommand',
      {
        description:
          'Execute an allowed terminal command within policy tiers.\nUse when running test suites or checking git status after changes.',
        inputSchema: runCommandInputSchema,
      },
      async (args) => {
        if (this.customRunCommandHandler) {
          return this.customRunCommandHandler(args, executionContext);
        }
        return {
          content: [
            {
              type: 'text',
              text: 'runCommand handler deferred to Milestone E-10 (terminalPolicy).',
            },
          ],
          isError: true,
        };
      }
    );

    return server;
  }
}
