/**
 * Forge Agent — smoke tests (S-01).
 *
 * Vitest tests run without a VS Code host. Their purpose is to verify the
 * bindings around the real extension module (registerDemoDiffCommand)
 * without launching a VS Code host. Rather than requiring the pre-built
 * CommonJS `out/extension.js` (which does require("vscode") and needs a VS
 * Code host to resolve it), these tests import the extension source
 * (`src/extension.ts`) with the `vscode` module stubbed, so the command
 * registration can be verified in a plain Node process.
 *
 * These are NOT vscode extension tests: they don't launch a VS Code host
 * and don't use @vscode/test-electron/runTests. That stays a separate
 * test/e2e harness.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import type * as vscode from 'vscode';

// Stub the `vscode` module so the extension (which imports `vscode`) loads
// in this non-VS Code process. The mock mimics the real vscode namespace
// surface used by src/extension.ts.
const mockCommands = {
  __forgedCommandId: undefined,
  registerCommand: (_commandId: string, _cb: () => unknown) => {
    (mockCommands as { __forgedCommandId?: string }).__forgedCommandId = _commandId;
    return {};
  },
  getCommands: () => [],
};
const mockWindow = {
  showInformationMessage: vi.fn((_msg: string) => undefined),
  showWarningMessage: vi.fn((_msg: string) => undefined),
};
const mockWorkspace = {
  workspaceFolders: [{ uri: { path: '', fsPath: '', authority: '' } }],
  fs: {
    readFile: vi.fn(async () => Buffer.alloc(0)),
  },
  openTextDocument: vi.fn(async () => ({
    uri: '',
    language: '',
    get text() { return ''; },
  })),
};

// Stub the `vscode` module. `vi.mock` applies to the whole module graph,
// including `src/extension.ts` which does `import * as vscode from 'vscode'`.
vi.mock('vscode', () => ({
  commands: mockCommands,
  window: mockWindow,
  workspace: mockWorkspace,
  Uri: { joinPath: (..._parts: string[]) => _parts.join('/') },
}));

// The extension source is imported so `vscode` resolves to the stub.
// `registerDemoDiffCommand` is the wiring function under test.
let registerDemoDiffCommand: ((context: vscode.ExtensionContext) => void) | null =
  null;

beforeAll(async () => {
  const mod = await import('../../src/extension.ts');
  registerDemoDiffCommand = mod.registerDemoDiffCommand;
});

describe('forge-agent smoke tests (S-01)', () => {
  it('registerDemoDiffCommand is exported and is a function', () => {
    expect(typeof registerDemoDiffCommand).toBe('function');
  });

  it('registers forge.showDemoDiff into the mock command sink', () => {
    expect(registerDemoDiffCommand).not.toBeNull();
    const context = {
      subscriptions: [] as unknown[],
      extensionUri: undefined as unknown as vscode.Uri,
      globalState: {} as unknown as vscode.Memento,
      workspaceState: {} as unknown as vscode.Memento,
      secrets: {} as unknown as vscode.SecretStorage,
      extensionPath: '',
      asAbsolutePath: vi.fn(() => '' as unknown as string),
    } as unknown as vscode.ExtensionContext;
    registerDemoDiffCommand! (context);
    expect(context.subscriptions).toBeDefined();
    expect(Array.isArray(context.subscriptions)).toBe(true);
    expect(context.subscriptions.length).toBeGreaterThan(0);
    const registered = mockCommands.__forgedCommandId === 'forge.showDemoDiff';
    expect(registered).toBe(true);
  });
});
