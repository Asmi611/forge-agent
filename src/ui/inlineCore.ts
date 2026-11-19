/** inlineCore.ts -- the vscode-free part of Ctrl+K: check the selection and build the engine request. Fully unit tested. */
import type { InlineRequest } from '../types/contract';

export interface InlineInput {
  hasEditor: boolean;
  scheme: string;            // 'file' | 'untitled' | ...
  fsPath: string;            // absolute path of the open file
  workspaceRoot: string | undefined;
  startLine0: number; startChar: number; endLine0: number; endChar: number; // 0-based, as VS Code gives them
  selectedText: string;
  instruction: string;
}

export type InlineCheck = { ok: true; request: InlineRequest } | { ok: false; message: string };

export const MAX_SELECTION_LINES = 400;

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');

/** Workspace-relative path with forward slashes, or undefined when the file is outside the folder. */
export function relativeToRoot(fsPath: string, root: string): string | undefined {
  const f = norm(fsPath);
  const r = norm(root);
  const win = /^[a-zA-Z]:\//.test(r);
  const fl = win ? f.toLowerCase() : f;
  const rl = win ? r.toLowerCase() : r;
  if (!fl.startsWith(rl + '/')) return undefined;
  return f.slice(r.length + 1);
}

/** Step 1: is there something we can edit? (checked BEFORE asking for an instruction) */
export function checkTarget(i: Omit<InlineInput, 'instruction'>): { ok: true; path: string; startLine: number; endLine: number } | { ok: false; message: string } {
  if (!i.hasEditor) return { ok: false, message: 'Forge: open a file first, then select the code you want to change.' };
  if (i.scheme === 'untitled') return { ok: false, message: 'Forge: please save this file first (Ctrl+S), then try again.' };
  if (i.scheme !== 'file') return { ok: false, message: 'Forge: this kind of tab cannot be edited. Open a normal file in your project.' };
  if (!i.workspaceRoot) return { ok: false, message: 'Forge: open your project folder first (File > Open Folder).' };
  const path = relativeToRoot(i.fsPath, i.workspaceRoot);
  if (path === undefined) return { ok: false, message: 'Forge: this file is outside your project folder, so Forge will not change it.' };
  const empty = i.selectedText.trim() === '' || (i.startLine0 === i.endLine0 && i.startChar === i.endChar);
  if (empty) return { ok: false, message: 'Forge: select the code you want to change first, then press Ctrl+K.' };
  const startLine = i.startLine0 + 1;
  const endLine = i.endChar === 0 && i.endLine0 > i.startLine0 ? i.endLine0 : i.endLine0 + 1; // a selection ending at column 0 does not include that line
  if (endLine - startLine + 1 > MAX_SELECTION_LINES) return { ok: false, message: `Forge: that is a lot of code (over ${MAX_SELECTION_LINES} lines). Select a smaller piece, such as one function.` };
  return { ok: true, path, startLine, endLine };
}

/** Step 2: with the instruction typed, build the request. */
export function buildInlineRequest(i: InlineInput): InlineCheck {
  const t = checkTarget(i);
  if (!t.ok) return t;
  const prompt = i.instruction.trim();
  if (!prompt) return { ok: false, message: 'Forge: type what you want changed, for example "add a docstring".' };
  return { ok: true, request: { prompt, path: t.path, selectedText: i.selectedText, range: { startLine: t.startLine, endLine: t.endLine } } };
}
