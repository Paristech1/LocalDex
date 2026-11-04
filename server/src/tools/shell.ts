import { spawn } from 'node:child_process';
import { defaultCwd, resolvePath, shellNeedsApproval } from './permissions.js';
import { fail, ok, optNum, optStr, str, truncate, type ToolDef } from './types.js';
import { DECLINED_COMMAND } from './types.js';
import { PLAN_SHELL_REFUSAL, isReadOnlyCommand } from '../agent/planMode.js';
import { startJob } from '../jobs.js';

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
      const approved = await ctx.requestApproval(command, cwd);
      if (!approved) return fail(DECLINED_COMMAND);
    }
    if (args.background === true || args.background === 'true') {
      if (ctx.planMode) return fail(PLAN_SHELL_REFUSAL);
      const job = startJob(ctx.sessionId, ctx.agent, command, cwd);
      return ok(`Started background job ${job.id} (pid ${job.pid ?? '?'}): ${command}\nIt keeps running while you continue. You will get a notice when it finishes; job_output reads what it printed (wait_seconds waits), job_kill stops it.`);
    }

    return new Promise((resolve) => {
      const child = spawn(SHELL, ['-lc', command], {
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
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (e) => {
        clearTimeout(timer);
        resolve(fail(`Failed to start shell: ${e.message}`));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        const status = code === null ? `signal ${signal}` : `exit ${code}`;
        const body = `$ ${command}\n(cwd: ${cwd}, ${status})\n${truncate(out.trimEnd())}`;
        resolve(code === 0 ? ok(body) : fail(body));
      });
    });
  },
};
