import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CouncilWorktree } from '@localdex/shared';
import { DATA_DIR, getSettings } from '../config.js';
import { redactSecrets } from './redact.js';

/**
 * Separate copies (git worktrees) where council builders edit files, so nothing in the user's folder changes until
 * they apply the result. Local git only, no network. Every function takes plain values (no run/session), so several
 * worktrees can exist side by side (e.g. two builders racing on the same task).
 *
 * Internal commits happen only on the worktree's own `council/…` branch, never on the user's branch.
 */

const BRANCH_PREFIX = 'council/';
const MAX_DIFF = 40_000;
const MAX_STAT = 4_000;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

export function worktreesDir(): string {
  return path.join(DATA_DIR, 'worktrees');
}

/**
 * Flags for every git call: no hooks from the user's repo (an internal commit or checkout must not run their
 * pre-commit/post-checkout scripts), no signing prompts, literal pathspecs so odd file names are not patterns.
 */
function baseArgs(): string[] {
  return ['-c', `core.hooksPath=${path.join(worktreesDir(), '.no-hooks')}`, '-c', 'commit.gpgSign=false', '-c', 'core.quotePath=false', '--literal-pathspecs'];
}

const IDENTITY = ['-c', 'user.name=LocalDex', '-c', 'user.email=localdex@localhost'];

interface GitOut {
  ok: boolean;
  out: string;
  err: string;
}

