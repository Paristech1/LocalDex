import { MEMBER_IDS, type MemberId, type MemberStatus } from '@localdex/shared';
import { bus } from '../agent/bus.js';
import { claudeMember } from './members/claude.js';
import { codexMember } from './members/codex.js';
import { cursorMember } from './members/cursor.js';
import { geminiMember } from './members/gemini.js';
import type { MemberAdapter } from './types.js';

export const MEMBERS: Record<MemberId, MemberAdapter> = {
  claude: claudeMember,
  codex: codexMember,
  gemini: geminiMember,
  cursor: cursorMember,
};

const STATUS_TTL_MS = 5 * 60_000;
/** Cooldown when a vendor says "limit reached" but not when it resets. */
const DEFAULT_COOLDOWN_MS = 15 * 60_000;

const cache = new Map<MemberId, MemberStatus>();
const limits = new Map<MemberId, { until: number; message: string }>();
const lastErrors = new Map<MemberId, string>();
let refreshing: Promise<MemberStatus[]> | null = null;

function decorate(s: Omit<MemberStatus, 'limitedUntil' | 'lastError' | 'checkedAt'> & { lastError?: string }, checkedAt: number): MemberStatus {
  const lim = limits.get(s.id);
  const limitedUntil = lim && lim.until > Date.now() ? lim.until : undefined;
  return { ...s, limitedUntil, lastError: lim && limitedUntil ? lim.message : (lastErrors.get(s.id) ?? s.lastError), checkedAt };
}

/** Status for every member, using the cache unless `force` or stale. Broadcasts to the UI. */
export async function memberStatuses(force = false): Promise<MemberStatus[]> {
  const now = Date.now();
  const stale = MEMBER_IDS.some((id) => {
    const c = cache.get(id);
    return !c || now - c.checkedAt > STATUS_TTL_MS;
  });
  if (!force && !stale) return MEMBER_IDS.map((id) => decorate(cache.get(id)!, cache.get(id)!.checkedAt));
  if (!refreshing) {
    refreshing = (async () => {
      const results = await Promise.all(
        MEMBER_IDS.map(async (id) => {
          try {
            return decorate(await MEMBERS[id].status(), Date.now());
          } catch (e) {
            return decorate(
              { id, label: MEMBERS[id].label, installed: false, signedIn: false, billing: 'unknown', loginCommand: '', canLoginInApp: false, lastError: (e as Error).message },
              Date.now(),
            );
          }
        }),
      );
      for (const r of results) cache.set(r.id, r);
      bus.emit({ type: 'council_status', members: results });
      return results;
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

export async function memberStatus(id: MemberId): Promise<MemberStatus> {
  return (await memberStatuses()).find((s) => s.id === id)!;
}

export function isLimited(id: MemberId): boolean {
  const l = limits.get(id);
  return !!l && l.until > Date.now();
}

export function markLimited(id: MemberId, message: string, resetsAt?: number): void {
  const until = resetsAt && resetsAt > Date.now() ? resetsAt : Date.now() + DEFAULT_COOLDOWN_MS;
  limits.set(id, { until, message });
  bus.log('warn', `[council] ${MEMBERS[id].label} hit a usage limit; skipping it until ${new Date(until).toLocaleTimeString()}. (${message.slice(0, 160)})`);
  broadcastCached();
}

export function noteError(id: MemberId, message: string | undefined): void {
  if (message) lastErrors.set(id, message.slice(0, 400));
  else lastErrors.delete(id);
  broadcastCached();
}

export function clearLimit(id: MemberId): void {
  limits.delete(id);
  broadcastCached();
}

function broadcastCached(): void {
  const list = MEMBER_IDS.map((id) => cache.get(id)).filter((x): x is MemberStatus => !!x);
  if (list.length === MEMBER_IDS.length) bus.emit({ type: 'council_status', members: list.map((s) => decorate(s, s.checkedAt)) });
}

export function cachedStatuses(): MemberStatus[] {
  return MEMBER_IDS.map((id) => cache.get(id)).filter((x): x is MemberStatus => !!x).map((s) => decorate(s, s.checkedAt));
}
