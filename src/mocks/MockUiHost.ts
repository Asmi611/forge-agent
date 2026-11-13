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


export interface CommandRequest {
  file: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
  maxOutputChars: number;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  killed: boolean;
}

export interface DocSnapshot {
  path: string;
  exists: boolean;
  text: string;
  version: number | null;
  isDirty: boolean;
  contentHash: string;
}

/** Workspace root. Overridden on construction. */
export class MockUiHost {
  workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
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
    return {
      path: _unused,
      exists: false,
      text: '',
      version: null,
      isDirty: false,
      contentHash: '0'.repeat(64),
    };
  }

  readFile(path: string, range?: { startLine: number; endLine: number }): Promise<string> {
    return Promise.resolve(this.readFileSync(path, range));
  }

  private readFileSync(_path: string, range?: { startLine: number; endLine: number }): string {
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
