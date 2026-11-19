/**
 * src/ui/index.ts -- createUiHost(): what Forge's engine is allowed to ask of the editor.
 *
 *  snapshot / readFile   the open document if there is one (even unsaved), otherwise the file on disk
 *  confirmCommand        a small notification: Allow once / Allow for this run / Deny (never blocks typing)
 *  runCommand            runs ONE program by name, in the workspace folder, with a clean environment
 *
 * The safety rules for commands live in hostCore.ts (and are unit tested).
 * This file only connects them to VS Code. It never writes workspace files.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { createEmptyContext } from '../context/emptyContext';
import { hashText, isSafeRelativePath } from '../review/applyCore';
import type { CommandRequest, CommandResult, ContextProvider, DocSnapshot, LineRange, UiHost } from '../types/contract';
import { runCommandCore, sliceLines } from './hostCore';

export interface UiHostOptions {
  root: vscode.Uri;
  /** Where to log what ran (the Forge Output channel). */
  output: { appendLine(line: string): void };
  /** The context finder. Defaults to an empty placeholder until the real one exists. */
  context?: ContextProvider;
}

/** A UiHost plus `endRun()`, which forgets "Allow for this run". */
export type ForgeUiHost = UiHost & { endRun(): void };

const CONFIRM_TIMEOUT_MS = 120_000;
const MAX_FILE_BYTES = 2_000_000;

/** Build the real UiHost for the folder that is open. */
export function createUiHost(options: UiHostOptions): ForgeUiHost {
  const rootPath = options.root.fsPath;
  const uriFor = (rel: string): vscode.Uri => vscode.Uri.joinPath(options.root, ...rel.split('/'));
  let allowAllForRun = false;

  /** Refuse anything outside the folder, including a shortcut (symlink) that points outside. */
  async function checkInside(rel: string): Promise<void> {
    if (!isSafeRelativePath(rel)) throw new Error(`"${rel}" is not a path inside the folder you opened.`);
    try {
      const real = await fs.promises.realpath(path.join(rootPath, ...rel.split('/')));
      const realRoot = await fs.promises.realpath(rootPath);
      const inside = real === realRoot || real.startsWith(realRoot + path.sep);
      if (!inside) throw new Error(`"${rel}" points outside the folder you opened.`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // a missing file is handled by the caller
      throw err;
    }
  }

  function openDocument(rel: string): vscode.TextDocument | undefined {
    const key = uriFor(rel).toString();
    return vscode.workspace.textDocuments.find((d) => !d.isClosed && d.uri.toString() === key);
  }

  async function diskText(rel: string): Promise<string | undefined> {
    let size: number;
    try {
      size = (await vscode.workspace.fs.stat(uriFor(rel))).size;
    } catch {
      return undefined; // does not exist
    }
    if (size > MAX_FILE_BYTES) throw new Error(`"${rel}" is too large to read.`);
    return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uriFor(rel)));
  }

  const host: ForgeUiHost = {
    workspaceRoot: rootPath,
    context: options.context ?? createEmptyContext(),

    isWorkspaceTrusted: () => vscode.workspace.isTrusted,

    async snapshot(rel: string): Promise<DocSnapshot> {
      await checkInside(rel);
      const doc = openDocument(rel);
      if (doc) {
        const text = doc.getText();
        return { path: rel, exists: true, text, version: doc.version, isDirty: doc.isDirty, contentHash: hashText(text) };
      }
      const text = await diskText(rel);
      if (text === undefined) return { path: rel, exists: false, text: '', version: null, isDirty: false, contentHash: hashText('') };
      return { path: rel, exists: true, text, version: null, isDirty: false, contentHash: hashText(text) };
    },

    async readFile(rel: string, range?: LineRange): Promise<string> {
      await checkInside(rel);
      const doc = openDocument(rel);
      const text = doc ? doc.getText() : await diskText(rel);
      if (text === undefined) throw new Error(`File not found: ${rel}`);
      return sliceLines(text, range);
    },

    async confirmCommand(c: { display: string; reason: string }): Promise<boolean> {
      if (!vscode.workspace.isTrusted) return false;
      if (allowAllForRun) return true;
      const answer = await Promise.race([
        vscode.window.showInformationMessage(
          `Forge wants to run: ${c.display}\n${c.reason}`,
          'Allow once',
          'Allow for this run',
          'Deny',
        ),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), CONFIRM_TIMEOUT_MS)),
      ]);
      options.output.appendLine(`[command] ${c.display}: ${answer ?? 'no answer (treated as Deny)'}`);
      if (answer === 'Allow for this run') allowAllForRun = true;
      return answer === 'Allow once' || answer === 'Allow for this run';
    },

    async runCommand(req: CommandRequest, signal: AbortSignal): Promise<CommandResult> {
      if (!vscode.workspace.isTrusted) {
        return {
          exitCode: null, stdout: '', truncated: false, timedOut: false, killed: false,
          stderr: 'Commands are turned off because this folder is not trusted. Trust the folder in VS Code to allow them.',
        };
      }
      options.output.appendLine(`[command] running: ${req.file} ${req.args.join(' ')}`);
      const result = await runCommandCore(req, signal, { root: rootPath });
      options.output.appendLine(`[command] finished: exit ${result.exitCode ?? 'none'}${result.timedOut ? ' (timed out)' : ''}${result.killed ? ' (stopped)' : ''}`);
      return result;
    },

    endRun(): void {
      allowAllForRun = false;
    },
  };
  return host;
}
