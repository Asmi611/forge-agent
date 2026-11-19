/**
 * Tests for hostCore.ts: running commands safely (real child processes), environment scrubbing,
 * working-folder lock, output trimming, line slicing, process-tree killing.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as os from 'os';
import {
  capOutputs, checkExecutable, collectDescendants, lockCwd, runCommandCore, scrubEnv, sliceLines, tailTrim,
} from '../../src/ui/hostCore';

const NODE = 'node';

/** Alive = exists and is not a "zombie" (a killed process nobody has cleaned up yet counts as dead). */
function isAlive(pid: number): boolean {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return state !== '' && !state.startsWith('Z');
  } catch {
    return false; // ps exits non-zero when the process is gone
  }
}
const root = os.tmpdir();
const req = (args: string[], extra: Partial<Parameters<typeof runCommandCore>[0]> = {}) =>
  ({ file: NODE, args, timeoutMs: 10_000, maxOutputChars: 6000, ...extra });
const run = (args: string[], extra = {}, signal: AbortSignal = new AbortController().signal, env?: NodeJS.ProcessEnv) =>
  runCommandCore(req(args, extra), signal, { root, env });

describe('scrubEnv', () => {
  it('keeps the few allowed variables and drops everything else', () => {
    const out = scrubEnv({ PATH: '/bin', HOME: '/h', FOO: 'x', MY_API_KEY: 'k', GITHUB_TOKEN: 't', CLIENT_SECRET: 's', TRUEFORGE_URL: 'u', SYSTEMROOT: 'C:\\Windows' });
    expect(Object.keys(out).sort()).toEqual(['HOME', 'PATH', 'SYSTEMROOT']);
  });
  it('is case-insensitive (Windows calls it "Path")', () => {
    expect(scrubEnv({ Path: 'C:\\x', path_key: 'no' })).toEqual({ Path: 'C:\\x' });
  });
  it('drops secret-looking names even if they were allowed names with a secret suffix', () => {
    expect(scrubEnv({ TEMP: '/t', TMP_TOKEN: 'x', TRUEFORGE_TMP: 'y' })).toEqual({ TEMP: '/t' });
  });
});

describe('tailTrim / capOutputs', () => {
  it('keeps the END of long text', () => {
    expect(tailTrim('abcdefghij', 4)).toEqual({ text: 'ghij', truncated: true });
    expect(tailTrim('abc', 4)).toEqual({ text: 'abc', truncated: false });
    expect(tailTrim('abc', 0)).toEqual({ text: '', truncated: true });
  });
  it('limits stdout and stderr TOGETHER, stderr first', () => {
    const r = capOutputs('o'.repeat(100), 'e'.repeat(30), 50);
    expect(r.stderr.length).toBe(30);
    expect(r.stdout.length).toBe(20);
    expect(r.truncated).toBe(true);
    expect(capOutputs('a', 'b', 50).truncated).toBe(false);
  });
});

describe('sliceLines', () => {
  const text = 'a\nb\r\nc\nd\n';
  it('returns the whole text without a range', () => expect(sliceLines(text)).toBe(text));
  it('is 1-based and inclusive', () => expect(sliceLines(text, { startLine: 2, endLine: 3 })).toBe('b\nc'));
  it('clamps to the file', () => {
    expect(sliceLines(text, { startLine: 0, endLine: 99 })).toBe('a\nb\nc\nd');
    expect(sliceLines(text, { startLine: 5, endLine: 9 })).toBe('');
    expect(sliceLines(text, { startLine: 3, endLine: 2 })).toBe('');
  });
});

describe('lockCwd / checkExecutable', () => {
  it('allows the root (also when no cwd or "." is given)', () => {
    expect(lockCwd(root)).toEqual({ ok: true, cwd: root });
    expect(lockCwd(root, '.')).toEqual({ ok: true, cwd: root });
    expect(lockCwd(root, root)).toEqual({ ok: true, cwd: root });
  });
  it('refuses any other folder', () => {
    for (const bad of ['src', '..', '../x', '/', '/etc', 'C:\\Windows', `${root}/sub`]) expect(lockCwd(root, bad).ok).toBe(false);
  });
  it('accepts bare program names only', () => {
    expect(checkExecutable('pytest')).toBeUndefined();
    expect(checkExecutable('python3.12')).toBeUndefined();
    for (const bad of ['', './x', '/bin/sh', 'C:\\x\\a.exe', 'a b', 'a;b', 'a&b', 'a|b', '$(x)', '`x`', '"a"']) expect(checkExecutable(bad), bad).toBeDefined();
  });
});

