/**
 * workspaceContext.ts -- connects the context finder to the real VS Code workspace.
 *
 *  - finds the project's files (skipping node_modules, .venv, .git ... ) and reads them (open, unsaved tabs first)
 *  - builds the index in the background in small chunks, so the editor never freezes
 *  - keeps the index fresh when files are created, changed or deleted
 *  - reads the settings forge.context.*
 * It only READS files. It never writes anything.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ContextProviderImpl, DEFAULT_PROVIDER_CONFIG, type ProviderConfig } from './ContextProviderImpl';
import { CODE_EXTENSIONS, DEFAULT_EXCLUDES, WorkspaceIndex, isExcludedPath, type FileEntry, type FileSource } from './indexer';
import { DEFAULT_RANKER_CONFIG } from './ranker';

const MAX_READ_BYTES = 1_000_000;
const MAX_FILES = 20_000;

const GLOB = `**/*.{${[...CODE_EXTENSIONS].join(',')}}`;
const EXCLUDE_GLOB = `{${DEFAULT_EXCLUDES.map((d) => `**/${d}/**`).join(',')}}`;

export interface WorkspaceContext extends vscode.Disposable {
  provider: ContextProviderImpl;
  index: WorkspaceIndex;
  /** Resolves when the first index build is finished. */
  ready(): Promise<void>;
}

const positive = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback);

/** Settings forge.context.* (weights, seed budget). Bad values fall back to the defaults. */
export function readProviderConfig(): ProviderConfig {
  const c = vscode.workspace.getConfiguration('forge.context');
  const w = DEFAULT_RANKER_CONFIG.weights;
  return {
    ranker: {
      ...DEFAULT_RANKER_CONFIG,
      weights: {
        path: positive(c.get('weights.path'), w.path),
        symbols: positive(c.get('weights.symbols'), w.symbols),
        headings: positive(c.get('weights.headings'), w.headings),
        body: positive(c.get('weights.body'), w.body),
      },
    },
    seedBudgetTokens: Math.floor(positive(c.get('seedBudgetTokens'), DEFAULT_PROVIDER_CONFIG.seedBudgetTokens)),
  };
}

class VscodeFileSource implements FileSource {
  constructor(private readonly root: vscode.Uri) {}

  private rel(fsPath: string): string {
    return path.relative(this.root.fsPath, fsPath).split(path.sep).join('/');
  }

  async entry(fsPath: string): Promise<FileEntry | undefined> {
    try {
      const s = await fs.promises.stat(fsPath);
      return s.isFile() ? { path: this.rel(fsPath), size: s.size, mtimeMs: s.mtimeMs } : undefined;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<FileEntry[]> {
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(this.root, GLOB), EXCLUDE_GLOB, MAX_FILES);
    const out: FileEntry[] = [];
    for (let i = 0; i < uris.length; i += 50) {
      const batch = await Promise.all(uris.slice(i, i + 50).map((u) => this.entry(u.fsPath)));
      for (const e of batch) if (e) out.push(e);
    }
    return out;
  }

  async read(rel: string): Promise<string | undefined> {
    const abs = path.join(this.root.fsPath, ...rel.split('/'));
    const open = vscode.workspace.textDocuments.find((d) => !d.isClosed && d.uri.scheme === 'file' && d.uri.fsPath === abs);
    if (open) return open.getText(); // what is on screen, even if not saved yet
    try {
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile() || stat.size > MAX_READ_BYTES) return undefined;
      const buf = await fs.promises.readFile(abs);
      if (buf.subarray(0, 8000).includes(0)) return undefined; // a binary file
      return buf.toString('utf8');
    } catch {
      return undefined;
    }
  }
}

/** Start the context finder for the open folder. The index builds in the background. */
export function createWorkspaceContext(root: vscode.Uri, output: { appendLine(line: string): void }): WorkspaceContext {
  const source = new VscodeFileSource(root);
  const index = new WorkspaceIndex();
  const build = index
    .build(source)
    .then(() => output.appendLine(`[context] indexed ${index.files.size} files in ${index.lastBuildMs} ms`))
    .catch((err: unknown) => output.appendLine(`[context] could not index the folder: ${err instanceof Error ? err.message : String(err)}`));
  const provider = new ContextProviderImpl({ source, index, ready: () => build, config: readProviderConfig });

  // Keep the index fresh: one small update per changed file.
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, GLOB));
  const refresh = (uri: vscode.Uri): void => {
    void (async () => {
      const rel = path.relative(root.fsPath, uri.fsPath).split(path.sep).join('/');
      if (isExcludedPath(rel)) return;
      const entry = await source.entry(uri.fsPath);
      const text = entry ? await source.read(rel) : undefined;
      if (entry && text !== undefined) index.update(entry, text);
    })();
  };
  const subscriptions = [
    watcher,
    watcher.onDidCreate(refresh),
    watcher.onDidChange(refresh),
    watcher.onDidDelete((uri) => index.remove(path.relative(root.fsPath, uri.fsPath).split(path.sep).join('/'))),
  ];

  return {
    provider,
    index,
    ready: () => build,
    dispose: () => subscriptions.forEach((s) => s.dispose()),
  };
}
