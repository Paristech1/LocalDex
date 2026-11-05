import { wrapCommand } from './sandbox.js';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentId, JobInfo } from '@localdex/shared';
import { bus } from './agent/bus.js';

/**
 * Background jobs (A2). Patterns from DeepSeek Harness `jobs/jobs-local` (output ring buffer, ownership, lifecycle)
 * and `jobs/tool-jobs` (bounded waits that yield to a user correction), reimplemented. Jobs belong to a session and
 * die with the server; they are not persisted.
 */

const SHELL = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');
/** Output kept per job: the newest RING_BYTES; older output is dropped (the model sees a notice when that happens). */
export const RING_BYTES = 64 * 1024;
/** Finished jobs kept per session, so the agent can still read their output. */
const KEEP_FINISHED = 20;
/** A job_output wait never exceeds this. */
export const MAX_WAIT_MS = 60_000;

interface Job extends JobInfo {
  sessionId: string;
  agent: AgentId;
  child: ChildProcess | null;
  /** Newest output; `dropped` bytes fell off the front. */
  ring: string;
  dropped: number;
  /** Offset (in total bytes produced) up to which the agent has read. */
  readOffset: number;
  /** Set once the finish notice was delivered to the agent. */
  notified: boolean;
}

const jobs = new Map<string, Job>();
let seq = 0;
type Listener = (job: JobInfo & { tail: string }) => void;
const listeners = new Map<string, Listener>();

/** The runner registers here to receive finish notices for its session's jobs. */
export function onJobFinished(sessionId: string, cb: Listener | null): void {
  if (cb) listeners.set(sessionId, cb);
  else listeners.delete(sessionId);
}

function info(j: Job): JobInfo {
  return { id: j.id, command: j.command, cwd: j.cwd, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt, exitCode: j.exitCode, bytes: j.bytes, pid: j.pid };
}

export function listJobs(sessionId: string): JobInfo[] {
  return [...jobs.values()].filter((j) => j.sessionId === sessionId).map(info);
}

function broadcast(sessionId: string): void {
  bus.emit({ type: 'jobs', sessionId, jobs: listJobs(sessionId) });
}

function total(j: Job): number {
  return j.dropped + j.ring.length;
}

