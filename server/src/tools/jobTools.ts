import { MAX_WAIT_MS, getJob, jobOutput, killJob, listJobs } from '../jobs.js';
import { fail, ok, optNum, str, truncate, type ToolDef } from './types.js';

/** Background job tools (A2). Offered once the session has a job; see jobs.ts. */

function describe(j: { id: string; command: string; status: string; startedAt: number; endedAt?: number; exitCode?: number; bytes: number }): string {
  const secs = Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000);
  return `${j.id}: ${j.status}${j.exitCode !== undefined ? ` (exit ${j.exitCode})` : ''}, ${secs}s, ${j.bytes} bytes of output — ${j.command.slice(0, 100)}`;
}

export const job_output: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'job_output',
      description: 'New output from a background job since you last looked. wait_seconds (0–60) waits for the job to finish or print more.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job id from shell_run (e.g. "job1").' },
          wait_seconds: { type: 'integer', description: 'Wait up to this long (default 0, max 60).' },
        },
        required: ['id'],
      },
    },
  },
  async run(args, ctx) {
    const id = str(args.id, 'id');
    const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, (optNum(args.wait_seconds) ?? 0) * 1000));
    const r = await jobOutput(ctx.sessionId, id, { waitMs, signal: ctx.signal, yieldNow: ctx.hasCorrections });
    if (!r) return fail(`No job "${id}" in this session. Call job_list to see the jobs.`);
    const head = describe(r.job);
    const body = r.output ? truncate(r.output) : r.job.status === 'running' ? '(no new output)' : '(no further output)';
    const yielded = r.job.status === 'running' && waitMs > 0 && r.waited < waitMs && !r.output ? '\n[wait ended early: the user sent a message]' : '';
    return (r.job.status === 'failed' ? fail : ok)(`${head}\n${r.droppedNotice}${body}${yielded}`);
  },
};

export const job_list: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'job_list',
      description: 'List this session\'s background jobs with status and exit code.',
      parameters: { type: 'object', properties: {} },
    },
  },
  async run(_args, ctx) {
    const all = listJobs(ctx.sessionId);
    if (!all.length) return ok('No background jobs. Start one with shell_run and background: true.');
    return ok(all.map(describe).join('\n'));
  },
};

export const job_kill: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'job_kill',
      description: 'Stop a running background job (and the processes it started).',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
  async run(args, ctx) {
    const id = str(args.id, 'id');
    if (!getJob(ctx.sessionId, id)) return fail(`No job "${id}" in this session.`);
    const r = killJob(ctx.sessionId, id);
    return r.ok ? ok(r.message) : fail(r.message);
  },
};
