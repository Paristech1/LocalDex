import { spawn } from 'node:child_process';
import { defaultCwd, resolvePath, shellNeedsApproval } from './permissions.js';
import { fail, ok, optNum, optStr, str, truncate, type ToolDef } from './types.js';
import { DECLINED_COMMAND } from './types.js';
import { PLAN_SHELL_REFUSAL, isReadOnlyCommand } from '../agent/planMode.js';
import { startJob } from '../jobs.js';
import { SandboxUnavailableError, currentMode, escalationPrompt, looksSandboxDenied, wrapCommand } from '../sandbox.js';

const SHELL = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');

export const shell_run: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'shell_run',
      description:
        'Run a one-shot shell command and return its output (stdout+stderr) and exit code. Use for builds, tests, git, etc. For dev servers, watchers or anything long, pass background: true to get a job id back at once; then job_output / job_kill manage it.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: 'Working directory (default: approved folder).' },
          timeout_seconds: { type: 'integer', description: 'Kill after this many seconds (default 120).' },
          background: { type: 'boolean', description: 'Start as a background job and return its id immediately.' },
        },
        required: ['command'],
      },
    },
  },
  async run(args, ctx) {
    const command = str(args.command, 'command');
    const cwd = resolvePath(optStr(args.cwd) ?? defaultCwd());
    const timeout = (optNum(args.timeout_seconds) ?? 120) * 1000;

    if (ctx.planMode && !isReadOnlyCommand(command)) return fail(PLAN_SHELL_REFUSAL);
    if (shellNeedsApproval(command)) {
      const approved = await ctx.requestApproval(command, cwd, 'shell');
      if (!approved) return fail(DECLINED_COMMAND);
    }
    if (args.background === true || args.background === 'true') {
      if (ctx.planMode) return fail(PLAN_SHELL_REFUSAL);
      let job;
      try {
        job = startJob(ctx.sessionId, ctx.agent, command, cwd);
      } catch (e) {
        if (e instanceof SandboxUnavailableError) return fail(e.message);
        throw e;
      }
      return ok(`Started background job ${job.id} (pid ${job.pid ?? '?'}): ${command}\nIt keeps running while you continue. You will get a notice when it finishes; job_output reads what it printed (wait_seconds waits), job_kill stops it.`);
    }

    let wrapped: { file: string; args: string[]; sandboxed: boolean };
    try {
      wrapped = wrapCommand(SHELL, ['-lc', command]);
    } catch (e) {
      if (e instanceof SandboxUnavailableError) return fail(e.message);
      throw e;
    }
    let r = await execOnce(wrapped.file, wrapped.args, cwd, timeout, ctx.signal);
    let note = '';
    if (wrapped.sandboxed && looksSandboxDenied(r.out, r.code) && currentMode() === 'read-only') {
      note = ' (blocked: the user picked the "Read only" permission preset, so nothing may change files — do not retry it; say what you would change instead)';
    } else if (wrapped.sandboxed && looksSandboxDenied(r.out, r.code) && !ctx.planMode && !ctx.signal.aborted) {
      // One-shot escalation through the normal approval flow; the preset itself does not change.
      const yes = await ctx.requestApproval(escalationPrompt(command), cwd);
      if (yes) {
        r = await execOnce(SHELL, ['-lc', command], cwd, timeout, ctx.signal);
        note = ' (sandbox: re-run once with full access, approved by the user)';
      } else {
        note = ' (blocked by the sandbox: it may only write inside the approved folders; the user declined full access for this command — do not retry it)';
      }
    }
    const status = r.code === null ? `signal ${r.signal}` : `exit ${r.code}`;
    const body = `$ ${command}\n(cwd: ${cwd}, ${status}${wrapped.sandboxed && !note ? ', sandboxed' : ''}${note})\n${truncate(r.out.trimEnd())}`;
    return r.code === 0 ? ok(body) : fail(body);
  },
};

interface ExecResult {
  out: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

function execOnce(file: string, args: string[], cwd: string, timeout: number, signal: AbortSignal): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' },
    });
    let out = '';
    const push = (d: Buffer) => {
      out += d.toString();
      if (out.length > 1_000_000) child.kill('SIGKILL');
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      out += `\n[killed after ${timeout / 1000}s timeout]`;
    }, timeout);
    const onAbort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (e) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ out: `Failed to start shell: ${e.message}`, code: -1, signal: null });
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ out, code, signal: sig });
    });
  });
}
