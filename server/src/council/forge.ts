// E3: "Open PR" from a council run's separate copy, through the GitHub CLI (`gh`), plus a PR status chip.
// Pattern from DeepSeek Harness experimental/forge + forge-github (change requests bound to the session that made them,
// status polled through gh), reimplemented. Nothing is pushed unless the user clicks; the user's own branch and
// uncommitted work never go into the PR.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CouncilRun, CouncilWorktree, ForgeStatus } from '@localdex/shared';
import { GIT_IDENTITY, gitIn, snapshotWorktree, worktreeDiff } from './worktrees.js';

const GH = () => process.env.LOCALDEX_GH || 'gh';

function gh(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync(GH(), args, { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' } });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: ((r.stderr ?? '').trim() || r.error?.message) ?? '' };
}

let cached: { at: number; status: ForgeStatus } | null = null;

/** Is `gh` installed and signed in? Checked at most once a minute. */
export function forgeStatus(force = false): ForgeStatus {
  if (!force && cached && Date.now() - cached.at < 60_000) return cached.status;
  const v = gh(os.homedir(), ['--version']);
  let status: ForgeStatus;
  if (!v.ok) status = { gh: false, reason: 'GitHub CLI (gh) is not installed' };
  else {
    const a = gh(os.homedir(), ['auth', 'status']);
    status = a.ok ? { gh: true } : { gh: false, reason: 'gh is not signed in (run `gh auth login`)' };
  }
  cached = { at: Date.now(), status };
  return status;
}

export function resetForgeCache(): void {
  cached = null;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'change';
}

/**
 * One commit on top of the user's last commit with only what the members changed in the copy. When the copy also
 * holds the user's uncommitted changes (its base commit), those are left out; if the members' edits can't be
 * separated from them, refuse.
 */
function memberOnlyCommit(wt: CouncilWorktree, message: string): { sha?: string; parent?: string; error?: string } {
  snapshotWorktree(wt);
  const head = gitIn(wt.path, ['rev-parse', 'HEAD']).out.trim();
  const parent = wt.imported ? gitIn(wt.path, ['rev-parse', `${wt.base}^`]).out.trim() : wt.base;
  if (!head || !parent) return { error: 'Could not read the copy’s commits.' };
  const patch = gitIn(wt.path, ['diff', '--binary', '--no-renames', wt.base, head]);
  if (!patch.ok) return { error: `git diff failed: ${patch.err.split('\n')[0]}` };
  if (!patch.out.trim()) return { error: 'The members made no changes in this copy.' };
  const tmpIndex = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'localdex-pr-')), 'index');
  try {
    const env = { GIT_INDEX_FILE: tmpIndex };
    if (!gitIn(wt.path, ['read-tree', parent], undefined, env).ok) return { error: 'git read-tree failed.' };
    const ap = gitIn(wt.path, ['apply', '--cached', '--whitespace=nowarn'], patch.out, env);
    if (!ap.ok) return { error: 'The members changed lines that are also in your uncommitted changes, so their work can’t be split out for a PR. Commit your own changes first, or use Apply instead.' };
    const tree = gitIn(wt.path, ['write-tree'], undefined, env).out.trim();
    const commit = gitIn(wt.path, [...GIT_IDENTITY, 'commit-tree', tree, '-p', parent, '-m', message]);
    if (!commit.ok) return { error: `git commit-tree failed: ${commit.err.split('\n')[0]}` };
    return { sha: commit.out.trim(), parent };
  } finally {
    fs.rmSync(path.dirname(tmpIndex), { recursive: true, force: true });
  }
}

