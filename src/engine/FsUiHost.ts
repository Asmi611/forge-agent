/**
 * Filesystem-backed UiHost implementation for standalone engine CLI execution.
 *
 * Exposes real workspace file reads via Node.js fs APIs with path containment,
 * directory rejection, line range slicing, and LF-normalized document snapshots.
 * Strictly read-only: no file modification, creation, or deletion APIs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type {
  UiHost,
  ContextProvider,
  CommandRequest,
  CommandResult,
  DocSnapshot,
  LineRange,
  ResolvedMention,
  ContextItem,
} from '../types/contract.ts';

/**
 * Checks whether a target path is contained strictly within the workspace root.
 * Handles Windows case-insensitivity and directory boundary slashes safely.
 */
function isContainedInRoot(workspaceRoot: string, targetPath: string): boolean {
  const isWindows = process.platform === 'win32';
  const normRoot = isWindows ? workspaceRoot.toLowerCase() : workspaceRoot;
  const normTarget = isWindows ? targetPath.toLowerCase() : targetPath;

  if (normTarget === normRoot) {
    return true;
  }

  const rootPrefix = normRoot.endsWith(path.sep) ? normRoot : `${normRoot}${path.sep}`;
  return normTarget.startsWith(rootPrefix);
}

/**
 * Read-only ContextProvider for standalone CLI execution.
 */
class FsContextProvider implements ContextProvider {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /** Resolves mention references (unsupported in standalone CLI). */
  async resolveMention(_raw: string): Promise<ResolvedMention | null> {
    return null;
  }

  /** Seeds context items for a prompt (unsupported in standalone CLI). */
  async seed(_prompt: string, _budgetTokens: number): Promise<ContextItem[]> {
    return [];
  }

  /** Searches workspace for text patterns (returns empty hits in CLI mode). */
  async search(_q: { query: string; glob?: string; maxResults?: number }): Promise<{ hits: { path: string; line: number; preview: string }[]; omitted: number }> {
    return { hits: [], omitted: 0 };
  }

  /** Finds symbol definitions across workspace (returns empty list in CLI mode). */
  async findSymbol(_q: { name: string }): Promise<{ symbols: { name: string; path: string; line: number; kind: string }[] }> {
    return { symbols: [] };
  }

  /** Generates a basic directory tree of the workspace up to specified depth. */
  async repoMap(q: { dir?: string; depth?: number }): Promise<{ tree: string; truncated: boolean }> {
    try {
      const normalizedDir = q.dir ? q.dir.replace(/\\/g, '/') : undefined;
      if (normalizedDir && /^[a-zA-Z]:/.test(normalizedDir) && process.platform !== 'win32') {
        return { tree: '', truncated: false };
      }
      const targetDir = normalizedDir ? path.resolve(this.workspaceRoot, normalizedDir) : this.workspaceRoot;
      if (!isContainedInRoot(this.workspaceRoot, targetDir) || !fs.existsSync(targetDir)) {
        return { tree: '', truncated: false };
      }
      const lines: string[] = [];
      const maxDepth = q.depth ?? 3;
      const walk = (dir: string, depth: number, prefix: string) => {
        if (depth > maxDepth || lines.length >= 100) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
          lines.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`);
          if (entry.isDirectory()) {
            walk(path.join(dir, entry.name), depth + 1, `${prefix}  `);
          }
        }
      };
      walk(targetDir, 1, '');
      return { tree: lines.join('\n'), truncated: lines.length >= 100 };
    } catch {
      return { tree: '', truncated: false };
    }
  }
}

/**
 * Filesystem-backed UiHost for the standalone engine CLI.
 */
export class FsUiHost implements UiHost {
  public readonly workspaceRoot: string;
  public readonly context: ContextProvider;

  constructor(workspaceRoot: string) {
    if (!workspaceRoot || typeof workspaceRoot !== 'string') {
      throw new Error('FsUiHost: workspaceRoot must be a non-empty string');
    }
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.context = new FsContextProvider(this.workspaceRoot);
  }

  /** CLI workspace is explicitly trusted by the user invoking the CLI command. */
  isWorkspaceTrusted(): boolean {
    return true;
  }

  /**
   * Resolves a relative path safely within the workspace root, guarding against traversal.
   *
   * @param relPath - Path relative to workspaceRoot or absolute path
   * @returns Resolved canonical absolute path
   */
  private resolveSafePath(relPath: string): string {
    if (!relPath || typeof relPath !== 'string' || relPath.trim() === '') {
      throw new Error('Path argument cannot be empty');
    }
    if (relPath.includes('\0')) {
      throw new Error('Path contains illegal null byte character');
    }

    // Normalise backslashes to forward slashes at the start on all platforms
    const normalized = relPath.replace(/\\/g, '/');

    // Windows drive-letter path (e.g. C:\x or C:/x) on non-Windows platforms resolves outside workspace root
    if (/^[a-zA-Z]:/.test(normalized) && process.platform !== 'win32') {
      throw new Error(`Path '${relPath}' resolves outside workspace root ('${this.workspaceRoot}')`);
    }

    const resolved = path.isAbsolute(normalized)
      ? path.resolve(normalized)
      : path.resolve(this.workspaceRoot, normalized);

    if (!isContainedInRoot(this.workspaceRoot, resolved)) {
      throw new Error(`Path '${relPath}' resolves outside workspace root ('${this.workspaceRoot}')`);
    }

    return resolved;
  }

  /**
   * Reads real text content from a workspace file with optional 1-based line range filtering.
   *
   * @param relPath - Workspace-relative or absolute path
   * @param range - Optional 1-based line range { startLine, endLine }
   * @returns Text content of file or selected lines
   */
  async readFile(relPath: string, range?: LineRange): Promise<string> {
    const fullPath = this.resolveSafePath(relPath);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: '${relPath}'`);
    }

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      throw new Error(`Path '${relPath}' is a directory, not a file`);
    }