export function startJob(sessionId: string, agent: AgentId, command: string, cwd: string): JobInfo {
  const id = `job${++seq}`;
  // Same permission preset as shell_run (throws SandboxUnavailableError when the preset needs a sandbox that isn't there).
  const w = wrapCommand(SHELL, ['-lc', command]);
  const child = spawn(w.file, w.args, {
    cwd,
    env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const j: Job = {
    id, sessionId, agent, command, cwd, status: 'running', startedAt: Date.now(), bytes: 0, pid: child.pid,
    child, ring: '', dropped: 0, readOffset: 0, notified: false,
  };
  jobs.set(id, j);
  const push = (d: Buffer) => {
    const text = d.toString();
    j.bytes += text.length;
    j.ring += text;
    if (j.ring.length > RING_BYTES) {
      const cut = j.ring.length - RING_BYTES;
      j.ring = j.ring.slice(cut);
      j.dropped += cut;
    }
  };
  child.stdout?.on('data', push);
  child.stderr?.on('data', push);
  child.on('error', (e) => {
    push(Buffer.from(`\n[failed to start: ${e.message}]`));
    finish(j, null, 'failed');
  });
  child.on('close', (code, signal) => finish(j, code, j.status === 'killed' ? 'killed' : code === 0 ? 'done' : 'failed', signal ?? undefined));
  trimFinished(sessionId);
  bus.log('info', `[${agent}] job ${id} started: ${command.slice(0, 120)}`);
  broadcast(sessionId);
  return info(j);
}

function finish(j: Job, code: number | null, status: Job['status'], signal?: string): void {
  if (j.status !== 'running' && j.endedAt) return;
  j.status = status;
  j.exitCode = code ?? undefined;
  j.endedAt = Date.now();
  j.child = null;
  const secs = Math.round((j.endedAt - j.startedAt) / 1000);
  bus.log('info', `[${j.agent}] job ${j.id} ${status}${code !== null ? ` (exit ${code})` : signal ? ` (${signal})` : ''} after ${secs}s: ${j.command.slice(0, 80)}`);
  broadcast(j.sessionId);
  const cb = listeners.get(j.sessionId);
  if (cb && !j.notified) {
    j.notified = true;
    cb({ ...info(j), tail: j.ring.slice(-2_000) });
  }
}

function trimFinished(sessionId: string): void {
  const done = [...jobs.values()].filter((j) => j.sessionId === sessionId && j.status !== 'running').sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  for (const j of done.slice(0, Math.max(0, done.length - KEEP_FINISHED))) jobs.delete(j.id);
}

export function getJob(sessionId: string, id: string): JobInfo | null {
  const j = jobs.get(id);
  return j && j.sessionId === sessionId ? info(j) : null;
}

export function killJob(sessionId: string, id: string): { ok: boolean; message: string } {
  const j = jobs.get(id);
  if (!j || j.sessionId !== sessionId) return { ok: false, message: `No job "${id}" in this session.` };
  if (j.status !== 'running' || !j.child) return { ok: false, message: `Job ${id} already ${j.status}.` };
  j.status = 'killed';
  try {
    // The whole process group, so a shell's children (dev servers, watchers) go too.
    if (process.platform !== 'win32' && j.child.pid) process.kill(-j.child.pid, 'SIGTERM');
    else j.child.kill('SIGTERM');
  } catch {
    j.child.kill('SIGKILL');
  }
  const pid = j.child.pid;
  setTimeout(() => {
    if (!j.endedAt && pid) {
      try {
        process.platform !== 'win32' ? process.kill(-pid, 'SIGKILL') : j.child?.kill('SIGKILL');
      } catch { /* already gone */ }
    }
  }, 2_000).unref();
  return { ok: true, message: `Job ${id} killed.` };
}

/**
 * New output since the agent last read, waiting up to `waitMs` for the job to finish or print more. The wait stops
 * early when `yieldNow()` says a user correction is pending, so the model gets to see it on this step.
 */
export async function jobOutput(
  sessionId: string,
  id: string,
  opts: { waitMs?: number; signal?: AbortSignal; yieldNow?: () => boolean } = {},
): Promise<{ job: JobInfo; output: string; droppedNotice: string; waited: number } | null> {
  const j = jobs.get(id);
  if (!j || j.sessionId !== sessionId) return null;
  const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, opts.waitMs ?? 0));
  const start = Date.now();
  const before = total(j);
  while (j.status === 'running' && Date.now() - start < waitMs && total(j) === before && !opts.signal?.aborted && !opts.yieldNow?.()) {
    await new Promise((r) => setTimeout(r, 150));
  }
  const from = Math.max(j.readOffset, j.dropped);
  const droppedNotice = j.readOffset < j.dropped ? `[${j.dropped - j.readOffset} bytes of older output were dropped; only the newest ${RING_BYTES / 1024} KB are kept]\n` : '';
  const output = j.ring.slice(from - j.dropped);
  j.readOffset = total(j);
  return { job: info(j), output, droppedNotice, waited: Date.now() - start };
}

/** A session was deleted: stop its running jobs, forget them all and drop its finish listener (nothing may write to it again). */
export function dropSessionJobs(sessionId: string): number {
  listeners.delete(sessionId);
  let n = 0;
  for (const j of [...jobs.values()]) {
    if (j.sessionId !== sessionId) continue;
    if (j.status === 'running') {
      j.notified = true;
      killJob(sessionId, j.id);
      n++;
    }
    jobs.delete(j.id);
  }
  return n;
}

/** Server shutdown: stop every running job. */
export function killAllJobs(): void {
  for (const j of jobs.values()) if (j.status === 'running') killJob(j.sessionId, j.id);
}

export function hasJobs(sessionId: string): boolean {
  for (const j of jobs.values()) if (j.sessionId === sessionId) return true;
  return false;
}
