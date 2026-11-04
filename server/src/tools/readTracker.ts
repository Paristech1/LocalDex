import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getSettings } from '../config.js';

/**
 * Read-before-edit (pattern borrowed from DeepSeek Harness `fs-observation-policy`, reimplemented): an agent may only
 * change a file it has read in its current context, and only if the file is still as it was then. Records are kept
 * per agent (main or worker) per session and dropped on Compact & Resume, since the read is no longer in the context.
 */
export interface FileFingerprint {
  mtimeMs: number;
  size: number;
  sha1: string;
}

/** `${sessionId}\0${agent}` → path → fingerprint at the last read (or write). */
const records = new Map<string, Map<string, FileFingerprint>>();

const key = (sessionId: string, agent: string) => `${sessionId}\0${agent}`;

export async function fingerprint(abs: string): Promise<FileFingerprint | null> {
  try {
    const [stat, data] = await Promise.all([fs.stat(abs), fs.readFile(abs)]);
    return { mtimeMs: stat.mtimeMs, size: stat.size, sha1: createHash('sha1').update(data).digest('hex') };
  } catch {
    return null;
  }
}

/** The agent read (or just wrote) this file: later edits may proceed while it stays like this. */
export function recordRead(sessionId: string, agent: string, abs: string, fp: FileFingerprint | null): void {
  const k = key(sessionId, agent);
  let m = records.get(k);
  if (!m) records.set(k, (m = new Map()));
  // A read of a missing path counts too: the agent is allowed to create it.
  m.set(abs, fp ?? { mtimeMs: 0, size: -1, sha1: '' });
}

export function readBeforeEditEnabled(): boolean {
  return getSettings().requireReadBeforeEdit !== false;
}

/**
 * Why this agent may not change the file now, or null when it may. Missing files are always fine (creating is not
 * overwriting). The wording is deliberately plain: small models act on it literally.
 */
export async function editRefusal(sessionId: string, agent: string, abs: string): Promise<string | null> {
  if (!readBeforeEditEnabled()) return null;
  const now = await fingerprint(abs);
  if (!now) return null;
  const rec = records.get(key(sessionId, agent))?.get(abs);
  if (!rec) return `cannot modify "${abs}": file has not been read — read the file, then retry`;
  if (rec.sha1 !== now.sha1) return `cannot modify "${abs}": file changed since it was read — re-read the file, then retry`;
  return null;
}

/** Compact & Resume: the reads are gone from the context, so the records go too. */
export function resetReads(sessionId: string, agent?: string): void {
  if (agent) {
    records.delete(key(sessionId, agent));
    return;
  }
  for (const k of records.keys()) if (k.startsWith(`${sessionId}\0`)) records.delete(k);
}
