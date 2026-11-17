/**
 * MockUiHost — vscode-free stand-in for UiHost used by the mock engine.
 *
 * - Reads files from disk (workspace-relative, forward slashes).
 * - Simple text search.
 * - snapshot() uses open document text if open, else disk.
 * - runCommand() is a stub that returns a success result.
 *
 * No vscode import; unit-testable in isolation.
 */

import type {
  UiHost,
  ContextProvider,
  CommandRequest,
  CommandResult,
  DocSnapshot,
  LineRange,
  ResolvedMention,
  ContextItem,
} from '../types/contract';

export type { CommandRequest, CommandResult, DocSnapshot };

/** Minimal ContextProvider stub returning empty results. */
class MockContextProvider implements ContextProvider {
  async resolveMention(_raw: string): Promise<ResolvedMention | null> {
    return null;
  }

  async seed(_prompt: string, _budgetTokens: number): Promise<ContextItem[]> {
    return [];
  }

  async search(_q: { query: string; glob?: string; maxResults?: number }): Promise<{ hits: { path: string; line: number; preview: string }[]; omitted: number }> {
    return { hits: [], omitted: 0 };
  }

  async findSymbol(_q: { name: string }): Promise<{ symbols: { name: string; path: string; line: number; kind: string }[] }> {
    return { symbols: [] };
  }

  async repoMap(_q: { dir?: string; depth?: number }): Promise<{ tree: string; truncated: boolean }> {
    return { tree: '', truncated: false };
  }
}

/** Workspace root. Overridden on construction. */
export class MockUiHost implements UiHost {
  workspaceRoot: string;
  context: ContextProvider;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.context = new MockContextProvider();
  }

  /** Mark a document as open so snapshot() uses its (dirty) text. */
  openDocument(_path: string, _text: string, _version: number, _isDirty: boolean): void {
    // Intentionally unused in the mock.
  }

  isWorkspaceTrusted(): boolean {
    // Mock host is always trusted; real host enforces doc-trust gate.
    return true;
  }

  snapshot(path: string): Promise<DocSnapshot> {
    return Promise.resolve(this.snapshotSync(path));
  }

  private snapshotSync(_unused: string): DocSnapshot {
    // Mock host has no real filesystem; return an empty, nonexist state.
    // Note: when implementing real snapshot content hash (E-03), normalize CRLF to LF before SHA-256 hashing.
    return {
      path: _unused,
      exists: false,
      text: '',
      version: null,
      isDirty: false,
      contentHash: '0'.repeat(64),
    };
  }

  readFile(path: string, range?: LineRange): Promise<string> {
    return Promise.resolve(this.readFileSync(path, range));
  }

  private readFileSync(_path: string, range?: LineRange): string {
    if (!range) return '';
    const lines: string[] = [];
    for (let i = range.startLine - 1; i < range.endLine && i < 100; i++) {
      lines.push(`mock line ${i + 1}`);
    }
    return lines.join('\n');
  }

  async runCommand(_req: CommandRequest, _signal?: AbortSignal): Promise<CommandResult> {
    // Stub: never actually executes; mock host returns success.
    return {
      exitCode: 0,
      stdout: 'mock command ok',
      stderr: '',
      truncated: false,
      timedOut: false,
      killed: false,
    };
  }

  confirmCommand(_c: { display: string; reason: string }): Promise<boolean> {
    return Promise.resolve(true);
  }
}
