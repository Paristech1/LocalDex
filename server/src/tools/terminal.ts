import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { defaultCwd, resolvePath, shellNeedsApproval } from './permissions.js';
import { fail, ok, optNum, optStr, str, truncate, type ToolDef } from './types.js';
import { DECLINED_COMMAND } from './types.js';
import { SandboxUnavailableError, wrapCommand } from '../sandbox.js';

const require = createRequire(import.meta.url);

/** The slice of node-pty we use. Declared here so the server typechecks when the optional package is absent (H3). */
interface IPty {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pid: number;
}
interface PtyModule {
  spawn(file: string, args: string[], opts: { name?: string; cols?: number; rows?: number; cwd?: string; env?: Record<string, string> }): IPty;
}
const SHELL = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');
const MAX_BUFFER = 200_000;

interface Terminal {
  id: string;
  pty: IPty;
  buffer: string;
  /** Offset into buffer already returned by terminal_read. */
  readOffset: number;
  cwd: string;
  alive: boolean;
  exitCode: number | null;
}

const terminals = new Map<string, Terminal>();
let counter = 0;

function loadPty(): PtyModule {
  // node-pty's prebuilt spawn-helper sometimes ships without the executable bit.
  try {
    const pkg = require.resolve('node-pty/package.json');
    const helper = path.join(path.dirname(pkg), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  } catch {
    /* ignore */
  }
  return require('node-pty') as PtyModule;
}

/** What the user should do when the terminal tools are unavailable (shown in Settings → Capabilities). */
export const PTY_UNAVAILABLE_NOTE = 'Persistent terminals need node-pty: install build tools, then run `npm rebuild node-pty`. shell_run keeps working.';

let ptyCheck: { ok: boolean; error?: string } | null = null;

/**
 * node-pty is an optional dependency (it has no Linux prebuilt binary, so `npm ci` must not fail without it).
 * Probed once, lazily; when it is missing the terminal_* tools are hidden from the model and Settings says why.
 */
export function ptyAvailable(): { ok: boolean; error?: string } {
  if (ptyCheck) return ptyCheck;
  try {
    loadPty();
    ptyCheck = { ok: true };
  } catch (e) {
    ptyCheck = { ok: false, error: (e as Error).message.split('\n')[0].slice(0, 200) };
  }
  return ptyCheck;
}

export const TERMINAL_TOOLS = new Set<string>(['terminal_open', 'terminal_send', 'terminal_read', 'terminal_close']);

const ANSI = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
function clean(s: string): string {
  return s.replace(ANSI, '').replace(/\r/g, '');
}

export const terminal_open: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'terminal_open',
      description:
        'Open a persistent interactive terminal (pty) and optionally run an initial command. Returns a terminal id for terminal_send / terminal_read. Use for dev servers, watchers, REPLs.',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          command: { type: 'string', description: 'Optional command to run immediately.' },
        },
      },
    },
  },
  async run(args, ctx) {
    const cwd = resolvePath(optStr(args.cwd) ?? defaultCwd());
    const command = optStr(args.command);
    if (command && shellNeedsApproval(command)) {
      const approved = await ctx.requestApproval(command, cwd);
      if (!approved) return fail(DECLINED_COMMAND);
    }
    let pty: PtyModule;
    try {
      pty = loadPty();
    } catch (e) {
      return fail(`node-pty unavailable: ${(e as Error).message}. ${PTY_UNAVAILABLE_NOTE}`);
    }
    const id = `term${++counter}`;
    let w: { file: string; args: string[] };
    try {
      w = wrapCommand(SHELL, ['-l']);
    } catch (e) {
      if (e instanceof SandboxUnavailableError) return fail(e.message);
      throw e;
    }
    const proc = pty.spawn(w.file, w.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    });
    const term: Terminal = { id, pty: proc, buffer: '', readOffset: 0, cwd, alive: true, exitCode: null };
    proc.onData((d) => {
      term.buffer += clean(d);
      if (term.buffer.length > MAX_BUFFER) {
        const drop = term.buffer.length - MAX_BUFFER;
        term.buffer = term.buffer.slice(drop);
        term.readOffset = Math.max(0, term.readOffset - drop);
      }
    });
    proc.onExit(({ exitCode }) => {
      term.alive = false;
      term.exitCode = exitCode;
    });
    terminals.set(id, term);
    if (command) proc.write(command + '\r');
    await sleep(command ? 1500 : 500);
    return ok(`Opened ${id} in ${cwd}.\n${readNew(term)}`);
  },
};

export const terminal_send: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'terminal_send',
      description:
        'Send input to an open terminal. A newline is appended unless raw=true. Waits wait_ms (default 1500) then returns new output.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          input: { type: 'string' },
          raw: { type: 'boolean', description: 'Send exactly as given (e.g. "\\u0003" for Ctrl-C).' },
          wait_ms: { type: 'integer' },
        },
        required: ['id', 'input'],
      },
    },
  },
  async run(args, ctx) {
    const term = terminals.get(str(args.id, 'id'));
    if (!term) return fail(`No terminal with id ${args.id}. Open one with terminal_open.`);
    if (!term.alive) return fail(`Terminal ${term.id} has exited (code ${term.exitCode}).`);
    const input = str(args.input, 'input');
    const raw = args.raw === true;
    if (!raw && shellNeedsApproval(input)) {
      const approved = await ctx.requestApproval(input, term.cwd);
      if (!approved) return fail(DECLINED_COMMAND);
    }
    term.pty.write(raw ? input : input + '\r');
    await sleep(optNum(args.wait_ms) ?? 1500);
    return ok(readNew(term));
  },
};

export const terminal_read: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'terminal_read',
      description: 'Read new output from a terminal since the last read. Set all=true to get the whole scrollback.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          all: { type: 'boolean' },
          wait_ms: { type: 'integer', description: 'Wait before reading (default 0).' },
        },
        required: ['id'],
      },
    },
  },
  async run(args) {
    const term = terminals.get(str(args.id, 'id'));
    if (!term) return fail(`No terminal with id ${args.id}.`);
    const wait = optNum(args.wait_ms) ?? 0;
    if (wait) await sleep(wait);
    if (args.all === true) {
      term.readOffset = term.buffer.length;
      return ok(statusLine(term) + truncate(term.buffer));
    }
    return ok(readNew(term));
  },
};

export const terminal_close: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'terminal_close',
      description: 'Kill and close a terminal.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
  async run(args) {
    const term = terminals.get(str(args.id, 'id'));
    if (!term) return fail(`No terminal with id ${args.id}.`);
    try {
      term.pty.kill();
    } catch {
      /* ignore */
    }
    terminals.delete(term.id);
    return ok(`Closed ${term.id}.`);
  },
};

function readNew(term: Terminal): string {
  const chunk = term.buffer.slice(term.readOffset);
  term.readOffset = term.buffer.length;
  return statusLine(term) + (truncate(chunk) || '(no new output)');
}

function statusLine(term: Terminal): string {
  return `[${term.id} ${term.alive ? 'running' : `exited ${term.exitCode}`}]\n`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function closeAllTerminals(): void {
  for (const t of terminals.values()) {
    try {
      t.pty.kill();
    } catch {
      /* ignore */
    }
  }
  terminals.clear();
}
