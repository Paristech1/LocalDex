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
/** Untracked files bigger than this (in total) are not copied into a new copy; it then starts from the last commit. */
const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
/**
 * Patch flags that ignore the user's diff config (noprefix, textconv, external diff, renames, color), so the patch
 * can always be applied with `git apply`.
 */
const PATCH_ARGS = ['--binary', '--full-index', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];

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
 * Create a separate copy of the project: `git worktree add -b council/<runId>[-<label>] <data>/worktrees/<runId>[-<label>]
 * HEAD`, then bring in the user's uncommitted changes (tracked edits, staged or not, and untracked files git doesn't
 * ignore) and commit them on the copy's branch as its base. Diffs and apply then carry only what members change on
 * top. If that import fails, the copy starts from the last commit and `note` says so.
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
  const imp = importUncommitted(info, wtPath);
  const wt: CouncilWorktree = {
    path: wtPath,
    cwd: info.prefix ? path.join(wtPath, info.prefix) : wtPath,
    branch,
    base: imp.base ?? info.head,
    projectDir: path.resolve(projectDir),
    status: 'pending',
    files: [],
    diffStat: '',
    ...(imp.files.length ? { imported: imp.files.length } : {}),
    ...(imp.error ? { note: `Your folder has uncommitted changes, but they couldn't be copied in (${imp.error}). The separate copy starts from your last commit, so it does not include them.` } : {}),
  };
  writeMeta(wt, runId);
  return wt;
}

interface ImportResult {
  /** The copy's base commit holding the user's uncommitted changes; absent when there were none or the import failed. */
  base?: string;
  files: string[];
  error?: string;
}

