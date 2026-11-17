/**
 * hostCore.ts -- the vscode-free building blocks of the UiHost: running a command safely,
 * scrubbing the environment, locking the working folder, slicing lines.
 *
 * Why separate from VS Code: every safety rule here can be unit tested in plain Node.
 *
 * Command rules (docs/03 T3, enforced here AND by the engine):
 *  - argv only: execFile with shell:false (no shell string is ever built)
 *  - the program must be a bare name (no folders), the working folder must be the workspace root
 *  - environment is an allowlist: keys / tokens / secrets / TRUEFORGE_* never reach the child
 *  - a timeout and an output cap; the whole process TREE is killed on timeout or Stop
 */
import { execFile } from 'child_process';
import * as path from 'path';
import type { CommandRequest, CommandResult, LineRange } from '../types/contract';

// ───────── environment ─────────
const ENV_ALLOWLIST = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'VIRTUAL_ENV', 'LANG', 'LC_ALL', 'TERM', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR',
]);
const SECRET_LIKE = /(_KEY|_TOKEN|_SECRET)$|^TRUEFORGE_/i;

/** Keep only the few variables a test runner needs. Names are compared case-insensitively (Windows says "Path"). */
export function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!ENV_ALLOWLIST.has(name.toUpperCase())) continue;
    if (SECRET_LIKE.test(name)) continue;
    out[name] = value;
  }
  return out;
}

// ───────── output ─────────
/** Keep the LAST `max` characters (the end of a test run is the interesting part). */
export function tailTrim(text: string, max: number): { text: string; truncated: boolean } {
  if (max <= 0) return { text: '', truncated: text.length > 0 };
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(text.length - max), truncated: true };
}

/** stdout and stderr together may not exceed `max` characters (tail kept; stderr is kept first). */
export function capOutputs(stdout: string, stderr: string, max: number): { stdout: string; stderr: string; truncated: boolean } {
  const err = tailTrim(stderr, max);
  const out = tailTrim(stdout, Math.max(0, max - err.text.length));
  return { stdout: out.text, stderr: err.text, truncated: err.truncated || out.truncated };
}

// ───────── paths and lines ─────────
/** Return lines startLine..endLine (1-based, inclusive), clamped to the file. No range = the whole text. */
export function sliceLines(text: string, range?: LineRange): string {
  if (!range) return text;
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // a final newline is not another line
  const start = Math.max(1, Math.floor(range.startLine));
  const end = Math.min(lines.length, Math.floor(range.endLine));
  if (!(start <= end)) return '';
  return lines.slice(start - 1, end).join('\n');
}

export type CwdCheck = { ok: true; cwd: string } | { ok: false; reason: string };

/** Commands may only run in the workspace root. Anything else (a sub-folder, another drive, "..") is refused. */
export function lockCwd(root: string, cwd?: string): CwdCheck {
  if (cwd === undefined || cwd === '' || cwd === '.') return { ok: true, cwd: root };
  const same = (a: string, b: string): boolean =>
    process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
  if (path.isAbsolute(cwd) && same(cwd, root)) return { ok: true, cwd: root };
  return { ok: false, reason: 'Forge only runs commands in the folder you opened, so this command was not run.' };
}

/** The program must be a bare name like "pytest" or "git" (no folders, no spaces, no shell characters). */
export function checkExecutable(file: string): string | undefined {
  if (file === '' || /[\\/]/.test(file) || /[\s"'`&|;<>^%$]/.test(file)) {
    return 'Forge only runs programs by name (for example "pytest"), so this command was not run.';
  }
  return undefined;
}

// ───────── running a command ─────────
/** From the output of `ps -A -o pid=,ppid=`: every process started (directly or not) by `rootPid`, deepest first. */
export function collectDescendants(psOutput: string, rootPid: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const found: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const next = queue.shift() as number;
    for (const c of children.get(next) ?? []) {
      if (!found.includes(c)) { found.push(c); queue.push(c); }
    }
  }
  return found.reverse();
}

/**
 * Kill a process AND everything it started.
 * Windows: `taskkill /T /F`. Mac/Linux: list the processes, kill the children first, then the process.
 * (execFile cannot make a process group, so we walk the process list instead.)
 */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    } catch { /* already gone */ }
    return;
  }
  const kill = (p: number): void => {
    try { process.kill(p, 'SIGKILL'); } catch { /* already gone */ }
  };
  try {
    execFile('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }, (error, stdout) => {
      if (!error) for (const d of collectDescendants(String(stdout), pid)) kill(d);
      kill(pid);
    });
  } catch {
    kill(pid);
  }
}

export interface CommandContext { root: string; env?: NodeJS.ProcessEnv }

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;

/** Run one command as the contract requires. Never throws: every problem becomes a CommandResult. */
export function runCommandCore(req: CommandRequest, signal: AbortSignal, ctx: CommandContext): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const refuse = (message: string, killed = false): void =>
      resolve({ exitCode: null, stdout: '', stderr: message, truncated: false, timedOut: false, killed });

    const badFile = checkExecutable(req.file);
    if (badFile) return refuse(badFile);
    const lock = lockCwd(ctx.root, req.cwd);
    if (!lock.ok) return refuse(lock.reason);
    if (signal.aborted) return refuse('Stopped before it started.', true);

    const timeoutMs = Number.isFinite(req.timeoutMs) && req.timeoutMs > 0 ? Math.min(req.timeoutMs, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
    const maxChars = Math.max(0, Math.floor(req.maxOutputChars));
    let timedOut = false;
    let killed = false;
    

    const onAbort = (): void => {
      killed = true;
      killTree(child.pid);
    };

    const child = execFile(
      req.file,
      req.args,
      {
        cwd: lock.cwd,
        env: scrubEnv(ctx.env ?? process.env),
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: Math.max(1_000_000, maxChars * 20),
      },
      (error, stdout, stderr) => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        let exitCode: number | null = 0;
        let extra = '';
        let overflow = false;
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          exitCode = typeof code === 'number' ? code : null;
          if (code === 'ENOENT') extra = `Command not found: ${req.file}. Is it installed and on your PATH?`;
          else if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') overflow = true;
        }
        const capped = capOutputs(String(stdout ?? ''), extra ? `${extra}\n${String(stderr ?? '')}`.trim() : String(stderr ?? ''), maxChars);
        resolve({ exitCode, stdout: capped.stdout, stderr: capped.stderr, truncated: capped.truncated || overflow, timedOut, killed });
      },
    );

    const timer = setTimeout(() => {
  timedOut = true;
  killTree(child.pid);
}, timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
