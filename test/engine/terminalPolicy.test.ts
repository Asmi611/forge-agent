/**
 * Hermetic unit tests for pure terminalPolicy evaluator (Milestone E-10a).
 *
 * Verifies security tiering (auto, confirm, deny), executable normalization,
 * git read-only constraints, pytest flag allowlists, path traversal protection,
 * and comprehensive deny rationales. Zero I/O, zero network, zero child processes.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluate,
  ALLOWED_COMMANDS_HELP,
} from '../../src/mcp/terminalPolicy.ts';

describe('terminalPolicy evaluator', () => {
  // ───────── 1. Pytest confirm tier ─────────

  it('assigns confirm to pytest tests/test_cli.py -q', () => {
    const res = evaluate({ file: 'pytest', args: ['tests/test_cli.py', '-q'] });
    expect(res.tier).toBe('confirm');
    expect(res.reason).toContain('confirmation');
    expect(res.normalizedDisplay).toBe('pytest tests/test_cli.py -q');
  });

  it('allows standard boolean pytest flags (-q -v -x -s --no-header)', () => {
    const res = evaluate({
      file: 'pytest',
      args: ['tests/test_cli.py', '-q', '-v', '-x', '-s', '--no-header'],
    });
    expect(res.tier).toBe('confirm');
  });

  it('allows --tb with valid values (short, line, no, native)', () => {
    for (const val of ['short', 'line', 'no', 'native']) {
      const resEq = evaluate({ file: 'pytest', args: [`--tb=${val}`, 'tests/test_cli.py'] });
      expect(resEq.tier).toBe('confirm');

      const resSpace = evaluate({ file: 'pytest', args: ['--tb', val, 'tests/test_cli.py'] });
      expect(resSpace.tier).toBe('confirm');
    }
  });

  it('denies --tb with invalid values', () => {
    const res = evaluate({ file: 'pytest', args: ['--tb=invalid_val'] });
    expect(res.tier).toBe('deny');
    expect(res.reason).toContain('Invalid --tb value');
    expect(res.reason).toContain(ALLOWED_COMMANDS_HELP);
  });

  it('denies --tb without a value', () => {
    const res = evaluate({ file: 'pytest', args: ['--tb'] });
    expect(res.tier).toBe('deny');
    expect(res.reason).toContain("Missing value for '--tb'");
  });

  it('allows -k with expressions', () => {
    const res1 = evaluate({ file: 'pytest', args: ['-k', 'test_auth'] });
    expect(res1.tier).toBe('confirm');

    const res2 = evaluate({ file: 'pytest', args: ['-k=test_auth or test_login'] });
    expect(res2.tier).toBe('confirm');
  });

  it('allows -m with marker expressions', () => {
    const res1 = evaluate({ file: 'pytest', args: ['-m', 'unit'] });
    expect(res1.tier).toBe('confirm');

    const res2 = evaluate({ file: 'pytest', args: ['-m=not slow'] });
    expect(res2.tier).toBe('confirm');
  });

  it('allows --maxfail with positive integer values', () => {
    const res1 = evaluate({ file: 'pytest', args: ['--maxfail=1'] });
    expect(res1.tier).toBe('confirm');

    const res2 = evaluate({ file: 'pytest', args: ['--maxfail', '5'] });
    expect(res2.tier).toBe('confirm');
  });

  it('denies --maxfail with non-integer or zero values', () => {
    const res1 = evaluate({ file: 'pytest', args: ['--maxfail=abc'] });
    expect(res1.tier).toBe('deny');

    const res2 = evaluate({ file: 'pytest', args: ['--maxfail', '0'] });
    expect(res2.tier).toBe('deny');
  });

  it('allows -p only with no:cacheprovider', () => {
    const res1 = evaluate({ file: 'pytest', args: ['-p', 'no:cacheprovider'] });
    expect(res1.tier).toBe('confirm');

    const res2 = evaluate({ file: 'pytest', args: ['-p=no:cacheprovider'] });
    expect(res2.tier).toBe('confirm');

    const res3 = evaluate({ file: 'pytest', args: ['-pno:cacheprovider'] });
    expect(res3.tier).toBe('confirm');
  });

  it('denies -p with any plugin other than no:cacheprovider', () => {
    const res1 = evaluate({ file: 'pytest', args: ['-p', 'evil'] });
    expect(res1.tier).toBe('deny');
    expect(res1.reason).toContain("Only '-p no:cacheprovider' is permitted.");

    const res2 = evaluate({ file: 'pytest', args: ['-p=other'] });
    expect(res2.tier).toBe('deny');

    const res3 = evaluate({ file: 'pytest', args: ['-pxdist'] });
    expect(res3.tier).toBe('deny');
  });

  it('allows path::node test identifiers', () => {
    const res1 = evaluate({ file: 'pytest', args: ['tests/test_cli.py::test_version'] });
    expect(res1.tier).toBe('confirm');

    const res2 = evaluate({ file: 'pytest', args: ['tests/test_cli.py::TestClass::test_method'] });
    expect(res2.tier).toBe('confirm');
  });

  it('normalizes Windows backslashes in positional test paths', () => {
    const res = evaluate({ file: 'pytest', args: ['tests\\unit\\test_cli.py'] });
    expect(res.tier).toBe('confirm');
  });

  it('allows arguments containing spaces, quotes, and unicode characters', () => {
    const res1 = evaluate({ file: 'pytest', args: ['-k', 'test with spaces and "quotes"'] });
    expect(res1.tier).toBe('confirm');

    const res2 = evaluate({ file: 'pytest', args: ['-k', 'test_ünicøde_名前'] });
    expect(res2.tier).toBe('confirm');
  });

  it('handles case-insensitive pytest executable (PYTEST, PyTest)', () => {
    const res1 = evaluate({ file: 'PYTEST', args: ['tests/test_cli.py', '-q'] });
    expect(res1.tier).toBe('confirm');

    const res2 = evaluate({ file: 'PyTest', args: ['tests/test_cli.py'] });
    expect(res2.tier).toBe('confirm');
  });

  it('handles Windows executable extension (.exe, .EXE)', () => {
    const res1 = evaluate({ file: 'pytest.exe', args: ['tests/test_cli.py', '-q'] });
    expect(res1.tier).toBe('confirm');

    const res2 = evaluate({ file: 'PYTEST.EXE', args: ['tests/test_cli.py'] });
    expect(res2.tier).toBe('confirm');
  });

  it('allows python -m pytest and python3 -m pytest', () => {
    const res1 = evaluate({ file: 'python', args: ['-m', 'pytest', 'tests/test_cli.py', '-q'] });
    expect(res1.tier).toBe('confirm');

    const res2 = evaluate({ file: 'python3', args: ['-m', 'pytest', 'tests/test_cli.py', '-v'] });
    expect(res2.tier).toBe('confirm');

    const res3 = evaluate({ file: 'python.exe', args: ['-m', 'pytest', 'tests/test_cli.py'] });
    expect(res3.tier).toBe('confirm');
  });

  // ───────── 2. Pytest security denials ─────────

  it('denies path traversal (..) in pytest positional paths', () => {
    const res1 = evaluate({ file: 'pytest', args: ['../x'] });
    expect(res1.tier).toBe('deny');
    expect(res1.reason).toContain("Path traversal '..'");

    const res2 = evaluate({ file: 'pytest', args: ['tests/../../x'] });
    expect(res2.tier).toBe('deny');

    const res3 = evaluate({ file: 'pytest', args: ['sub\\..\\outside.py'] });
    expect(res3.tier).toBe('deny');
  });

  it('denies root and absolute paths in pytest positional paths', () => {
    const res1 = evaluate({ file: 'pytest', args: ['/etc/passwd'] });
    expect(res1.tier).toBe('deny');
    expect(res1.reason).toContain('Absolute path');

    const res2 = evaluate({ file: 'pytest', args: ['/var/log/test.py'] });
    expect(res2.tier).toBe('deny');
  });

  it('denies Windows drive letter paths in pytest positional paths', () => {
    const res1 = evaluate({ file: 'pytest', args: ['C:\\x'] });
    expect(res1.tier).toBe('deny');
    expect(res1.reason).toContain('Absolute path with drive letter');

    const res2 = evaluate({ file: 'pytest', args: ['c:/test/unit.py'] });
    expect(res2.tier).toBe('deny');

    const res3 = evaluate({ file: 'pytest', args: ['D:file.py'] });
    expect(res3.tier).toBe('deny');
  });

  it('denies dangerous pytest flags (--rootdir, -c, -o, --basetemp, --import-mode)', () => {
    expect(evaluate({ file: 'pytest', args: ['--rootdir=/tmp'] }).tier).toBe('deny');
    expect(evaluate({ file: 'pytest', args: ['-c', 'setup.cfg'] }).tier).toBe('deny');
    expect(evaluate({ file: 'pytest', args: ['-o', 'cache_dir=/tmp'] }).tier).toBe('deny');
    expect(evaluate({ file: 'pytest', args: ['--basetemp=/tmp'] }).tier).toBe('deny');
    expect(evaluate({ file: 'pytest', args: ['--import-mode=importlib'] }).tier).toBe('deny');
    expect(evaluate({ file: 'pytest', args: ['--confcutdir=..'] }).tier).toBe('deny');
    expect(evaluate({ file: 'pytest', args: ['--pyargs', 'pkg'] }).tier).toBe('deny');
  });

  it('denies unknown pytest flags', () => {
    const res = evaluate({ file: 'pytest', args: ['--unknown-flag'] });
    expect(res.tier).toBe('deny');
    expect(res.reason).toContain("Pytest flag '--unknown-flag' is forbidden.");
  });

  it('denies shell injection metacharacters in pytest arguments', () => {
    expect(evaluate({ file: 'pytest', args: ['tests/test.py; rm -rf /'] }).tier).toBe('deny');
    expect(evaluate({ file: 'pytest', args: ['tests/test.py && echo evil'] }).tier).toBe('deny');
    expect(evaluate({ file: 'pytest', args: ['tests/test.py | cat'] }).tier).toBe('deny');
    expect(evaluate({ file: 'pytest', args: ['`touch /tmp/evil`'] }).tier).toBe('deny');
    expect(evaluate({ file: 'pytest', args: ['$(whoami)'] }).tier).toBe('deny');
    expect(evaluate({ file: 'pytest', args: ['tests/test.py\nrm -rf /'] }).tier).toBe('deny');
  });

  // ───────── 3. Executable name validation ─────────

  it('denies compound shell injection in executable name (pytest; rm)', () => {
    const res1 = evaluate({ file: 'pytest; rm', args: [] });
    expect(res1.tier).toBe('deny');
    expect(res1.reason).toContain('forbidden shell characters');

    const res2 = evaluate({ file: 'pytest&&echo', args: [] });
    expect(res2.tier).toBe('deny');
  });

  it('denies executables with path separators (slashes or backslashes)', () => {
    const res1 = evaluate({ file: '/usr/bin/pytest', args: [] });
    expect(res1.tier).toBe('deny');
    expect(res1.reason).toContain('must be a bare name');

    const res2 = evaluate({ file: 'C:\\bin\\pytest.exe', args: [] });
    expect(res2.tier).toBe('deny');

    const res3 = evaluate({ file: './pytest', args: [] });
    expect(res3.tier).toBe('deny');
  });

  it('denies empty or whitespace executable names', () => {
    expect(evaluate({ file: '', args: [] }).tier).toBe('deny');
    expect(evaluate({ file: '   ', args: [] }).tier).toBe('deny');
  });

  // ───────── 4. Git auto tier & restrictions ─────────

  it('allows git status without flags as auto tier', () => {
    const res = evaluate({ file: 'git', args: ['status'] });
    expect(res.tier).toBe('auto');
    expect(res.reason).toContain('Safe read-only git status');
  });

  it('allows git status with safe read-only flags (-s, --short, -b, --branch, --porcelain)', () => {
    expect(evaluate({ file: 'git', args: ['status', '-s'] }).tier).toBe('auto');
    expect(evaluate({ file: 'git', args: ['status', '--short'] }).tier).toBe('auto');
    expect(evaluate({ file: 'git', args: ['status', '-sb'] }).tier).toBe('auto');
    expect(evaluate({ file: 'git', args: ['status', '--porcelain'] }).tier).toBe('auto');
    expect(evaluate({ file: 'git', args: ['status', 'src/'] }).tier).toBe('auto');
  });

  it('denies git status with path traversal or absolute paths', () => {
    expect(evaluate({ file: 'git', args: ['status', '../outside'] }).tier).toBe('deny');
    expect(evaluate({ file: 'git', args: ['status', '/etc'] }).tier).toBe('deny');
    expect(evaluate({ file: 'git', args: ['status', 'C:\\outside'] }).tier).toBe('deny');
  });

  it('allows git diff without flags or with safe read-only flags as auto tier', () => {
    expect(evaluate({ file: 'git', args: ['diff'] }).tier).toBe('auto');
    expect(evaluate({ file: 'git', args: ['diff', '--stat'] }).tier).toBe('auto');
    expect(evaluate({ file: 'git', args: ['diff', '--name-only'] }).tier).toBe('auto');
    expect(evaluate({ file: 'git', args: ['diff', '--no-color'] }).tier).toBe('auto');
    expect(evaluate({ file: 'git', args: ['diff', '-p', 'src/engine/'] }).tier).toBe('auto');
  });

  it('denies git diff with output redirection (--output, -o)', () => {
    const res1 = evaluate({ file: 'git', args: ['diff', '--output=/tmp/x'] });
    expect(res1.tier).toBe('deny');
    expect(res1.reason).toContain('output redirection');

    const res2 = evaluate({ file: 'git', args: ['diff', '--output', '/tmp/x'] });
    expect(res2.tier).toBe('deny');

    const res3 = evaluate({ file: 'git', args: ['diff', '-o', 'out.patch'] });
    expect(res3.tier).toBe('deny');
  });

  it('denies global git flags (-c, -C, --exec-path)', () => {
    const res1 = evaluate({ file: 'git', args: ['-c', 'core.pager=cat', 'diff'] });
    expect(res1.tier).toBe('deny');
    expect(res1.reason).toContain('Global git flag');

    const res2 = evaluate({ file: 'git', args: ['-C', '/tmp', 'status'] });
    expect(res2.tier).toBe('deny');
  });

  it('denies mutative or network git subcommands (push, pull, commit, checkout, reset, clean, rm)', () => {
    expect(evaluate({ file: 'git', args: ['push'] }).tier).toBe('deny');
    expect(evaluate({ file: 'git', args: ['pull'] }).tier).toBe('deny');
    expect(evaluate({ file: 'git', args: ['commit', '-m', 'evil'] }).tier).toBe('deny');
    expect(evaluate({ file: 'git', args: ['checkout', 'main'] }).tier).toBe('deny');
    expect(evaluate({ file: 'git', args: ['reset', '--hard'] }).tier).toBe('deny');
    expect(evaluate({ file: 'git', args: ['clean', '-fd'] }).tier).toBe('deny');
    expect(evaluate({ file: 'git', args: ['rm', 'file.txt'] }).tier).toBe('deny');
    expect(evaluate({ file: 'git', args: ['branch', '-D', 'main'] }).tier).toBe('deny');
  });

  // ───────── 5. Arbitrary execution denials ─────────

  it('denies python -c and arbitrary python scripts', () => {
    expect(evaluate({ file: 'python', args: ['-c', 'import os; os.system("ls")'] }).tier).toBe('deny');
    expect(evaluate({ file: 'python3', args: ['-c', 'print(1)'] }).tier).toBe('deny');
    expect(evaluate({ file: 'python', args: ['script.py'] }).tier).toBe('deny');
  });

  it('denies python -m http.server and other python modules', () => {
    const res = evaluate({ file: 'python', args: ['-m', 'http.server'] });
    expect(res.tier).toBe('deny');
    expect(res.reason).toContain("Only 'python -m pytest' is permitted.");
  });

  it('denies command shells (sh, bash, cmd, powershell, zsh)', () => {
    expect(evaluate({ file: 'sh', args: ['-c', 'ls'] }).tier).toBe('deny');
    expect(evaluate({ file: 'bash', args: ['script.sh'] }).tier).toBe('deny');
    expect(evaluate({ file: 'cmd', args: ['/c', 'dir'] }).tier).toBe('deny');
    expect(evaluate({ file: 'powershell', args: ['-Command', 'Get-ChildItem'] }).tier).toBe('deny');
    expect(evaluate({ file: 'zsh', args: [] }).tier).toBe('deny');
  });

  it('denies network and file modification tools (curl, rm, sudo, pip, node)', () => {
    expect(evaluate({ file: 'curl', args: ['https://example.com'] }).tier).toBe('deny');
    expect(evaluate({ file: 'wget', args: ['https://example.com'] }).tier).toBe('deny');
    expect(evaluate({ file: 'rm', args: ['-rf', '/tmp'] }).tier).toBe('deny');
    expect(evaluate({ file: 'sudo', args: ['pytest'] }).tier).toBe('deny');
    expect(evaluate({ file: 'pip', args: ['install', 'evil'] }).tier).toBe('deny');
    expect(evaluate({ file: 'node', args: ['-e', 'process.exit(1)'] }).tier).toBe('deny');
  });

  // ───────── 6. NPM and NPX test runners ─────────

  it('allows npm test and npm t', () => {
    expect(evaluate({ file: 'npm', args: ['test'] }).tier).toBe('confirm');
    expect(evaluate({ file: 'npm', args: ['t'] }).tier).toBe('confirm');
    expect(evaluate({ file: 'npm', args: ['test', '--', '-u'] }).tier).toBe('confirm');
  });

  it('denies npm install, npm run, and other npm subcommands', () => {
    expect(evaluate({ file: 'npm', args: ['install'] }).tier).toBe('deny');
    expect(evaluate({ file: 'npm', args: ['run', 'build'] }).tier).toBe('deny');
    expect(evaluate({ file: 'npm', args: ['publish'] }).tier).toBe('deny');
  });

  it('allows npx vitest run and npx pytest', () => {
    expect(evaluate({ file: 'npx', args: ['vitest', 'run'] }).tier).toBe('confirm');
    expect(evaluate({ file: 'npx', args: ['vitest', 'run', 'test/app.test.ts'] }).tier).toBe('confirm');
    expect(evaluate({ file: 'npx', args: ['pytest', 'tests/test_cli.py', '-q'] }).tier).toBe('confirm');
  });

  it('denies arbitrary npx packages', () => {
    expect(evaluate({ file: 'npx', args: ['esbuild', 'src/index.ts'] }).tier).toBe('deny');
    expect(evaluate({ file: 'npx', args: ['ts-node', 'script.ts'] }).tier).toBe('deny');
    expect(evaluate({ file: 'npx', args: ['evil-pkg'] }).tier).toBe('deny');
  });

  // ───────── 7. Working directory validation ─────────

  it('allows workspace root cwd (undefined, empty, or .)', () => {
    expect(evaluate({ file: 'pytest', args: ['tests/test_cli.py'], cwd: undefined }).tier).toBe('confirm');
    expect(evaluate({ file: 'pytest', args: ['tests/test_cli.py'], cwd: '' }).tier).toBe('confirm');
    expect(evaluate({ file: 'pytest', args: ['tests/test_cli.py'], cwd: '.' }).tier).toBe('confirm');
  });

  it('denies custom or parent working directories', () => {
    expect(evaluate({ file: 'pytest', args: ['tests/test_cli.py'], cwd: '..' }).tier).toBe('deny');
    expect(evaluate({ file: 'pytest', args: ['tests/test_cli.py'], cwd: '/tmp' }).tier).toBe('deny');
    expect(evaluate({ file: 'pytest', args: ['tests/test_cli.py'], cwd: 'C:\\outside' }).tier).toBe('deny');
  });

  // ───────── 8. Deny rationale compliance ─────────

  it('verifies that every deny rationale explicitly includes the permitted commands help list', () => {
    const denials = [
      evaluate({ file: 'rm', args: ['-rf', '/'] }),
      evaluate({ file: 'curl', args: ['http://foo'] }),
      evaluate({ file: 'pytest', args: ['../outside.py'] }),
      evaluate({ file: 'pytest', args: ['--rootdir=/tmp'] }),
      evaluate({ file: 'git', args: ['push'] }),
      evaluate({ file: 'python', args: ['-c', 'print(1)'] }),
    ];

    for (const d of denials) {
      expect(d.tier).toBe('deny');
      expect(d.reason).toContain(ALLOWED_COMMANDS_HELP);
    }
  });
});
