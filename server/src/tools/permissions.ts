import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { expandHome, getSettings } from '../config.js';

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

const DENY_PATTERNS = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.config\/gcloud(\/|$)/,
  /(^|\/)\.localdex(\/|$)/,
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/,
  /(^|\/)Library\/Keychains(\/|$)/,
];

/** Resolve a user-supplied path against the first approved folder and verify it is allowed. */
export function resolvePath(p: string, opts: { allowDenied?: boolean } = {}): string {
  const folders = approvedFolders();
  if (folders.length === 0) {
    throw new PermissionError(
      'No approved folders. Ask the user to add one in Settings → Workspace before touching files.',
    );
  }
  const expanded = expandHome(p);
  const abs = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(folders[0], expanded);
  const real = realpathSafe(abs);

  const inside = folders.some((f) => isInside(real, f) || isInside(abs, f));
  if (!inside) {
    throw new PermissionError(
      `Path "${abs}" is outside the approved folders (${folders.join(', ')}). Ask the user to approve it.`,
    );
  }
  if (!opts.allowDenied && DENY_PATTERNS.some((re) => re.test(real) || re.test(abs))) {
    throw new PermissionError(`Path "${abs}" matches a protected pattern and cannot be accessed.`);
  }
  return abs;
}

export function approvedFolders(): string[] {
  return getSettings().approvedFolders.map((f) => path.resolve(expandHome(f)));
}

export function defaultCwd(): string {
  return approvedFolders()[0] ?? os.homedir();
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    // For not-yet-existing files, realpath the nearest existing parent.
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(realpathSafe(parent), path.basename(p));
  }
}

// ---------- Shell command risk classification ----------

const DANGEROUS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/,
  /\brm\s+-rf?\s+[~/]/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bchmod\s+-R\s+777\b/,
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+-[a-z]*f/,
  />\s*\/dev\/sd/,
  /\bshutdown\b|\breboot\b/,
  /\bkill\s+-9\s+-1\b/,
  /\bcurl\b[^|]*\|\s*(ba|z)?sh\b/,
  /\bnpm\s+publish\b/,
  /\bdocker\s+(system\s+prune|rm\s+-f)/,
];

export function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS.some((re) => re.test(cmd));
}

export function shellNeedsApproval(cmd: string): boolean {
  const mode = getSettings().shellApproval;
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  return isDangerousCommand(cmd);
}
