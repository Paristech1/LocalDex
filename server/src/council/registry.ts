import { MEMBER_IDS, type MemberCheck, type MemberId, type MemberStatus } from '@localdex/shared';
import { bus } from '../agent/bus.js';
import { claudeMember } from './members/claude.js';
import { codexMember } from './members/codex.js';
import { cursorMember } from './members/cursor.js';
import { geminiMember } from './members/gemini.js';
import type { MemberAdapter, MemberStatusBase } from './types.js';

export const MEMBERS: Record<MemberId, MemberAdapter> = {
  claude: claudeMember,
  codex: codexMember,
  gemini: geminiMember,
  cursor: cursorMember,
};

const STATUS_TTL_MS = 5 * 60_000;
/** Cooldown when a vendor says "limit reached" but not when it resets. */
const DEFAULT_COOLDOWN_MS = 15 * 60_000;

/** A model list can hang on the network; the health check gives up after this. */
const MODELS_TIMEOUT_MS = 10_000;

type ModelsEntry = { models: string[]; source: 'account' | 'suggested'; at: number; error?: string };

const cache = new Map<MemberId, MemberStatus>();
const limits = new Map<MemberId, { until: number; message: string }>();
const lastErrors = new Map<MemberId, string>();
const modelsCache = new Map<MemberId, ModelsEntry>();
const modelsInFlight = new Map<MemberId, Promise<void>>();
let healthCheckedAt: number | undefined;
let refreshing: Promise<MemberStatus[]> | null = null;
let refreshingDeep = false;

function decorate(full: MemberStatusBase, checkedAt: number): MemberStatus {
  // Models and checks are recomputed from the caches below, never carried over from an older status.
  const { models: _m, modelsSource: _ms, checks: _c, ...s } = full;
  const lim = limits.get(s.id);
  const limitedUntil = lim && lim.until > Date.now() ? lim.until : undefined;
  const m = modelsCache.get(s.id);
  const out: MemberStatus = {
    ...s,
    limitedUntil,
    lastError: lim && limitedUntil ? lim.message : (lastErrors.get(s.id) ?? s.lastError),
    checkedAt,
    healthCheckedAt,
  };
  if (m && m.models.length) {
    out.models = m.models;
    out.modelsSource = m.source;
  }
  out.checks = buildChecks(out, m);
  return out;
}

/** The health checklist shown in Settings → Council. Derived from the status, so it costs no extra calls. */
function buildChecks(s: MemberStatus, m: ModelsEntry | undefined): MemberCheck[] {
  const checks: MemberCheck[] = [
    { name: s.id === 'cursor' ? 'SDK found' : 'CLI found', ok: s.installed, detail: s.installed ? s.path : 'not installed' },
  ];
  if (s.installed) checks.push({ name: 'Version', ok: !!s.version, detail: s.version ?? 'could not read' });
  checks.push({ name: 'Signed in', ok: s.signedIn, detail: s.signedIn ? s.account : s.loginCommand });
  checks.push({
    name: 'Subscription billing',
    ok: s.signedIn && s.billing === 'plan',
    detail: !s.signedIn ? 'not signed in' : s.billing === 'plan' ? 'your subscription' : s.billing === 'api' ? 'API key' : 'could not tell',
  });
  if (m) {
    checks.push({
      name: 'Models listed',
      ok: !m.error && m.models.length > 0,
      detail: m.error ?? `${m.models.length} ${m.source === 'account' ? 'from your account' : 'suggested'}`,
    });
  }
  checks.push({
    name: 'Not cooling down',
    ok: !s.limitedUntil,
    detail: s.limitedUntil ? `usage limit until ${new Date(s.limitedUntil).toLocaleTimeString()}` : undefined,
  });
  return checks;
}

function withTimeout<T>(p: Promise<T>, ms: number, ac: AbortController): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new Error(`timed out after ${Math.round(ms / 1000)}s`));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Fetch one member's model list into the cache. Failures are recorded, never thrown. */
function refreshModels(s: MemberStatusBase): Promise<void> {
  const adapter = MEMBERS[s.id];
  if (!adapter.listModels || !s.installed) {
    modelsCache.delete(s.id);
    return Promise.resolve();
  }
  let p = modelsInFlight.get(s.id);
  if (!p) {
    const ac = new AbortController();
    p = withTimeout(adapter.listModels(s, ac.signal), MODELS_TIMEOUT_MS, ac)
      .then(
        (r) => void modelsCache.set(s.id, { models: Array.from(new Set(r.models)).slice(0, 200), source: r.source, at: Date.now() }),
        (e: unknown) => {
          // Keep the last good list so the model pickers still have something to offer.
          const prev = modelsCache.get(s.id);
          const error = `could not list models: ${(e as Error).message}`.slice(0, 200);
          modelsCache.set(s.id, { models: prev?.models ?? [], source: prev?.source ?? 'suggested', at: Date.now(), error });
        },
      )
      .finally(() => modelsInFlight.delete(s.id));
    modelsInFlight.set(s.id, p);
  }
  return p;
}

function modelsStale(id: MemberId): boolean {
  const m = modelsCache.get(id);
  return !m || Date.now() - m.at > STATUS_TTL_MS;
}

async function readStatus(id: MemberId): Promise<MemberStatusBase> {
  try {
    return await MEMBERS[id].status();
  } catch (e) {
    return { id, label: MEMBERS[id].label, installed: false, signedIn: false, billing: 'unknown', loginCommand: '', canLoginInApp: false, lastError: (e as Error).message };
  }
}

/**
 * Status for every member, using the cache unless `force` or stale. Broadcasts to the UI.
 * `deep` is the health check: it also waits (at most MODELS_TIMEOUT_MS) for each member's model list.
 * Otherwise stale model lists refresh in the background and arrive in a later broadcast.
 */
export async function memberStatuses(force = false, deep = false): Promise<MemberStatus[]> {
  const now = Date.now();
  const stale = MEMBER_IDS.some((id) => {
    const c = cache.get(id);
    return !c || now - c.checkedAt > STATUS_TTL_MS;
  });
  if (!force && !deep && !stale) return MEMBER_IDS.map((id) => decorate(cache.get(id)!, cache.get(id)!.checkedAt));
  // A plain refresh in flight does not answer a health check: let it finish, then run the deep one.
  if (refreshing && deep && !refreshingDeep) await refreshing.catch(() => undefined);
  if (!refreshing) {
    refreshingDeep = deep;
    refreshing = (async () => {
      const bases = await Promise.all(MEMBER_IDS.map(readStatus));
      if (deep) {
        await Promise.all(bases.map(refreshModels));
        healthCheckedAt = Date.now();
      } else {
        const todo = bases.filter((b) => modelsStale(b.id));
        if (todo.length) void Promise.all(todo.map(refreshModels)).then(broadcastCached);
      }
      const results = bases.map((b) => decorate(b, Date.now()));
      for (const r of results) cache.set(r.id, r);
      bus.emit({ type: 'council_status', members: results });
      return results;
    })().finally(() => {
      refreshing = null;
      refreshingDeep = false;
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
