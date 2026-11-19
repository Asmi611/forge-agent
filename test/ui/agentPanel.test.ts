import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EngineEvent, FileProposal } from '../../src/types/contract';
import { buildPanelHtml, makeNonce } from '../../src/ui/AgentPanel/panelHtml';
import { parsePanelRequest, suggestMentions } from '../../src/ui/AgentPanel/panelMessages';
import { MAX_ROWS, PanelModel, describeTool, proposalViews } from '../../src/ui/AgentPanel/panelModel';

const proposal = (): FileProposal => ({
  id: 'p1', callId: 'c', callIds: ['c'], path: 'src/a.ts', isNewFile: false, base: { contentHash: 'h', version: 1, wasDirty: false },
  originalContent: 'a', proposedContent: 'b', rationale: 'because', createdAt: 0,
  hunks: [
    { id: 'h1', oldStart: 1, oldLines: 0, newStart: 1, newLines: 3, oldText: '', newText: 'x', status: 'accepted' },
    { id: 'h2', oldStart: 5, oldLines: 2, newStart: 8, newLines: 1, oldText: 'a', newText: 'b', status: 'pending' },
  ],
});
const feed = (m: PanelModel, evs: EngineEvent[]): void => evs.forEach((e) => m.apply(e));
const start: EngineEvent = { type: 'run.started', runId: 'r', mode: 'agent', model: 'm1' };

describe('PanelModel', () => {
  it('streams tokens into ONE message and starts a new one after a tool call', () => {
    const m = new PanelModel();
    feed(m, [start, { type: 'token', text: 'Hel' }, { type: 'token', text: 'lo' }, { type: 'tool.call', callId: 'c1', tool: 'readFile', args: { path: 'a.ts' }, thread: 'main' }, { type: 'token', text: 'Next' }]);
    const v = m.view([], false);
    expect(v.messages.map((x) => x.text)).toEqual(['Hello', 'Next']);
    expect(v.running).toBe(true);
    expect(v.statusText).toBe('Working…');
  });
  it('tool rows: spinner, then tick or cross, in plain words', () => {
    const m = new PanelModel();
    feed(m, [start, { type: 'tool.call', callId: 'c1', tool: 'searchWorkspace', args: { query: 'config' }, thread: 'main' }, { type: 'tool.call', callId: 'c2', tool: 'readFile', args: { path: 'x.py' }, thread: 'sub1' }]);
    expect(m.view([], false).rows.map((r) => r.state)).toEqual(['running', 'running']);
    feed(m, [{ type: 'tool.result', callId: 'c1', ok: true, summary: '3 hits' }, { type: 'tool.result', callId: 'c2', ok: false, summary: 'missing' }]);
    const rows = m.view([], false).rows;
    expect(rows[0]).toMatchObject({ state: 'ok', label: 'Searching the project', detail: 'config', result: '3 hits', helper: false });
    expect(rows[1]).toMatchObject({ state: 'failed', helper: true });
  });
  it('ONE budget with a breakdown that adds up', () => {
    const m = new PanelModel();
    m.setMentions([{ path: 'm.py', label: 'm.py', tokens: 100 }]);
    feed(m, [start, { type: 'context.report', items: [{ path: 'a.py', reason: 'path: a', tokens: 200, source: 'auto' }, { path: 'b.py', reason: 'opened', tokens: 50, source: 'agent-tool' }] }, { type: 'budget', usedTokens: 900, limitTokens: 1000 }]);
    const v = m.view([], false);
    expect(v.files.map((f) => [f.path, f.badge])).toEqual([['m.py', 'You chose'], ['a.py', 'Found by Forge'], ['b.py', 'Opened by the agent']]);
    expect(v.budget).toMatchObject({ used: 900, limit: 1000, percent: 90, level: 'high' });
    expect(v.budget?.breakdown.reduce((a, b) => a + b.tokens, 0)).toBe(900);
  });
  it('budget level full and no budget before the first event', () => {
    const m = new PanelModel();
    expect(m.view([], false).budget).toBeUndefined();
    feed(m, [start, { type: 'budget', usedTokens: 2000, limitTokens: 1000 }]);
    expect(m.view([], false).budget).toMatchObject({ percent: 100, level: 'full' });
  });
  it('failover, retry, cancel and failure are plain sentences, never raw errors', () => {
    const m = new PanelModel();
    feed(m, [start, { type: 'retry', attempt: 1, delayMs: 5, kind: 'rate_limit' }, { type: 'failover', from: 'a', to: 'b', reason: 'rate_limit' }, { type: 'run.failed', error: { kind: 'auth', message: 'Traceback (most recent call last) sk-SECRET', retryable: false } }]);
    const v = m.view([], false);
    expect(v.model).toBe('b');
    expect(v.running).toBe(false);
    const all = JSON.stringify(v);
    expect(all).not.toMatch(/Traceback|sk-SECRET/);
    expect(v.messages.some((x) => x.tone === 'error')).toBe(true);
    expect(v.messages.some((x) => x.tone === 'warning' && /backup model/.test(x.text))).toBe(true);
    const c = new PanelModel();
    feed(c, [start, { type: 'tool.call', callId: 'z', tool: 'readFile', args: {}, thread: 'main' }, { type: 'run.cancelled' }]);
    expect(c.view([], false).rows[0]?.state).toBe('info'); // no spinner left spinning
    expect(c.view([], false).messages.at(-1)?.text).toMatch(/Nothing was changed/);
  });
  it('keeps at most 500 timeline rows and says so', () => {
    const m = new PanelModel();
    m.apply(start);
    for (let i = 0; i < MAX_ROWS + 50; i++) m.apply({ type: 'tool.call', callId: `c${i}`, tool: 'readFile', args: { path: `f${i}` }, thread: 'main' });
    const v = m.view([], false);
    expect(v.rows.length).toBe(MAX_ROWS);
    expect(v.hiddenRows).toBe(50);
    m.apply({ type: 'tool.result', callId: 'c0', ok: true, summary: 'late' }); // result for a dropped row must not crash
  });
  it('a new run clears the timeline, files and budget but keeps the conversation', () => {
    const m = new PanelModel();
    m.addUser('hi');
    feed(m, [start, { type: 'budget', usedTokens: 1, limitTokens: 2 }, { type: 'run.completed', summary: 'ok' }, start]);
    const v = m.view([], false);
    expect(v.budget).toBeUndefined();
    expect(v.messages[0]?.role).toBe('user');
  });
  it('proposal list shows per-change status and plain wording', () => {
    const [p] = proposalViews([proposal()]);
    expect(p).toMatchObject({ accepted: 1, pending: 1, rejected: 0 });
    expect(p?.hunks.map((h) => h.label)).toEqual(['Change 1 of 2: adds 3 lines', 'Change 2 of 2: replaces 2 lines with 1']);
    expect(new PanelModel().view([proposal()], true)).toMatchObject({ canUndo: true, statusText: 'Waiting for your review' });
  });
  it('describeTool never throws on odd input', () => {
    expect(describeTool('readFile', null).detail).toBe('');
    expect(describeTool('weird', { path: 'x'.repeat(500) }).detail.length).toBeLessThanOrEqual(70);
    expect(describeTool('runCommand', { file: 'pytest', args: ['-q'] }).detail).toBe('pytest -q');
  });
});

