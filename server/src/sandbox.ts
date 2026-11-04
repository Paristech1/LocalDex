// Shell sandbox (S3): confine shell_run, background jobs and terminals to the approved folders.
// Pattern from DeepSeek Harness packages/sandbox/sandbox-local/src/profiles.ts (MIT): macOS Seatbelt
// (allow-default, deny file-write*, allow-list of writable roots) and Linux bubblewrap (read-only host root,
// private /tmp, writable binds). Fails closed: a preset that needs a sandbox never silently runs without one.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PermissionPreset, SandboxStatus } from '@localdex/shared';
import { expandHome, getSettings } from './config.js';
import { approvedFolders } from './tools/permissions.js';

export type SandboxMode = 'read-only' | 'workspace-write';

export const PRESET_LABEL: Record<PermissionPreset, string> = {
  full: 'Full access',
  workspace: 'Workspace (sandboxed)',
  'read-only': 'Read only',
};

/** Tool caches that builds and package managers write to. Writable in both sandboxed modes; they are not the user's files. */
const CACHE_DIRS = ['~/.npm', '~/.cache', '~/Library/Caches', '~/.pnpm-store', '~/.local/share/pnpm', '~/.yarn', '~/.bun', '~/.cargo/registry', '~/go/pkg', '~/.gradle', '~/.m2'];

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

let cached: SandboxStatus | null = null;

/** Which sandbox this machine can run, probed once. `LOCALDEX_SANDBOX=none` forces "unavailable" (debugging, tests). */
export function sandboxStatus(): SandboxStatus {
  if (cached) return cached;
  cached = probe();
  return cached;
}

/** Forget the probe result (tests; or after the user installs bubblewrap). */
export function resetSandboxCache(): void {
  cached = null;
}

function probe(): SandboxStatus {
  if (process.env.LOCALDEX_SANDBOX === 'none') return { available: false, kind: null, reason: 'disabled by LOCALDEX_SANDBOX=none' };
  if (process.platform === 'darwin') {
    if (!fs.existsSync('/usr/bin/sandbox-exec')) return { available: false, kind: null, reason: '/usr/bin/sandbox-exec not found' };
    try {
      execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)', '/usr/bin/true'], { timeout: 5000, stdio: 'ignore' });
      return { available: true, kind: 'seatbelt' };
    } catch (e) {
      return { available: false, kind: null, reason: `sandbox-exec failed: ${(e as Error).message}` };
    }
  }
  if (process.platform === 'linux') {
    const bwrap = findOnPath('bwrap');
    if (!bwrap) return { available: false, kind: null, reason: 'bubblewrap (bwrap) is not installed — e.g. `sudo apt install bubblewrap`' };
    try {
      execFileSync(bwrap, [...bwrapProfileArgs('read-only', []), '--', '/bin/true'], { timeout: 5000, stdio: 'ignore' });
      return { available: true, kind: 'bwrap', path: bwrap };
    } catch (e) {
      return { available: false, kind: null, reason: `bwrap could not start (user namespaces may be disabled): ${(e as Error).message.split('\n')[0]}` };
    }
  }
  return { available: false, kind: null, reason: `no sandbox backend for ${process.platform}` };
}

