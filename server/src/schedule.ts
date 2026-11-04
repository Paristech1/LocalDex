// E5: scheduled goal runs ("run this goal daily at 07:30 in this folder"). Runs only while LocalDex is running;
// a time missed while it was off is not made up later. Each run is a new session with a Goal, under the same
// approval rules as any run (a prompt waits for you). Kept in <DATA_DIR>/schedules.json.
// Pattern from DeepSeek Harness schedule/schedule (scheduled instructions delivered to new conversations), reimplemented.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ScheduledGoal } from '@localdex/shared';
import { DATA_DIR, getSettings } from './config.js';
import { bus } from './agent/bus.js';

const file = () => path.join(DATA_DIR, 'schedules.json');
let cache: ScheduledGoal[] | null = null;

export function listSchedules(): ScheduledGoal[] {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = Array.isArray(raw) ? (raw as ScheduledGoal[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function save(list: ScheduledGoal[]): void {
  cache = list;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(list, null, 2));
  bus.emit({ type: 'schedules', schedules: list });
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Validate and store a schedule (new when id is missing). Returns an error message or the saved schedule. */
export function saveSchedule(input: Partial<ScheduledGoal>): ScheduledGoal | string {
  const brief = String(input.brief ?? '').trim();
  if (!brief) return 'Say what the goal is.';
  if (!TIME_RE.test(String(input.time ?? ''))) return 'Time must be HH:MM (24-hour).';
  const days = Array.isArray(input.days) ? [...new Set(input.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [0, 1, 2, 3, 4, 5, 6];
  if (!days.length) return 'Pick at least one day.';
  const approved = getSettings().approvedFolders.map((f) => path.resolve(f));
  const folder = path.resolve(String(input.folder ?? approved[0] ?? ''));
  if (!approved.includes(folder)) return 'The folder must be one of your approved folders (Settings → Workspace).';
  const list = [...listSchedules()];
  const existing = input.id ? list.find((s) => s.id === input.id) : undefined;
  const sched: ScheduledGoal = {
    id: existing?.id ?? randomUUID().slice(0, 8),
    brief: brief.slice(0, 2000),
    doneCriteria: String(input.doneCriteria ?? '').trim().slice(0, 1000),
    folder,
    time: String(input.time),
    days,
    maxIterations: Math.min(50, Math.max(1, Number(input.maxIterations) || 10)),
    lead: input.lead === 'council' ? 'council' : 'local',
    enabled: input.enabled !== false,
    ...(existing ? { lastRunAt: existing.lastRunAt, lastSessionId: existing.lastSessionId } : {}),
  };
  if (existing) list[list.indexOf(existing)] = sched;
  else list.push(sched);
  save(list);
  return sched;
}

export function deleteSchedule(id: string): boolean {
  const list = listSchedules();
  if (!list.some((s) => s.id === id)) return false;
  save(list.filter((s) => s.id !== id));
  return true;
}

/** The start of the minute slot `s` is due in at `now`, or null. A slot runs once (lastRunAt guards it). */
export function dueSlot(s: ScheduledGoal, now: Date): number | null {
  if (!s.enabled || !s.days.includes(now.getDay())) return null;
  const [h, m] = s.time.split(':').map(Number);
  const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0).getTime();
  // Due during the scheduled minute and the 10 minutes after it (covers a sleeping laptop or a busy tick).
  if (now.getTime() < slot || now.getTime() > slot + 10 * 60_000) return null;
  if ((s.lastRunAt ?? 0) >= slot) return null;
  return slot;
}

type Starter = (s: ScheduledGoal) => Promise<string>;

/** Start every schedule that is due. `start` creates the session and the goal; returns how many started. */
export async function tickSchedules(now: Date, start: Starter): Promise<number> {
  let n = 0;
  for (const s of listSchedules()) {
    const slot = dueSlot(s, now);
    if (slot === null) continue;
    s.lastRunAt = now.getTime();
    try {
      s.lastSessionId = await start(s);
      bus.log('info', `[schedule] started "${s.brief.slice(0, 60)}" (${s.time}) in ${s.folder}`);
      n++;
    } catch (e) {
      bus.log('error', `[schedule] could not start "${s.brief.slice(0, 60)}": ${(e as Error).message}`);
    }
    save(listSchedules());
  }
  return n;
}

let timer: NodeJS.Timeout | null = null;

/** Check every 30 seconds while LocalDex runs. */
export function startScheduler(start: Starter): void {
  if (timer) return;
  timer = setInterval(() => void tickSchedules(new Date(), start), 30_000);
  timer.unref?.();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** The goal brief for a scheduled run: names the folder, since the default working directory is the first approved one. */
export function scheduledBrief(s: ScheduledGoal): string {
  const first = path.resolve(getSettings().approvedFolders[0] ?? '');
  return `${s.brief}${s.folder !== first ? `\n\nWork in ${s.folder} (use it as your working directory).` : ''}\n\n(Scheduled run: ${s.time}. Nobody may be watching: if something needs approval, it will wait for the user.)`;
}
