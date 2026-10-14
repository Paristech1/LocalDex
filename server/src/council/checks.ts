import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** How much of the checks' output is kept (the end, where failures usually are). */
export const CHECK_TAIL = 8_000;

const NPM_DEFAULT_TEST = /no test specified/i;

/**
 * The project's own checks, detected from the project folder: package.json scripts (typecheck, lint, test),
 * pytest, cargo, go. Returns '' when nothing is found.
 */
export function detectCheckCommand(cwd: string): string {
  const has = (f: string) => fs.existsSync(path.join(cwd, f));
  const parts: string[] = [];
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
      const scripts = pkg.scripts ?? {};
      const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
      for (const name of ['typecheck', 'lint', 'test']) {
        const body = scripts[name];
        if (typeof body !== 'string' || !body.trim()) continue;
        if (name === 'test' && NPM_DEFAULT_TEST.test(body)) continue;
        parts.push(`${pm} run ${name}`);
      }
    } catch {
      /* unreadable package.json: fall through to the other detectors */
    }
  }
  if (has('pyproject.toml') || has('pytest.ini')) parts.push('pytest -q');
  if (has('Cargo.toml')) parts.push('cargo test');
  if (has('go.mod')) parts.push('go test ./...');
  return parts.join(' && ');
}

/** Variables a build/test toolchain needs. Everything else (API keys, tokens, LocalDex's own settings) is left out. */
const KEEP_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TMP', 'TEMP',
  'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramData',
  'NVM_DIR', 'VOLTA_HOME', 'PNPM_HOME', 'BUN_INSTALL',
  'VIRTUAL_ENV', 'CONDA_PREFIX', 'PYENV_ROOT',
  'CARGO_HOME', 'RUSTUP_HOME', 'GOPATH', 'GOROOT', 'GOCACHE', 'GOMODCACHE', 'JAVA_HOME',
];

export function checksEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of KEEP_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' };
}

export interface CheckRun {
  command: string;
  cwd: string;
  /** Exit code; null when killed (timeout/cancel) or the shell failed to start. */
  code: number | null;
  ok: boolean;
  timedOut: boolean;
  cancelled: boolean;
  /** Last CHECK_TAIL characters of stdout+stderr. */
  tail: string;
  durationMs: number;
}

/** Run the checks in the project folder with a minimal environment. Never throws. */
export function runChecks(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<CheckRun> {
  const started = Date.now();
  const win = process.platform === 'win32';
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    let cancelled = false;
    const done = (code: number | null, extra = '') => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const text = (out + extra).trimEnd();
      resolve({
        command,
        cwd,
        code,
        ok: code === 0 && !timedOut && !cancelled,
        timedOut,
        cancelled,
        tail: text.length > CHECK_TAIL ? `…${text.slice(-CHECK_TAIL)}` : text,
        durationMs: Date.now() - started,
      });
    };
    // Own process group (POSIX) so a timeout also stops the test runner's children.
    const child = win
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], { cwd, env: checksEnv(), windowsHide: true })
      : spawn(process.env.SHELL || '/bin/sh', ['-c', command], { cwd, env: checksEnv(), detached: true });
    const kill = () => {
      try {
        if (!win && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const push = (d: Buffer) => {
      out += d.toString();
      if (out.length > CHECK_TAIL * 4) out = out.slice(-CHECK_TAIL * 2);
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => done(null, `\n[could not start the shell: ${e.message}]`));
    child.on('close', (code) => done(timedOut || cancelled ? null : code, timedOut ? `\n[killed after ${Math.round(timeoutMs / 1000)}s timeout]` : cancelled ? '\n[cancelled]' : ''));
  });
}