/** Copy the user's uncommitted changes into a fresh copy and commit them there as its base (see createWorktree). */
function importUncommitted(info: RepoInfo, wtPath: string): ImportResult {
  const dirty = zList(git(info.root, ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames']).out);
  if (!dirty.length) return { files: [] };
  const undo = (error: string): ImportResult => {
    git(wtPath, ['reset', '--quiet', '--hard', info.head]);
    git(wtPath, ['clean', '-qfd']);
    return { files: [], error };
  };
  try {
    // Tracked edits, staged or not, against the last commit.
    const patch = git(info.root, ['diff', ...PATCH_ARGS, 'HEAD']);
    if (!patch.ok) return undo(`git diff failed: ${patch.err.split('\n')[0]}`);
    if (patch.out.trim()) {
      const ap = git(wtPath, ['apply', '--whitespace=nowarn'], patch.out);
      if (!ap.ok) return undo(`git apply failed: ${ap.err.split('\n')[0]}`);
    }
    // New files git doesn't ignore. Nested repositories ("dir/") are left out.
    const untracked = zList(git(info.root, ['ls-files', '-z', '--others', '--exclude-standard']).out).filter((f) => !f.endsWith('/'));
    let bytes = 0;
    for (const f of untracked) {
      const from = path.join(info.root, f);
      const to = path.join(wtPath, f);
      const st = fs.lstatSync(from, { throwIfNoEntry: false });
      if (!st) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
      else if (st.isFile()) {
        bytes += st.size;
        if (bytes > MAX_IMPORT_BYTES) return undo(`new files are over ${MAX_IMPORT_BYTES / 1024 / 1024} MB`);
        fs.copyFileSync(from, to);
        fs.chmodSync(to, st.mode & 0o777);
      }
    }
    git(wtPath, ['add', '-A']);
    if (git(wtPath, ['diff', '--cached', '--quiet']).ok) return { files: [] };
    const files = zList(git(wtPath, ['diff', '--cached', '-z', '--name-only', '--no-renames']).out);
    const c = git(wtPath, [...IDENTITY, 'commit', '--quiet', '--no-verify', '-m', 'LocalDex: your uncommitted changes']);
    if (!c.ok) return undo(`commit failed: ${c.err.split('\n')[0]}`);
    return { base: git(wtPath, ['rev-parse', 'HEAD']).out.trim(), files };
  } catch (e) {
    return undo((e as Error).message);
  }
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
  let diff = git(wt.path, ['diff', '--no-color', '--no-renames', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', ...range]).out;
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
 * did not change. Refused (status 'conflict', folder untouched) when:
 * - a changed file is outside the project folder (the project is a subfolder of a bigger repo),
 * - a changed file in the user's folder is neither as it was when the copy was made (the copy's base, which includes
 *   the user's uncommitted changes from then) nor clean against their last commit: they edited it since, or the copy
 *   would create a file that already exists (ignored files like .env included),
 * - or the patch doesn't fit. A failed attempt puts every touched file (and its index entry) back exactly as it was.
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
  const some = (list: string[]) => `${list.slice(0, 8).join(', ')}${list.length > 8 ? ', …' : ''}`;

  if (info.prefix) {
    const outside = files.filter((f) => !f.startsWith(info.prefix));
    if (outside.length) {
      return fail('conflict', `These changes touch files outside your project folder (${path.resolve(projectDir)}): ${some(outside)}. LocalDex only applies changes inside it. Nothing was changed.`, files);
    }
  }

  const blocked = blockedFiles(info.root, wt, files);
  if (blocked.length) {
    const ignored = blocked.filter((f) => f.endsWith(' (ignored by git)'));
    const why = [
      blocked.length > ignored.length ? `has uncommitted changes to ${some(blocked.filter((f) => !ignored.includes(f)))}` : '',
      ignored.length ? `already has ${some(ignored)}, which these changes would replace` : '',
    ].filter(Boolean);
    return fail('conflict', `Your folder ${why.join(' and ')}. Commit, stash, move or undo them, then apply again. Nothing was changed.`, files);
  }

  const backup = backupFiles(info.root, files);
  const patch = git(wt.path, ['diff', ...PATCH_ARGS, wt.base, tip]).out;
  if (git(info.root, ['apply', '--check', '--whitespace=nowarn'], patch).ok) {
    const r = git(info.root, ['apply', '--whitespace=nowarn'], patch);
    if (r.ok) return { ok: true, status: 'applied', files };
    restoreFiles(info.root, backup);
    return fail('conflict', `git apply failed: ${r.err.split('\n')[0]}. Nothing was changed.`, files);
  }

  // The folder moved on since the copy was made (e.g. new commits): try a three-way merge of the same files.
  const r = git(info.root, ['apply', '--3way', '--whitespace=nowarn'], patch);
  const unmerged = zList(git(info.root, ['diff', '-z', '--name-only', '--diff-filter=U']).out);
  if (!r.ok || unmerged.length) {
    restoreFiles(info.root, backup);
    return fail('conflict', `Your folder changed since this copy was made and the changes don't merge cleanly (${some(unmerged.length ? unmerged : files)}). Nothing was changed.`, files);
  }
  // --3way stages what it applies; leave the files as plain uncommitted edits, with the index as it was.
  restoreIndex(info.root, backup);
  return { ok: true, status: 'applied', files };
}

/**
 * Files an apply must not touch: their content in the user's folder differs from the copy's base, and they are not
 * clean against the user's last commit (uncommitted edits, or an untracked or ignored file in the way).
 * Ignored files are labelled, since the user won't see them in `git status`.
 */
function blockedFiles(root: string, wt: Pick<CouncilWorktree, 'path' | 'base'>, files: string[]): string[] {
  const base = new Map<string, string>();
  for (const line of zList(git(wt.path, ['ls-tree', '-z', '--full-tree', wt.base, '--', ...files]).out)) {
    const tab = line.indexOf('\t');
    base.set(line.slice(tab + 1), line.slice(0, tab).split(' ')[2]);
  }
  const disk = diskIds(root, files);
  const differs = files.filter((f) => disk.get(f) !== base.get(f));
  if (!differs.length) return [];
  const dirty = new Map<string, string>();
  for (const e of zList(git(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignored=matching', '--no-renames', '--', ...differs]).out)) {
    dirty.set(e.slice(3).replace(/\/$/, ''), e.slice(0, 2));
  }
  // A directory where a file should go blocks too.
  return differs.filter((f) => dirty.has(f) || disk.get(f) === 'dir').map((f) => (dirty.get(f) === '!!' ? `${f} (ignored by git)` : f));
}

/** Blob id of each file as it is on disk (git's clean filters applied), 'dir' for anything else, absent when missing. */
function diskIds(root: string, files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const regular: string[] = [];
  for (const f of files) {
    const abs = path.join(root, f);
    const st = fs.lstatSync(abs, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isSymbolicLink()) out.set(f, git(root, ['hash-object', '--stdin'], fs.readlinkSync(abs)).out.trim());
    else if (st.isFile()) regular.push(f);
    else out.set(f, 'dir');
  }
  if (regular.length) {
    const ids = git(root, ['hash-object', '--stdin-paths'], `${regular.join('\n')}\n`).out.trim().split('\n');
    regular.forEach((f, i) => {
      if (ids[i]) out.set(f, ids[i]);
    });
  }
  return out;
}

interface FileBackup {
  file: string;
  kind: 'missing' | 'file' | 'link';
  data?: Buffer;
  mode?: number;
  link?: string;
  /** Parent folders that did not exist before the attempt (deepest first); removed again when left empty. */
  newDirs: string[];
  /** `git ls-files -s` entries before the attempt. */
  index: string[];
}

/** Everything needed to put the files (and their index entries) back exactly as they were before an apply attempt. */
function backupFiles(root: string, files: string[]): FileBackup[] {
  const index = new Map<string, string[]>();
  for (const e of zList(git(root, ['ls-files', '-s', '-z', '--', ...files]).out)) {
    const f = e.slice(e.indexOf('\t') + 1);
    index.set(f, [...(index.get(f) ?? []), e]);
  }
  return files.map((file): FileBackup => {
    const abs = path.join(root, file);
    const newDirs: string[] = [];
    for (let d = path.dirname(abs); d.startsWith(root + path.sep) && !fs.existsSync(d); d = path.dirname(d)) newDirs.push(d);
    const st = fs.lstatSync(abs, { throwIfNoEntry: false });
    const idx = index.get(file) ?? [];
    if (st?.isSymbolicLink()) return { file, kind: 'link', link: fs.readlinkSync(abs), newDirs, index: idx };
    if (st?.isFile()) return { file, kind: 'file', data: fs.readFileSync(abs), mode: st.mode & 0o777, newDirs, index: idx };
    // blockedFiles refuses anything else in the way, so this file did not exist before the attempt.
    return { file, kind: 'missing', newDirs, index: idx };
  });
}

/** Undo a failed apply: files that existed get their old content back, only files that didn't exist are removed. */
function restoreFiles(root: string, backup: FileBackup[]): void {
  restoreIndex(root, backup);
  for (const b of backup) {
    const abs = path.join(root, b.file);
    const st = fs.lstatSync(abs, { throwIfNoEntry: false });
    if (st && !st.isDirectory()) fs.rmSync(abs, { force: true });
    if (b.kind === 'file') {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, b.data!);
      fs.chmodSync(abs, b.mode!);
    } else if (b.kind === 'link') {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.symlinkSync(b.link!, abs);
    }
    for (const d of b.newDirs) {
      try {
        fs.rmdirSync(d);
      } catch {
        /* not empty or already gone */
      }
    }
  }
}

/** Put the files' index entries back as they were (dropping entries an apply added). */
function restoreIndex(root: string, backup: FileBackup[]): void {
  const zero = '0'.repeat(git(root, ['rev-parse', 'HEAD']).out.trim().length || 40);
  const lines = backup.flatMap((b) => [`0 ${zero}\t${b.file}`, ...b.index]);
  if (lines.length) git(root, ['update-index', '-z', '--index-info'], `${lines.join('\0')}\0`);
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

/**
 * Remove copies that were applied or discarded more than 7 days ago, and waiting copies (pending or conflict) that
 * `isOrphan` says nothing refers to any more (their session or run is gone), with their records. Returns how many.
 * The caller decides what is orphaned, so this module stays free of sessions.
 */
export function cleanupStaleWorktrees(now = Date.now(), maxAgeMs = STALE_MS, isOrphan?: (rec: WorktreeRecord) => boolean): number {
  let n = 0;
  for (const rec of listCouncilWorktrees()) {
    const done = rec.status === 'applied' || rec.status === 'discarded';
    const stale = done && now - rec.updatedAt >= maxAgeMs;
    const orphan = !done && !!isOrphan?.(rec);
    if (!stale && !orphan) continue;
    const r = discardWorktree(rec.projectDir, rec);
    if (!r.ok && isOurs(rec)) continue;
    fs.rmSync(metaFile(rec), { force: true });
    n++;
  }
  return n;
}
