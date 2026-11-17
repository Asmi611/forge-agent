/**
 * Forge Agent — mock vscode namespace (S-01 smoke test only).
 *
 * CommonJS stub of the `vscode` namespace so the compiled extension
 * (out/extension.js) can be required and its forge.showDemoDiff command
 * registered without a VS Code extension host. Bootstrap placeholder only;
 * no real VS Code API surface is provided.
 *
 * The compiled extension references the namespace as:
 *   vscode.commands.registerCommand(...)
 *   vscode.commands.executeCommand(...)
 *   vscode.window.showInformationMessage(...)
 *   vscode.workspace.fs.readFile(...)
 *   vscode.workspace.openTextDocument(...)
 *   vscode.Uri.joinPath(...)
 *
 * This mock exposes those shapes.
 *
 * Do not use this file for anything beyond the S-01 e2e smoke test.
 */

/** Minimal fake command registration sink. */
class Command {
  constructor(commandId, callback) {
    this.commandId = commandId;
    this._callback = callback;
  }
}

/** Fake window surface. */
const window = {
  showInformationMessage: function (_msg) { /* no-op */ },
  showWarningMessage: function (_msg) { /* no-op */ },
};

/** Fake workspace surface. */
const workspace = {
  workspaceFolders: [{ uri: { path: '', fsPath: '', authority: '' } }],
  fs: {
    readFile: async function (_uri) { return Buffer.alloc(0); },
  },
  openTextDocument: async function (options) {
    return {
      uri: options.content,
      language: options.language,
      get text() { return ''; },
    };
  },
};

/** The `vscode.commands` surface the compiled extension invokes. */
const commands = {
  registerCommand: function (commandId, callback) {
    commands.__forgedCommandId = commandId;
    commands.__forgedCommandCallback = callback;
    return new Command(commandId, callback);
  },
  executeCommand: async function (_commandId, ..._args) {
    return undefined;
  },
};

/** vscode.Uri (type-only, not used at runtime by the placeholder). */
const Uri = {
  joinPath: function () {
    return Array.prototype.join.call(arguments, '/');
  },
};

/** The full vscode namespace the extension expects. */
const vscode = {
  commands,
  window,
  workspace,
  Uri,
};

module.exports = { vscode, Command, window, workspace, Uri };
