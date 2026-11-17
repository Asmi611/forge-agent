/**
 * Forge Agent — mock vscode namespace (S-01 smoke test only).
 *
 * Provides a stub `vscode` object so src/extension.ts can be imported
 * and its `forge.showDemoDiff` command registered without a VS Code
 * extension host. This is a bootstrap placeholder; no real VS Code
 * API surface is provided.
 *
 * Do not use this file for anything beyond the S-01 e2e smoke test.
 */

/** Minimal fake command registration sink. */
class Command {
  constructor(public readonly commandId: string) {
    this.commandId = commandId;
  }
}

/** Fake window surface. */
const window = {
  showInformationMessage: (_msg: string) => { /* no-op */ },
  showWarningMessage: (_msg: string) => { /* no-op */ },
};

/** Fake workspace surface. */
const workspace = {
  workspaceFolders: [{ uri: { path: '', fsPath: '', authority: '' } }],
  fs: {
    readFile: async (_uri: Uint8Array) => Buffer.alloc(0),
  },
  openTextDocument: async (options: { content: string; language: string }) => {
    return {
      uri: options.content,
      language: options.language,
      get text() { return ''; },
    };
  },
};

/** vscode.commands with a registerCommand sink. */
const commands = {
  registerCommand: (
    commandId: string,
    callback: (args: unknown) => unknown
  ) => {
    (window as unknown as Record<string, unknown>).__forgedCommandId = commandId;
    (window as unknown as Record<string, unknown>).__forgedCommandCallback = callback;
    return new Command(commandId);
  },
  executeCommand: async (_commandId: string, ..._args: unknown[]) => {
    return undefined;
  },
};

/** vscode.Uri (type-only, not used at runtime by the placeholder). */
const Uri = {
  joinPath: (..._parts: string[]) => _parts.join('/'),
};

export { Command, window, workspace, commands, Uri };
