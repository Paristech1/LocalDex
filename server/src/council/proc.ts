import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Environment variables that would make a vendor CLI bill an API account (or talk to a different backend)
 * instead of the user's subscription login. They are removed before any member starts.
 */
export const BILLING_ENV_VARS = [
  // Anthropic
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  // OpenAI
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_BASE_URL',
  // Google
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_APPLICATION_CREDENTIALS',
];

/**
 * A copy of LocalDex's environment minus API-key/billing variables, and minus markers that make
 * a CLI think it is nested inside another agent session.
 * LOCALDEX_COUNCIL_KEEP_ENV (comma list) re-allows specific names, for unusual setups (e.g. a corporate proxy base URL).
 */
export function memberEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = new Set((process.env.LOCALDEX_COUNCIL_KEEP_ENV ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of BILLING_ENV_VARS) if (!keep.has(k)) delete env[k];
  for (const k of Object.keys(env)) {
    if ((k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_SESSION') || k === 'CLAUDE_CODE_ENTRYPOINT') && !keep.has(k)) delete env[k];
  }
  // Never let a CLI stop to ask questions on a TTY it does not have.
  env.CI = env.CI ?? '1';
  env.NO_COLOR = '1';
  env.TERM = env.TERM ?? 'dumb';
  return { ...env, ...extra };
}

/** Folders where people usually end up with these CLIs (npm global, Homebrew, installers). */
function extraBinDirs(): string[] {
  const home = os.homedir();
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local/bin'),
    path.join(home, '.npm-global/bin'),
    path.join(home, '.claude/local'),
    path.join(home, '.bun/bin'),
    path.join(home, '.volta/bin'),
    path.join(home, 'bin'),
    ...npmGlobalBin(),
  ];
}

let npmBinCache: string[] | undefined;

/** Where `npm i -g` puts executables (e.g. ~/.nvm/versions/node/v22/bin), which may not be on LocalDex's PATH. */
function npmGlobalBin(): string[] {
  if (npmBinCache) return npmBinCache;
  npmBinCache = [path.dirname(process.execPath)];
  try {
    const npm = npmCommand();
    const r = spawnSync(npm, ['prefix', '-g'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' });
    const prefix = (r.stdout ?? '').trim();
    if (r.status === 0 && prefix) npmBinCache.push(process.platform === 'win32' ? prefix : path.join(prefix, 'bin'));
  } catch {
    /* npm not available */
  }
  return npmBinCache;
}

/** Forget the cached npm folder (after an install changed things). */
export function resetNpmBinCache(): void {
  npmBinCache = undefined;
}

/** The npm that belongs to the node running LocalDex, else whatever `npm` is on PATH. */
export function npmCommand(): string {
  const name = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const beside = path.join(path.dirname(process.execPath), name);
  return isExecutable(beside) ? beside : name;
}

/** Resolve an executable: an explicit path (from config.json), else PATH, else common install folders. */
export function resolveBinary(name: string, override?: string): string | null {
  if (override) {
    const p = override.startsWith('~/') ? path.join(os.homedir(), override.slice(2)) : override;
    return isExecutable(p) ? p : null;
  }
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...extraBinDirs()];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, name);
    if (isExecutable(p)) return p;
  }
  return null;
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Run a short command (status/version checks) and capture output. Never throws. */
export function runQuick(bin: string, args: string[], timeoutMs = 15_000): { code: number | null; stdout: string; stderr: string } {
  try {
    const r = spawnSync(bin, args, { env: memberEnv(), timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? String(r.error.message) : '') };
  } catch (e) {
    return { code: null, stdout: '', stderr: (e as Error).message };
  }
}

/**
 * Async version of runQuick for commands that may be slow (model listing touches the network),
 * so the server keeps serving while it waits. Output is capped; never throws.
 */
export function runCapture(bin: string, args: string[], timeoutMs: number, maxBytes = 8_000_000): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { env: memberEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: null, stdout: '', stderr: (e as Error).message, timedOut: false });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (c: string) => {
      if (stdout.length < maxBytes) stdout += c;
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (c: string) => {
      stderr = (stderr + c).slice(-4000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${e.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export interface JsonlRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  timedOut: boolean;
  aborted: boolean;
  /** Non-JSON stdout lines (some CLIs print warnings to stdout). */
  plainTail: string;
}

/**
 * Spawn a CLI that prints JSON Lines on stdout and feed each parsed object to onJson.
 * Kills the process (TERM, then KILL) on abort or timeout.
 */
export function runJsonl(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number; stdin?: string },
  onJson: (obj: Record<string, unknown>) => void,
): Promise<JsonlRunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let buf = '';
    let stderr = '';
    let plain = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 3000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });

    const handleLine = (line: string) => {
      const t = line.trim();
      if (!t) return;
      if (t.startsWith('{')) {
        try {
          onJson(JSON.parse(t) as Record<string, unknown>);
          return;
        } catch {
          /* fall through: not JSON */
        }
      }
      plain = (plain + t + '\n').slice(-4000);
    };

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-6000);
    });
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        /* CLI may exit before reading stdin */
      });
      child.stdin.end(opts.stdin);
    }

    const finish = (code: number | null, sig: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (buf) handleLine(buf);
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      resolve({ code, signal: sig, stderrTail: stderr.trim(), timedOut, aborted, plainTail: plain.trim() });
    };
    child.on('error', (e) => {
      stderr += `\n${e.message}`;
      finish(null, null);
    });
    child.on('close', finish);
  });
}