function git(cwd: string, args: string[], input?: string): GitOut {
  const r = spawnSync('git', [...baseArgs(), '-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim() || (r.error?.message ?? '') };
}

const zList = (out: string) => out.split('\0').filter(Boolean);

export interface RepoInfo {
  /** Repo root (top level of the working tree). */
  root: string;
  /** Current commit. */
  head: string;
  /** The folder's path inside the repo ('' at the root). */
  prefix: string;
}

/** The git repo the folder belongs to, or null when it is not a repo or has no commits yet. */
export function repoInfo(dir: string): RepoInfo | null {
  if (!dir || !fs.existsSync(dir)) return null;
  const root = git(dir, ['rev-parse', '--show-toplevel']);
  if (!root.ok) return null;
  const head = git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (!head.ok) return null;
  return { root: root.out.trim(), head: head.out.trim(), prefix: git(dir, ['rev-parse', '--show-prefix']).out.trim() };
}

function safeName(runId: string, label?: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const name = [clean(runId), label ? clean(label) : ''].filter(Boolean).join('-');
  if (!name) throw new Error('A worktree needs a run id.');
  return name;
}

/** True only for paths LocalDex created itself, so discard/cleanup can never remove anything else. */
function isOurs(wt: Pick<CouncilWorktree, 'path' | 'branch'>): boolean {
  const rel = path.relative(worktreesDir(), path.resolve(wt.path));
  return wt.branch.startsWith(BRANCH_PREFIX) && !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep);
}

/**
 * Create a separate copy of the project at its current commit: `git worktree add -b council/<runId>[-<label>]
 * <data>/worktrees/<runId>[-<label>] HEAD`. Uncommitted changes in the user's folder are not in the copy (noted).
 */
export function createWorktree(projectDir: string, runId: string, label?: string): CouncilWorktree {
  const info = repoInfo(projectDir);
  if (!info) throw new Error('The project folder is not a git repository with at least one commit.');
  const name = safeName(runId, label);
  const wtPath = path.join(worktreesDir(), name);
  const branch = `${BRANCH_PREFIX}${name}`;
  fs.mkdirSync(worktreesDir(), { recursive: true });
  if (fs.existsSync(wtPath)) throw new Error(`A separate copy named ${name} already exists.`);
  const add = git(info.root, ['worktree', 'add', '--quiet', '-b', branch, wtPath, info.head]);
  if (!add.ok) throw new Error(`git worktree add failed: ${add.err.split('\n')[0]}`);
  const dirty = git(info.root, ['status', '--porcelain']).out.trim();
  const wt: CouncilWorktree = {
    path: wtPath,
    cwd: info.prefix ? path.join(wtPath, info.prefix) : wtPath,
    branch,
    base: info.head,
    projectDir: path.resolve(projectDir),
    status: 'pending',
    files: [],
    diffStat: '',
    ...(dirty ? { note: 'Your folder had uncommitted changes. The separate copy starts from your last commit, so it does not include them.' } : {}),
  };
  writeMeta(wt, runId);
  return wt;
}

/**
 * Commit everything in the worktree (new files included) on its own council branch, so diffs and apply see
 * exactly what the members left. Returns true when something new was committed.
 */
export function snapshotWorktree(wt: Pick<CouncilWorktree, 'path'>, message = 'LocalDex council snapshot'): boolean {
  if (!fs.existsSync(wt.path)) return false;
  // Never commit on a branch that isn't ours (a member could have switched branches inside the copy).
  const branch = git(wt.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).out.trim();
  if (!branch.startsWith(BRANCH_PREFIX)) return false;
  git(wt.path, ['add', '-A']);
  if (git(wt.path, ['diff', '--cached', '--quiet']).ok) return false;
  return git(wt.path, [...IDENTITY, 'commit', '--quiet', '--no-verify', '-m', message]).ok;
}

export interface WorktreeDiff {
  /** Changed files relative to the repo root. */
  files: string[];
  stat: string;
  /** Unified diff, secrets redacted when that setting is on, capped. */
  diff: string;
}

/** Everything the members changed in the copy since it was made (snapshots first, so new files count). */
export function worktreeDiff(wt: Pick<CouncilWorktree, 'path' | 'base'>, maxChars = MAX_DIFF): WorktreeDiff {
  if (!fs.existsSync(wt.path)) return { files: [], stat: '', diff: '' };
  snapshotWorktree(wt);
  const range = [wt.base, 'HEAD'];
  const files = zList(git(wt.path, ['diff', '-z', '--name-only', '--no-renames', ...range]).out);
  if (!files.length) return { files, stat: '', diff: '' };
  const stat = git(wt.path, ['diff', '--stat=100', '--no-color', '--no-renames', ...range]).out.trimEnd();
  // Redact before truncating so a cut can't leave half a key behind the marker.
  let diff = git(wt.path, ['diff', '--no-color', '--no-renames', '--no-ext-diff', ...range]).out;
  if (getSettings().council.redactSecrets !== false) diff = redactSecrets(diff).text;
  if (diff.length > maxChars) diff = `${diff.slice(0, maxChars)}\n… [diff truncated]`;
  return { files, stat: stat.length > MAX_STAT ? `${stat.slice(0, MAX_STAT)}\n…` : stat, diff };
}

export interface ApplyResult {
  ok: boolean;
  status: CouncilWorktree['status'];
  files: string[];
  error?: string;
}

/**
 * Bring the copy's changes into the user's folder as uncommitted changes. Never commits, never touches files the copy
 * did not change. Refused (status 'conflict', folder untouched) when the user's folder has uncommitted changes to the
 * same files or the patch no longer fits.
 */
export function applyWorktree(projectDir: string, wt: CouncilWorktree): ApplyResult {
  const fail = (status: ApplyResult['status'], error: string, files: string[] = []): ApplyResult => ({ ok: false, status, files, error });
  if (wt.status === 'applied') return fail('applied', 'These changes are already in your folder.', wt.files);
  if (wt.status === 'discarded') return fail('discarded', 'These changes were discarded.');
  if (!fs.existsSync(wt.path)) return fail(wt.status, 'The separate copy is gone, so there is nothing to apply.');
  const info = repoInfo(projectDir);
  if (!info) return fail(wt.status, 'Your project folder is no longer a git repository.');

  snapshotWorktree(wt);
  const tip = git(wt.path, ['rev-parse', 'HEAD']).out.trim();
  const files = zList(git(wt.path, ['diff', '-z', '--name-only', '--no-renames', wt.base, tip]).out);
  if (!files.length) return { ok: true, status: 'applied', files };

  const dirty = git(info.root, ['status', '--porcelain', '--untracked-files=all', '--', ...files]).out.trimEnd();
  if (dirty) {
    const names = dirty.split('\n').map((l) => l.slice(3)).slice(0, 8);
    return fail('conflict', `Your folder has uncommitted changes to ${names.join(', ')}${dirty.split('\n').length > 8 ? ', …' : ''}. Commit, stash or undo them, then apply again. Nothing was changed.`, files);
  }

  const patch = git(wt.path, ['diff', '--binary', '--full-index', '--no-renames', '--no-color', '--no-ext-diff', wt.base, tip]).out;
  if (git(info.root, ['apply', '--check', '--whitespace=nowarn'], patch).ok) {
    const r = git(info.root, ['apply', '--whitespace=nowarn'], patch);
    if (r.ok) return { ok: true, status: 'applied', files };
    restore(info.root, files);
    return fail('conflict', `git apply failed: ${r.err.split('\n')[0]}. Nothing was changed.`, files);
  }

  // The folder moved on since the copy was made (e.g. new commits): try a three-way merge of the same files.
  const r = git(info.root, ['apply', '--3way', '--whitespace=nowarn'], patch);
  const unmerged = zList(git(info.root, ['diff', '-z', '--name-only', '--diff-filter=U']).out);
  if (!r.ok || unmerged.length) {
    restore(info.root, files);
    const which = unmerged.length ? unmerged : files;
    return fail('conflict', `Your folder changed since this copy was made and the changes don't merge cleanly (${which.slice(0, 8).join(', ')}). Nothing was changed.`, files);
  }
  // --3way stages what it applies; leave the files as plain uncommitted edits like any other change.
  git(info.root, ['reset', '--quiet', '--', ...files]);
  return { ok: true, status: 'applied', files };
}

/** Put files that were clean before an apply attempt back to HEAD (lossless: they had no uncommitted changes). */
function restore(root: string, files: string[]): void {
  git(root, ['reset', '--quiet', '--', ...files]);
  for (const f of files) {
    if (git(root, ['cat-file', '-e', `HEAD:${f}`]).ok) git(root, ['checkout', 'HEAD', '--', f]);
    else fs.rmSync(path.join(root, f), { force: true });
  }
}

/** Remove the copy and its branch. Only ever touches worktrees under LocalDex's data folder on council/ branches. */
export function discardWorktree(projectDir: string, wt: Pick<CouncilWorktree, 'path' | 'branch'>): { ok: boolean; error?: string } {
  if (!isOurs(wt)) return { ok: false, error: 'Not a LocalDex council copy; left alone.' };
  const root = repoInfo(projectDir)?.root;
  if (root) git(root, ['worktree', 'remove', '--force', '--force', wt.path]);
  if (fs.existsSync(wt.path)) fs.rmSync(wt.path, { recursive: true, force: true });
  if (root) {
    git(root, ['worktree', 'prune']);
    if (git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${wt.branch}`]).ok) {
      const del = git(root, ['branch', '-D', wt.branch]);
      if (!del.ok) return { ok: false, error: `Removed the copy, but could not delete branch ${wt.branch}: ${del.err.split('\n')[0]}` };
    }
  }
  return { ok: true };
}

// ---------- bookkeeping: <data>/worktrees/<name>.json, for listing and startup cleanup ----------

export interface WorktreeRecord extends CouncilWorktree {
  runId: string;
  createdAt: number;
  updatedAt: number;
}

const metaFile = (wt: Pick<CouncilWorktree, 'path'>) => `${path.resolve(wt.path)}.json`;

function writeMeta(wt: CouncilWorktree, runId: string): void {
  const rec: WorktreeRecord = { ...wt, diff: undefined, runId, createdAt: Date.now(), updatedAt: Date.now() };
  try {
    fs.writeFileSync(metaFile(wt), JSON.stringify(rec, null, 2));
  } catch {
    /* bookkeeping only */
  }
}

/** Save a status change (applied, discarded, conflict) so cleanup knows what is safe to remove. */
export function recordWorktreeStatus(wt: CouncilWorktree): void {
  try {
    const prev = JSON.parse(fs.readFileSync(metaFile(wt), 'utf8')) as WorktreeRecord;
    fs.writeFileSync(metaFile(wt), JSON.stringify({ ...prev, status: wt.status, files: wt.files, diffStat: wt.diffStat, error: wt.error, updatedAt: Date.now() }, null, 2));
  } catch {
    /* no record (older copy): nothing to update */
  }
}

export function listCouncilWorktrees(): WorktreeRecord[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(worktreesDir()).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: WorktreeRecord[] = [];
  for (const n of names) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(worktreesDir(), n), 'utf8')) as WorktreeRecord);
    } catch {
      /* unreadable record: skip */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Remove copies that were applied or discarded more than 7 days ago (and their records). Returns how many. */
export function cleanupStaleWorktrees(now = Date.now(), maxAgeMs = STALE_MS): number {
  let n = 0;
  for (const rec of listCouncilWorktrees()) {
    if ((rec.status !== 'applied' && rec.status !== 'discarded') || now - rec.updatedAt < maxAgeMs) continue;
    const r = discardWorktree(rec.projectDir, rec);
    if (!r.ok && isOurs(rec)) continue;
    fs.rmSync(metaFile(rec), { force: true });
    n++;
  }
  return n;
}
