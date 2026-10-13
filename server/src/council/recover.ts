import path from 'node:path';
import type { CouncilRun, CouncilWorktree, Session } from '@localdex/shared';

/**
 * Startup bookkeeping for council runs. Kept free of git and process state so the session store can call it when
 * it loads a session from disk.
 */

export const INTERRUPTED_NOTE = 'LocalDex stopped while this council run was in progress, so it was cancelled.';

/**
 * A session loaded from disk can't have a run in flight (the server that ran it is gone). Runs still marked running,
 * with their unfinished steps and arena entries, become cancelled, so their waiting changes can be applied or
 * discarded. Returns true when something changed.
 */
export function recoverInterruptedRuns(session: Session): boolean {
  let changed = false;
  for (const run of session.councilRuns ?? []) {
    if (run.status !== 'running') continue;
    changed = true;
    run.status = 'cancelled';
    run.endedAt ??= Date.now();
    run.result = run.result ? `${run.result}\n\n_${INTERRUPTED_NOTE}_` : INTERRUPTED_NOTE;
    for (const s of run.steps) {
      if (s.status !== 'running' && s.status !== 'queued') continue;
      s.status = 'cancelled';
      s.error ??= INTERRUPTED_NOTE;
      s.endedAt ??= Date.now();
    }
    for (const x of run.arena?.entries ?? []) {
      if (x.status === 'running' || x.status === 'queued') x.status = 'cancelled';
    }
  }
  return changed;
}

/** Every separate copy a run refers to (its own, or each arena contestant's). */
export function runCopies(run: CouncilRun): CouncilWorktree[] {
  return [...(run.worktree ? [run.worktree] : []), ...(run.arena?.entries.map((x) => x.worktree) ?? [])];
}

/** Paths of the copies still waiting (pending or conflict) in these sessions; any other waiting copy is orphaned. */
export function waitingCopyPaths(sessions: Session[]): Set<string> {
  const out = new Set<string>();
  for (const s of sessions) {
    for (const run of s.councilRuns ?? []) {
      for (const wt of runCopies(run)) if (wt.status === 'pending' || wt.status === 'conflict') out.add(path.resolve(wt.path));
    }
  }
  return out;
}