    const rawContent = fs.readFileSync(fullPath, 'utf-8');

    if (!range) {
      return rawContent;
    }

    if (range.startLine > range.endLine) {
      throw new Error(`Invalid line range: startLine (${range.startLine}) cannot be greater than endLine (${range.endLine})`);
    }

    const allLines = rawContent.split(/\r?\n/);
    const startIdx = Math.max(0, range.startLine - 1);
    const endIdx = Math.min(allLines.length, range.endLine);

    if (startIdx >= allLines.length) {
      return '';
    }

    return allLines.slice(startIdx, endIdx).join('\n');
  }

  /**
   * Takes a document snapshot from disk with LF-normalized SHA-256 content hash.
   *
   * @param relPath - Path to file
   * @returns DocSnapshot with file existence and hash
   */
  async snapshot(relPath: string): Promise<DocSnapshot> {
    const normalizedRel = relPath.replace(/\\/g, '/');
    try {
      const fullPath = this.resolveSafePath(relPath);
      if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
        return {
          path: normalizedRel,
          exists: false,
          text: '',
          version: null,
          isDirty: false,
          contentHash: '0'.repeat(64),
        };
      }

      const text = fs.readFileSync(fullPath, 'utf-8');
      const normalizedText = text.replace(/\r\n/g, '\n');
      const contentHash = crypto.createHash('sha256').update(normalizedText).digest('hex');

      return {
        path: normalizedRel,
        exists: true,
        text,
        version: 1,
        isDirty: false,
        contentHash,
      };
    } catch {
      return {
        path: normalizedRel,
        exists: false,
        text: '',
        version: null,
        isDirty: false,
        contentHash: '0'.repeat(64),
      };
    }
  }

  /**
   * Refuses command execution in standalone CLI mode.
   *
   * Standalone CLI does not implement terminal execution (Milestone E-10).
   * Explicitly returns a non-zero exit code (1) and descriptive stderr message,
   * guaranteeing callers never falsely assume a command executed or succeeded.
   */
  async runCommand(_req: CommandRequest, signal?: AbortSignal): Promise<CommandResult> {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'Command execution is not supported in standalone CLI mode (FsUiHost).',
      truncated: false,
      timedOut: false,
      killed: signal?.aborted ?? false,
    };
  }

  /**
   * Refuses command confirmation in standalone CLI mode.
   *
   * Standalone CLI does not provide an interactive confirmation UI.
   * Always returns false so confirm-tier commands are never silently or automatically approved.
   */
  async confirmCommand(_c: { display: string; reason: string }): Promise<boolean> {
    return false;
  }
}