/** Push the members' changes to a new `localdex/…` branch and open a pull request. Updates `wt.pr`. */
export function openPullRequest(run: CouncilRun, wt: CouncilWorktree): { ok: boolean; message: string } {
  if (wt.pr) return { ok: false, message: `A pull request is already open: ${wt.pr.url}` };
  if (wt.status !== 'pending') return { ok: false, message: 'Only waiting changes can become a pull request.' };
  const fstat = forgeStatus(true);
  if (!fstat.gh) return { ok: false, message: fstat.reason ?? 'GitHub CLI unavailable.' };
  const remote = gitIn(wt.path, ['remote', 'get-url', 'origin']);
  if (!remote.ok) return { ok: false, message: 'This repository has no "origin" remote to push to.' };
  const task = run.task.split('\n')[0].trim();
  const title = task.length > 72 ? `${task.slice(0, 69)}…` : task || 'LocalDex council change';
  const made = memberOnlyCommit(wt, title);
  if (!made.sha) return { ok: false, message: made.error ?? 'Could not build the commit.' };
  const branch = `localdex/${slug(task)}-${run.id.slice(0, 6)}`;
  const push = gitIn(wt.path, ['push', '--quiet', 'origin', `${made.sha}:refs/heads/${branch}`]);
  if (!push.ok) return { ok: false, message: `git push failed: ${push.err.split('\n').slice(-2).join(' ')}` };
  // Base: the user's current branch when it exists on the remote, else the repository's default branch.
  const userBranch = gitIn(wt.projectDir, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
  const onRemote = userBranch && userBranch !== 'HEAD' && gitIn(wt.projectDir, ['ls-remote', '--exit-code', '--heads', 'origin', userBranch]).ok;
  const diff = worktreeDiff(wt);
  const via = [...new Set(run.steps.filter((s) => s.status === 'done').map((s) => s.member))].join(', ');
  const body = [
    `**Task:** ${run.task.slice(0, 1500)}`,
    '',
    `Built by the LocalDex model council (${via || 'council'}; pattern: ${run.pattern}).`,
    '',
    '```',
    diff.stat.trim().slice(0, 3000),
    '```',
  ].join('\n');
  const args = ['pr', 'create', '--head', branch, '--title', title, '--body', body, ...(onRemote ? ['--base', userBranch] : [])];
  const pr = gh(wt.projectDir, args);
  if (!pr.ok) return { ok: false, message: `gh pr create failed: ${pr.err.split('\n').slice(-2).join(' ')} (the branch ${branch} was pushed)` };
  const url = pr.out.split('\n').map((l) => l.trim()).find((l) => /^https?:\/\/\S+\/pull\/\d+/.test(l)) ?? pr.out.split('\n').pop()!.trim();
  const number = Number(url.match(/\/pull\/(\d+)/)?.[1] ?? 0) || undefined;
  wt.pr = { url, number, branch, state: 'OPEN', checkedAt: Date.now() };
  return { ok: true, message: `Opened ${url}` };
}

/** Refresh the PR's state (open / merged / closed), review decision and checks. */
export function refreshPullRequest(wt: CouncilWorktree): { ok: boolean; message: string } {
  if (!wt.pr) return { ok: false, message: 'No pull request for this copy.' };
  const r = gh(wt.projectDir, ['pr', 'view', wt.pr.url, '--json', 'state,reviewDecision,statusCheckRollup,mergedAt']);
  if (!r.ok) return { ok: false, message: `gh pr view failed: ${r.err.split('\n')[0]}` };
  try {
    const j = JSON.parse(r.out) as { state?: string; reviewDecision?: string; statusCheckRollup?: Array<{ conclusion?: string; state?: string; status?: string }> };
    const checks = j.statusCheckRollup ?? [];
    const failed = checks.some((c) => /FAILURE|ERROR|CANCELLED|TIMED_OUT/.test(String(c.conclusion ?? c.state ?? '')));
    const pending = checks.some((c) => /PENDING|IN_PROGRESS|QUEUED|EXPECTED/.test(String(c.status ?? c.state ?? '')) && !c.conclusion);
    wt.pr = {
      ...wt.pr,
      state: (j.state as 'OPEN' | 'MERGED' | 'CLOSED') ?? wt.pr.state,
      review: j.reviewDecision || undefined,
      checks: checks.length ? (failed ? 'failing' : pending ? 'pending' : 'passing') : undefined,
      checkedAt: Date.now(),
    };
    return { ok: true, message: `PR ${wt.pr.state.toLowerCase()}` };
  } catch {
    return { ok: false, message: 'Could not read gh output.' };
  }
}
