import { describe, expect, it } from 'vitest';
import { buildInlineRequest, relativeToRoot, type InlineInput } from '../../src/ui/inlineCore';

const ok: InlineInput = { hasEditor: true, scheme: 'file', fsPath: '/w/proj/src/a.py', workspaceRoot: '/w/proj', startLine0: 9, startChar: 0, endLine0: 14, endChar: 5, selectedText: 'def f():\n  pass', instruction: ' add a docstring ' };

describe('Ctrl+K request', () => {
  it('builds a 1-based request with a trimmed prompt', () => {
    const r = buildInlineRequest(ok);
    expect(r).toEqual({ ok: true, request: { prompt: 'add a docstring', path: 'src/a.py', selectedText: ok.selectedText, range: { startLine: 10, endLine: 15 } } });
  });
  it('does not count the line a selection ends at column 0', () => {
    const r = buildInlineRequest({ ...ok, endLine0: 15, endChar: 0 });
    expect(r.ok && r.request.range.endLine).toBe(15);
  });
  it('friendly messages', () => {
    const msg = (o: Partial<InlineInput>): string => { const r = buildInlineRequest({ ...ok, ...o }); return r.ok ? '' : r.message; };
    expect(msg({ hasEditor: false })).toMatch(/open a file/);
    expect(msg({ scheme: 'untitled' })).toMatch(/save this file/);
    expect(msg({ scheme: 'output' })).toMatch(/cannot be edited/);
    expect(msg({ workspaceRoot: undefined })).toMatch(/open your project folder/);
    expect(msg({ fsPath: '/other/x.py' })).toMatch(/outside your project/);
    expect(msg({ selectedText: '   \n' })).toMatch(/select the code/);
    expect(msg({ startLine0: 0, endLine0: 0, startChar: 3, endChar: 3, selectedText: '' })).toMatch(/select the code/);
    expect(msg({ instruction: '  ' })).toMatch(/type what you want/);
    expect(msg({ endLine0: 600 })).toMatch(/lot of code/);
  });
  it('handles Windows paths, case-insensitively, and sibling-folder tricks', () => {
    expect(relativeToRoot('C:\\Users\\a\\Proj\\src\\x.ts', 'c:\\users\\a\\proj')).toBe('src/x.ts');
    expect(relativeToRoot('/w/proj-evil/a.py', '/w/proj')).toBeUndefined();
    expect(relativeToRoot('/w/proj', '/w/proj')).toBeUndefined();
  });
});