/**
 * Environment for a vendor's own sign-in command. Like memberEnv (API-key variables removed, so the login is the
 * subscription one), but without CI=1: several CLIs refuse to open a browser when they think they run in CI.
 */
export function loginEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = memberEnv(extra);
  delete env.CI;
  return env;
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const URL_RE = /https:\/\/[^\s"'<>`]+/;

/** The last few meaningful lines of a sign-in's output, for an error message. */
export function lastLines(output: string, n = 3): string {
  return output
    .replace(ANSI_RE, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^at\s/.test(l) && !/^[{}()[\],]+$|^exitCode:|^\w*Error: /.test(l))
    .slice(-n)
    .join(' ')
    .slice(0, 400);
}

export interface LoginRunOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  signal: AbortSignal;
  hooks: import('./types.js').LoginHooks;
  /** Written to stdin right away (e.g. a "y" to a consent question). */
  input?: string;
  /** Keep stdin open so a pasted code can be sent later. */
  keepInputOpen?: boolean;
  /** Output that means the vendor waits for a pasted code. */
  codePrompt?: RegExp;
  /** Which https link is the sign-in page (default: the first one printed). */
  urlFilter?: RegExp;
}

/**
 * Run a vendor's sign-in command without a terminal. The vendor opens the browser itself; the first sign-in link it
 * prints is passed to the UI as a fallback. Resolves when the command exits (or is aborted). Never throws.
 */
export function runLogin(bin: string, args: string[], o: LoginRunOptions): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    let sentUrl = false;
    let askedCode = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { env: o.env, cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: null, output: (e as Error).message });
    }
    const onAbort = () => child.kill('SIGTERM');
    o.signal.addEventListener('abort', onAbort, { once: true });
    child.stdin!.on('error', () => undefined);
    if (o.input) child.stdin!.write(o.input);
    if (o.keepInputOpen) {
      o.hooks.setInput((text) => {
        if (child.stdin!.writable) child.stdin!.write(`${text.trim()}\n`);
      });
    } else {
      child.stdin!.end();
    }
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8').replace(ANSI_RE, '');
      output = (output + text).slice(-20_000);
      if (!sentUrl) {
        for (const m of output.matchAll(new RegExp(URL_RE, 'g'))) {
          const url = m[0].replace(/[).,;]+$/, '');
          if (!o.urlFilter || o.urlFilter.test(url)) {
            sentUrl = true;
            o.hooks.onUrl(url);
            break;
          }
        }
      }
      if (!askedCode && o.codePrompt?.test(output)) {
        askedCode = true;
        o.hooks.onNeedsCode();
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    const done = (code: number | null) => {
      o.signal.removeEventListener('abort', onAbort);
      o.hooks.setInput(null);
      resolve({ code, output });
    };
    child.on('error', (e) => {
      output += `\n${e.message}`;
      done(null);
    });
    child.on('close', (code) => done(code));
  });
}
