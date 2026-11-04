import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Session, TurnCheckpoint, TurnFile } from '@localdex/shared';
import { DATA_DIR } from './config.js';
import { insideApproved, approvedFolders, realpathSafe } from './tools/permissions.js';
import { bus } from './agent/bus.js';

/**
 * Per-turn checkpoints for Solo edits (pattern borrowed from DeepSeek Harness `deliverables/workspace-changes`,
 * reimplemented): at turn start and end the first approved folder is snapshotted with `git write-tree` through a
 * temporary index (the user's own index is never touched), and every file the file tools are about to change is
 * copied first, which also covers files git doesn't see (not a repo, ignored). At turn end the before/after contents
 * of every changed file are stored under ~/.localdex/checkpoints/<session>/<turn>/ so **Undo this turn** and the diff
 * viewer never depend on the repo keeping unreachable objects. The last KEEP_TURNS turns per session are kept.
 */
export const CHECKPOINT_DIR = path.join(DATA_DIR, 'checkpoints');
export const KEEP_TURNS = 20;
/** Files bigger than this are not copied (the turn still lists them; undo refuses them). */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

interface TurnState {
  id: string;
  dir: string;
  folder: string;
  startedAt: number;
  treeStart: string | null;
  /** abs path → name of the before-copy under dir/before, or null when the file did not exist. */
  before: Map<string, string | null>;
}

interface Meta extends TurnCheckpoint {
  /** Per file: name of the before/after copies and the sha1 of the after copy (undo checks the file is still that). */
  entries: Array<{ rel: string; abs: string; beforeName: string | null; afterName: string | null; afterSha1: string | null }>;
}

const active = new Map<string, TurnState>();

const sessionDir = (sessionId: string) => path.join(CHECKPOINT_DIR, safe(sessionId));
const turnDir = (sessionId: string, turnId: string) => path.join(sessionDir(sessionId), safe(turnId));

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || '_';
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env },
  });
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim() || (r.error?.message ?? '') };
}