describe('waiting for review', () => {
  it('no spinner and a clear status once the person has to act', () => {
    const m = new PanelModel();
    feed(m, [start, { type: 'tool.call', callId: 'c2', tool: 'proposeEdit', args: { path: 'a' }, thread: 'main' }, { type: 'proposal.created', proposal: proposal() }, { type: 'review.required', batchId: 'b', proposalIds: ['p1'] }]);
    const v = m.view([proposal()], false);
    expect(v.rows.some((r) => r.state === 'running')).toBe(false);
    expect(v.statusText).toBe('Waiting for your review');
    expect(m.isReviewing).toBe(true);
  });
});

describe('panel requests (what the webview may ask for)', () => {
  it('accepts valid messages and rejects everything else', () => {
    expect(parsePanelRequest({ type: 'send', text: 'hi' })).toEqual({ type: 'send', text: 'hi' });
    expect(parsePanelRequest({ type: 'hunk', proposalId: 'p', hunkId: 'h1', status: 'accepted' })).toBeTruthy();
    expect(parsePanelRequest({ type: 'hunk', proposalId: 'p', hunkId: 'h1', status: 'DELETE' })).toBeUndefined();
    expect(parsePanelRequest({ type: 'all', status: 'rejected' })).toEqual({ type: 'all', status: 'rejected' });
    expect(parsePanelRequest({ type: 'send', text: 5 })).toBeUndefined();
    expect(parsePanelRequest({ type: 'rm -rf' })).toBeUndefined();
    expect(parsePanelRequest(null)).toBeUndefined();
    expect(parsePanelRequest('x')).toBeUndefined();
    expect(parsePanelRequest({ type: 'send', text: 'x'.repeat(5000) })).toBeUndefined();
  });
});

describe('@mention suggestions', () => {
  const files = [
    { path: 'src/app.py', symbols: [{ name: 'build_report', kind: 'function' }] },
    { path: 'src/report/builder.py', symbols: [] },
    { path: 'tests/test_app.py', symbols: [] },
    ...Array.from({ length: 20 }, (_, i) => ({ path: `lib/mod${i}.py`, symbols: [] })),
  ];
  it('file name beats folder name, max 8, symbols included', () => {
    expect(suggestMentions(files, 'app')[0]?.insert).toBe('@src/app.py');
    expect(suggestMentions(files, 'mod').length).toBe(8);
    expect(suggestMentions(files, 'build_r').some((s) => s.insert === '@build_report')).toBe(true);
    expect(suggestMentions(files, 'zzz')).toEqual([]);
    expect(suggestMentions(files, '').length).toBe(8);
  });
});

describe('panel HTML safety', () => {
  const html = buildPanelHtml({ cspSource: 'vscode-resource:', nonce: 'NONCE123', cssUri: 'a.css', jsUri: 'a.js' });
  it('has a strict CSP with a nonce and no inline script or eval', () => {
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-NONCE123'");
    expect(html).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect((html.match(/<script/g) ?? []).length).toBe(1);
  });
  it('nonces are long and differ', () => {
    expect(makeNonce()).toHaveLength(32);
    expect(makeNonce()).not.toBe(makeNonce());
  });
  it('panel.js never uses innerHTML, eval or document.write', () => {
    const js = readFileSync('media/panel.js', 'utf8');
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|document\.write/);
  });
});
