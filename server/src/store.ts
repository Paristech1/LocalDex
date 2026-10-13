import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Session, SessionSummary } from '@localdex/shared';
import { SESSIONS_DIR } from './config.js';
import { recoverInterruptedRuns } from './council/recover.js';

const cache = new Map<string, Session>();
const timers = new Map<string, NodeJS.Timeout>();

function file(id: string): string {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

export function createSession(model: string | null): Session {
  const now = Date.now();
  const s: Session = {
    id: randomUUID().slice(0, 8),
    title: 'New session',
    createdAt: now,
    updatedAt: now,
    model,
    messages: [],
    archive: [],
    workers: {},
    plan: [],
    goal: null,
    usage: { promptTokens: 0, completionTokens: 0, lastPromptTokens: 0 },
    compactions: 0,
    compactSummary: null,
  };
  cache.set(s.id, s);
  saveNow(s);
  return s;
}

export function getSession(id: string): Session | null {
  const hit = cache.get(id);
  if (hit) return hit;
  try {
    const s = JSON.parse(fs.readFileSync(file(id), 'utf8')) as Session;
    // Reset transient worker status on load.
    for (const w of Object.values(s.workers ?? {})) w.status = 'idle';
    // Council runs left "running" by a server that stopped mid-run are cancelled, so their changes can be applied or discarded.
    if (recoverInterruptedRuns(s)) saveNow(s);
    cache.set(id, s);
    return s;
  } catch {
    return null;
  }
}

export function listSessions(): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    const s = getSession(id);
    if (s) out.push({ id: s.id, title: s.title, updatedAt: s.updatedAt, messageCount: s.messages.length });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteSession(id: string): void {
  cache.delete(id);
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  try {
    fs.unlinkSync(file(id));
  } catch {
    /* ignore */
  }
}

/** Debounced save. */
export function saveSession(s: Session): void {
  s.updatedAt = Date.now();
  const existing = timers.get(s.id);
  if (existing) clearTimeout(existing);
  timers.set(
    s.id,
    setTimeout(() => {
      timers.delete(s.id);
      saveNow(s);
    }, 300),
  );
}

export function saveNow(s: Session): void {
  const tmp = file(s.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, file(s.id));
}

export function flushAll(): void {
  for (const [id, t] of timers) {
    clearTimeout(t);
    const s = cache.get(id);
    if (s) saveNow(s);
  }
  timers.clear();
}