function findOnPath(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/** The sandbox mode the current permission preset asks for, or null for Full access. */
export function currentMode(): SandboxMode | null {
  const preset = getSettings().permissionPreset ?? 'full';
  if (preset === 'workspace') return 'workspace-write';
  if (preset === 'read-only') return 'read-only';
  return null;
}

function canonical(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** Temp areas every sandboxed command may write (macOS: /private/tmp and the per-user /private/var/folders). */
function tempRoots(): string[] {
  const out = [os.tmpdir(), '/tmp'];
  if (process.platform === 'darwin') out.push('/private/var/folders');
  return out;
}

/**
 * Writable roots for a mode, canonicalized (Seatbelt matches resolved paths: /tmp IS /private/tmp) and deduplicated.
 * Only paths that exist are returned (bwrap cannot bind a missing path). Read-only never includes the approved folders.
 */
export function writableRoots(mode: SandboxMode): string[] {
  const s = getSettings();
  const wanted = [
    ...(mode === 'workspace-write' ? approvedFolders() : []),
    ...CACHE_DIRS.map(expandHome),
    ...(mode === 'workspace-write' ? (s.sandboxExtraWritable ?? []).map(expandHome) : []),
  ];
  if (process.platform === 'darwin') wanted.push(...tempRoots());
  const out = new Set<string>();
  for (const w of wanted) {
    const c = canonical(path.resolve(w));
    if (c) out.add(c);
  }
  return [...out];
}

function sbpl(p: string): string {
  return `"${p.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** sandbox-exec arguments (before the command argv). */
export function seatbeltProfileArgs(roots: string[], denyRoots: string[] = []): string[] {
  const forms = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (literal ${sbpl('/dev/null')}) (literal ${sbpl('/dev/tty')}) (subpath ${sbpl('/dev/fd')}))`,
  ];
  if (roots.length) forms.push(`(allow file-write* ${roots.map((r) => `(subpath ${sbpl(r)})`).join(' ')})`);
  // Read only: the approved folders stay unwritable even when they sit inside an allowed temp area (later rules win).
  if (denyRoots.length) forms.push(`(deny file-write* ${denyRoots.map((r) => `(subpath ${sbpl(r)})`).join(' ')})`);
  return ['-p', forms.join(' ')];
}

/**
 * bwrap arguments (before `--` and the command argv). Read-only host root, fresh /dev, private PID namespace,
 * a private /tmp in both modes (so writes there never reach the host's /tmp), then writable binds.
 */
export function bwrapProfileArgs(mode: SandboxMode, roots: string[], readOnlyFolders: string[] = [], aliases: Array<[real: string, asGiven: string]> = []): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--tmpfs', '/tmp'];
  // The private /tmp hides host paths under /tmp; put the approved folders back (read-only) so reads still work.
  if (mode === 'read-only') for (const f of readOnlyFolders) args.push('--ro-bind', f, f);
  for (const r of roots) args.push('--bind', r, r);
  // An approved folder reached through a symlink (e.g. under /tmp, which is private here) is also mounted at the path as given.
  for (const [real, given] of aliases) args.push(mode === 'read-only' ? '--ro-bind' : '--bind', real, given);
  return args;
}

/**
 * Wrap `file args…` for the current preset. Returns the argv unchanged under Full access.
 * Throws SandboxUnavailableError (fail closed) when the preset needs a sandbox this machine doesn't have.
 */
export function wrapCommand(file: string, args: string[], modeOverride?: SandboxMode | null): { file: string; args: string[]; sandboxed: boolean } {
  const mode = modeOverride === undefined ? currentMode() : modeOverride;
  if (!mode) return { file, args, sandboxed: false };
  const st = sandboxStatus();
  if (!st.available) {
    const preset = getSettings().permissionPreset ?? 'full';
    throw new SandboxUnavailableError(
      `The "${PRESET_LABEL[preset]}" permission preset needs a sandbox, and none is available on this machine (${st.reason}). ` +
        'Nothing was run. Ask the user to switch Settings → Workspace → Permissions to "Full access", or to install bubblewrap (Linux).',
    );
  }
  const roots = writableRoots(mode);
  const raw = approvedFolders();
  const folders = raw.map((f) => canonical(f)).filter((f): f is string => !!f);
  const aliases = raw.map((f) => [canonical(f), f] as const).filter((x): x is readonly [string, string] => !!x[0] && x[0] !== x[1]).map(([r, g]) => [r, g] as [string, string]);
  if (st.kind === 'seatbelt') return { file: '/usr/bin/sandbox-exec', args: [...seatbeltProfileArgs(roots, mode === 'read-only' ? folders : []), file, ...args], sandboxed: true };
  return { file: st.path ?? 'bwrap', args: [...bwrapProfileArgs(mode, roots, folders, aliases), '--', file, ...args], sandboxed: true };
}

/** A sandboxed command that failed because the sandbox blocked a write (macOS: EPERM; bwrap: read-only file system). */
export function looksSandboxDenied(output: string, code: number | null): boolean {
  if (code === 0) return false;
  return /Operation not permitted|Read-only file system|deny\(\d+\) file-write/i.test(output);
}

/** Text for the one-shot escalation prompt. */
export function escalationPrompt(command: string): string {
  return `The sandbox blocked this command (it tried to write outside your approved folders). Run it once with full access?\n\n$ ${command}`;
}