describe('collectDescendants', () => {
  it('finds children and grandchildren, deepest first', () => {
    const ps = ' 1 0\n 10 1\n 11 10\n 12 11\n 20 1\n 13 10\n';
    expect(collectDescendants(ps, 10)).toEqual([12, 13, 11]);
    expect(collectDescendants(ps, 99)).toEqual([]);
  });
});

describe('runCommandCore (real child processes)', () => {
  it('runs a program and returns its output and exit code 0', async () => {
    const r = await run(['-e', 'console.log("hello")']);
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, killed: false, truncated: false });
    expect(r.stdout.trim()).toBe('hello');
  });
  it('reports a failing exit code and stderr', async () => {
    const r = await run(['-e', 'console.error("bad"); process.exit(3)']);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('bad');
  });
  it('says so (in plain words) when the program does not exist', async () => {
    const r = await runCommandCore({ file: 'forge-no-such-program', args: [], timeoutMs: 5000, maxOutputChars: 1000 }, new AbortController().signal, { root });
    expect(r.exitCode).toBeNull();
    expect(r.stderr).toContain('Command not found');
  });
  it('does not run a shell string: shell characters stay plain text', async () => {
    const r = await run(['-e', 'console.log(process.argv[1])', 'a; echo INJECTED']);
    expect(r.stdout.trim()).toBe('a; echo INJECTED');
  });
  it('never passes keys, tokens, secrets or TRUEFORGE_* to the child', async () => {
    const env = { ...process.env, MY_API_KEY: 'k1', SOME_TOKEN: 't1', X_SECRET: 's1', TRUEFORGE_URL: 'u1' };
    const r = await run(['-e', 'console.log(JSON.stringify(Object.keys(process.env).filter(k=>/KEY|TOKEN|SECRET|TRUEFORGE/i.test(k))))'], {}, new AbortController().signal, env);
    expect(r.stdout.trim()).toBe('[]');
  });
  it('refuses another working folder and does not run', async () => {
    const r = await run(['-e', 'console.log(1)'], { cwd: '/' });
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('only runs commands in the folder');
  });
  it('refuses a program given as a path', async () => {
    const r = await run([], { file: process.execPath });
    expect(r.exitCode).toBeNull();
    expect(r.stderr).toContain('by name');
  });
  it('keeps the END of very long output and says it was cut', async () => {
    const r = await run(['-e', 'console.log("x".repeat(5000)+"END")'], { maxOutputChars: 100 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(100);
    expect(r.stdout.trim().endsWith('END')).toBe(true);
  });
  it('stops a command that runs too long', async () => {
    const t0 = Date.now();
    const r = await run(['-e', 'setTimeout(()=>{}, 30000)'], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(8000);
  });
  it('stops a command when Stop is pressed', async () => {
    const ctl = new AbortController();
    const p = run(['-e', 'setTimeout(()=>{}, 30000)'], {}, ctl.signal);
    setTimeout(() => ctl.abort(), 300);
    const r = await p;
    expect(r.killed).toBe(true);
  });
  it('does not even start when Stop was already pressed', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const r = await run(['-e', 'console.log(1)'], {}, ctl.signal);
    expect(r).toMatchObject({ killed: true, stdout: '' });
  });
  it.skipIf(process.platform === 'win32')('kills the whole process TREE, not only the first process', async () => {
    const ctl = new AbortController();
    // The child starts a grandchild, prints its pid, then both wait.
    const code = `const {spawn}=require('child_process');const g=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'});console.log(g.pid);setTimeout(()=>{},30000)`;
    const p = run(['-e', code], {}, ctl.signal);
    // wait until the grandchild pid is printed: poll by running again is awkward, so read via a side channel
    await new Promise((r) => setTimeout(r, 700));
    ctl.abort();
    const r = await p;
    const gpid = Number(r.stdout.trim());
    expect(Number.isInteger(gpid) && gpid > 0).toBe(true);
    await new Promise((r2) => setTimeout(r2, 500));
    expect(isAlive(gpid)).toBe(false);
  });
});