function gitBuffer(cwd: string, args: string[]): Buffer | null {
  const r = spawnSync('git', ['-C', cwd, ...args], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return r.status === 0 ? (r.stdout as Buffer) : null;
}

/** The repo root when `dir` is inside a git repository with at least one commit; the snapshot is of that root. */
function repoRoot(dir: string): string | null {
  const root = git(dir, ['rev-parse', '--show-toplevel']);
  if (!root.ok) return null;
  return root.out.trim();
}

/** Tree id of the working tree right now, through a temporary index. Null when not a repo or git failed. */
function writeTree(root: string): string | null {
  const idx = path.join(os.tmpdir(), `localdex-idx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    const env = { GIT_INDEX_FILE: idx };
    const add = git(root, ['add', '-A', '--', '.'], env);
    if (!add.ok) return null;
    const tree = git(root, ['write-tree'], env);
    return tree.ok ? tree.out.trim() : null;
  } finally {
    fs.rmSync(idx, { force: true });
    fs.rmSync(`${idx}.lock`, { force: true });
  }
}

const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex');

/** Start of a Solo turn: snapshot the folder and open the turn's checkpoint directory. */
export function beginTurn(sessionId: string): TurnCheckpoint | null {
  const folder = approvedFolders()[0];
  if (!folder) return null;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = turnDir(sessionId, id);
  try {
    fs.mkdirSync(path.join(dir, 'before'), { recursive: true });
  } catch (e) {
    bus.log('warn', `[checkpoint] could not create ${dir}: ${(e as Error).message}`);
    return null;
  }
  const root = repoRoot(folder);
  const treeStart = root ? writeTree(root) : null;
  // Canonical folder, so paths from git and from the file tools are relative to the same spelling.
  const state: TurnState = { id, dir, folder: realpathSafe(root ?? folder), startedAt: Date.now(), treeStart, before: new Map() };
  active.set(sessionId, state);
  return { id, startedAt: state.startedAt, folder: state.folder, files: [] };
}

/**
 * A file tool is about to change `abs`: keep its current content once per turn (or note that it did not exist).
 * No-op when no turn is active for the session (e.g. council runs, which have their own copies).
 */
export function beforeEdit(sessionId: string, rawAbs: string): void {
  // Same spelling as git's paths (macOS: /var/folders IS /private/var/folders), so one file is never listed twice.
  const abs = realpathSafe(rawAbs);
  const t = active.get(sessionId);
  if (!t || t.before.has(abs)) return;
  try {
    if (!fs.existsSync(abs)) {
      t.before.set(abs, null);
      return;
    }
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return;
    const name = `${t.before.size}-${safe(path.basename(abs))}`;
    fs.copyFileSync(abs, path.join(t.dir, 'before', name));
    t.before.set(abs, name);
  } catch (e) {
    bus.log('warn', `[checkpoint] could not copy ${abs}: ${(e as Error).message}`);
  }
}

interface Change {
  abs: string;
  before: Buffer | null;
  after: Buffer | null;
}

/** What changed between two versions, in `git diff --numstat` terms (binary or no git: whole-file counts). */
function lineCounts(before: Buffer | null, after: Buffer | null): { added: number; removed: number } {
  const lines = (b: Buffer | null) => (b && b.length ? b.toString('utf8').replace(/\n$/, '').split('\n').length : 0);
  if (!before || !after) return { added: lines(after), removed: lines(before) };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localdex-diff-'));
  try {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    fs.writeFileSync(a, before);
    fs.writeFileSync(b, after);
    const r = git(tmp, ['diff', '--no-index', '--numstat', '--', 'a', 'b']);
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(r.out);
    if (m) return { added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]) };
    return { added: lines(after), removed: lines(before) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * End of the turn: work out what changed (git tree diff for the folder, before-copies for everything the file tools
 * touched), store before/after contents, and return the checkpoint (null when nothing changed). Older turns beyond
 * KEEP_TURNS are removed from disk and from `session.turns`.
 */
export function endTurn(session: Session): TurnCheckpoint | null {
  const t = active.get(session.id);
  if (!t) return null;
  active.delete(session.id);
  const changes = new Map<string, Change>();
  const read = (abs: string): Buffer | null => {
    try {
      const st = fs.statSync(abs);
      return st.isFile() && st.size <= MAX_FILE_BYTES ? fs.readFileSync(abs) : null;
    } catch {
      return null;
    }
  };

  try {
    // 1. Everything git saw change in the folder (covers shell edits too). Only when both snapshots worked.
    if (t.treeStart) {
      const treeEnd = writeTree(t.folder);
      if (treeEnd && treeEnd !== t.treeStart) {
        const list = git(t.folder, ['diff-tree', '-r', '-z', '--name-status', '--no-renames', t.treeStart, treeEnd]).out.split('\0');
        for (let i = 0; i + 1 < list.length; i += 2) {
          const status = list[i];
          const rel = list[i + 1];
          if (!rel) continue;
          const abs = path.join(t.folder, rel);
          const before = status === 'A' ? null : gitBuffer(t.folder, ['cat-file', 'blob', `${t.treeStart}:${rel}`]);
          const after = status === 'D' ? null : read(abs);
          changes.set(abs, { abs, before, after });
        }
      }
    }
    // 2. Files the file tools touched (not a repo, ignored files, other approved folders).
    for (const [abs, name] of t.before) {
      if (changes.has(abs)) continue;
      const before = name ? read(path.join(t.dir, 'before', name)) : null;
      const after = read(abs);
      const same = (before === null && after === null) || (before !== null && after !== null && before.equals(after));
      if (!same) changes.set(abs, { abs, before, after });
    }

    if (!changes.size) {
      fs.rmSync(t.dir, { recursive: true, force: true });
      return null;
    }

    // 3. Store before/after and the summary.
    fs.mkdirSync(path.join(t.dir, 'after'), { recursive: true });
    const files: TurnFile[] = [];
    const entries: Meta['entries'] = [];
    let n = 0;
    for (const c of [...changes.values()].sort((a, b) => a.abs.localeCompare(b.abs))) {
      const rel = path.relative(t.folder, c.abs).startsWith('..') ? c.abs : path.relative(t.folder, c.abs);
      const base = `${n++}-${safe(path.basename(c.abs))}`;
      let beforeName: string | null = null;
      let afterName: string | null = null;
      if (c.before) {
        beforeName = base;
        fs.writeFileSync(path.join(t.dir, 'before', base), c.before);
      }
      if (c.after) {
        afterName = base;
        fs.writeFileSync(path.join(t.dir, 'after', base), c.after);
      }
      const { added, removed } = lineCounts(c.before, c.after);
      files.push({ path: c.abs, rel, kind: !c.before ? 'added' : !c.after ? 'deleted' : 'modified', added, removed });
      entries.push({ rel, abs: c.abs, beforeName, afterName, afterSha1: c.after ? sha1(c.after) : null });
    }
    const cp: TurnCheckpoint = { id: t.id, startedAt: t.startedAt, endedAt: Date.now(), folder: t.folder, files };
    const meta: Meta = { ...cp, entries };
    fs.writeFileSync(path.join(t.dir, 'meta.json'), JSON.stringify(meta, null, 2));
    // Before-copies of files that turned out unchanged are no longer needed.
    for (const f of fs.readdirSync(path.join(t.dir, 'before'))) if (!entries.some((e) => e.beforeName === f)) fs.rmSync(path.join(t.dir, 'before', f), { force: true });

    const turns = (session.turns ??= []);
    turns.push(cp);
    while (turns.length > KEEP_TURNS) {
      const old = turns.shift()!;
      fs.rmSync(turnDir(session.id, old.id), { recursive: true, force: true });
    }
    return cp;
  } catch (e) {
    bus.log('warn', `[checkpoint] ${(e as Error).message}`);
    return null;
  }
}

function loadMeta(sessionId: string, turnId: string): Meta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(turnDir(sessionId, turnId), 'meta.json'), 'utf8')) as Meta;
  } catch {
    return null;
  }
}

/**
 * Put every file of the turn back to its turn-start content. All-or-nothing: if any listed file is not exactly as
 * the turn left it (you or a later turn changed it), nothing is touched and the reason is returned.
 */
export function undoTurn(session: Session, turnId: string): { ok: boolean; error?: string } {
  const cp = session.turns?.find((x) => x.id === turnId);
  if (!cp) return { ok: false, error: 'That turn is no longer kept.' };
  if (cp.undone) return { ok: false, error: 'This turn was already undone.' };
  if (active.has(session.id)) return { ok: false, error: 'Wait for the current run to finish first.' };
  const meta = loadMeta(session.id, turnId);
  if (!meta) return { ok: false, error: 'The checkpoint files for this turn are missing.' };
  const dir = turnDir(session.id, turnId);
  const folders = approvedFolders();
  for (const e of meta.entries) {
    if (!folders.length || !insideApproved(e.abs)) return { ok: false, error: `${e.rel} is no longer inside an approved folder.` };
    const exists = fs.existsSync(e.abs);
    if (e.afterSha1 === null) {
      if (exists) return { ok: false, error: `${e.rel} was created again after this turn deleted it; undo refused, nothing was changed.` };
      continue;
    }
    if (!exists) return { ok: false, error: `${e.rel} was removed after this turn; undo refused, nothing was changed.` };
    const now = sha1(fs.readFileSync(e.abs));
    if (now !== e.afterSha1) return { ok: false, error: `${e.rel} changed after this turn ended; undo refused, nothing was changed. Undo later turns first, or revert it yourself.` };
  }
  for (const e of meta.entries) {
    if (e.beforeName) {
      fs.mkdirSync(path.dirname(e.abs), { recursive: true });
      fs.copyFileSync(path.join(dir, 'before', e.beforeName), e.abs);
    } else {
      fs.rmSync(e.abs, { force: true });
    }
  }
  cp.undone = true;
  cp.undoneAt = Date.now();
  bus.log('info', `[checkpoint] undid turn ${turnId}: ${meta.entries.length} file(s) restored`);
  return { ok: true };
}

/** Unified diff of the turn (all files, or one), from the stored before/after copies. */
export function turnDiff(sessionId: string, turnId: string, rel?: string): string {
  const meta = loadMeta(sessionId, turnId);
  if (!meta) return '(checkpoint files missing)';
  const dir = turnDir(sessionId, turnId);
  const out: string[] = [];
  for (const e of meta.entries) {
    if (rel && e.rel !== rel) continue;
    const a = e.beforeName ? path.join(dir, 'before', e.beforeName) : '/dev/null';
    const b = e.afterName ? path.join(dir, 'after', e.afterName) : '/dev/null';
    const r = git(dir, ['diff', '--no-index', '--no-color', '--', a, b]);
    // Replace the temp paths in the header with the project-relative ones.
    const text = r.out
      .split('\n')
      .map((l) => (l.startsWith('diff --git') ? `diff --git a/${e.rel} b/${e.rel}` : l.startsWith('--- ') && !l.startsWith('--- /dev/null') ? `--- a/${e.rel}` : l.startsWith('+++ ') && !l.startsWith('+++ /dev/null') ? `+++ b/${e.rel}` : l))
      .join('\n');
    out.push(text.trim() ? text : `${e.rel}: ${e.beforeName && e.afterName ? 'binary or identical' : e.afterName ? 'added' : 'deleted'}`);
  }
  return out.join('\n').slice(0, 400_000);
}

/** A session is being deleted: its checkpoints go with it. */
export function deleteCheckpoints(sessionId: string): void {
  active.delete(sessionId);
  fs.rmSync(sessionDir(sessionId), { recursive: true, force: true });
}

/** Test/diagnostic hook: is a turn open for this session? */
export function turnActive(sessionId: string): boolean {
  return active.has(sessionId);
}
