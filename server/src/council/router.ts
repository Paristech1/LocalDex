import type { CouncilMemberRef, CouncilPattern, CouncilRole, CouncilSettings, MemberId, MemberStatus } from '@localdex/shared';
import { MEMBER_IDS } from '@localdex/shared';
import { getSettings } from '../config.js';
import { streamChat } from '../lmstudio.js';
import { isLimited } from './registry.js';

export interface Route {
  pattern: CouncilPattern;
  /** Role for 'single'. */
  role: CouncilRole;
  /** Forced member for 'single' (from /ask <member>). */
  member?: CouncilMemberRef;
  task: string;
  note: string;
}

const MEMBER_ALIASES: Record<string, CouncilMemberRef> = {
  claude: 'claude', anthropic: 'claude', opus: 'claude', sonnet: 'claude',
  codex: 'codex', openai: 'codex', gpt: 'codex', chatgpt: 'codex',
  gemini: 'gemini', google: 'gemini',
  cursor: 'cursor', composer: 'cursor',
  local: 'local', lmstudio: 'local',
};

/** Slash commands in Council mode. Returns null for a plain message. */
export function parseCommand(text: string): Route | null {
  const m = text.trim().match(/^\/(\w+)\s*([\s\S]*)$/);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  let rest = m[2].trim();
  switch (cmd) {
    case 'ask': {
      const who = rest.match(/^(\w+)\s+([\s\S]+)$/);
      if (who && MEMBER_ALIASES[who[1].toLowerCase()]) {
        return { pattern: 'single', role: 'builder', member: MEMBER_ALIASES[who[1].toLowerCase()], task: who[2].trim(), note: `/ask → ${MEMBER_ALIASES[who[1].toLowerCase()]}` };
      }
      return { pattern: 'single', role: classify(rest).role, task: rest, note: '/ask → router picks the member' };
    }
    case 'vote':
      return { pattern: 'vote', role: 'researcher', task: rest, note: '/vote' };
    case 'pbr':
    case 'build':
    case 'team':
      return { pattern: 'plan_build_review', role: 'builder', task: rest, note: `/${cmd} → plan → build → review` };
    case 'second':
      return { pattern: 'second_opinion', role: 'builder', task: rest, note: '/second → build + critique' };
    case 'plan':
    case 'review':
    case 'research':
    case 'quick': {
      const role = (cmd === 'research' ? 'researcher' : cmd === 'review' ? 'reviewer' : cmd === 'plan' ? 'planner' : 'quick') as CouncilRole;
      return { pattern: 'single', role, task: rest, note: `/${cmd}` };
    }
    default:
      rest = text;
      return null;
  }
}

const VOTE_RE = /\b(should (i|we)|which (is|one|option|approach|library)|compare|versus|\bvs\.?\s|pros and cons|trade-?offs?|decide between|best (way|approach|option|choice))\b/i;
const REVIEW_RE = /\b(review|audit|critique|look over|find (bugs|issues|problems)|security (review|audit|check)|vulnerab|code smell)/i;
const BUILD_RE = /\b(implement|build|add|create|fix|refactor|write|update|change|migrate|make|rename|remove|port|upgrade|integrate|wire up|hook up|set up|scaffold)\b/i;
const PLAN_RE = /\b(plan|design|architect(ure)?|approach for|strategy|spec|roadmap|break (it|this) down)\b/i;
const RESEARCH_RE = /\b(explain|how does|how do|what does|what is|where is|walk me through|summari[sz]e|understand|overview|map out|trace|why does)\b/i;
const BIG_RE = /\b(feature|system|module|end[- ]to[- ]end|across|multiple|entire|whole|refactor|architecture|tests?|integration|migrat)/i;

/** Keyword routing: instant, free, predictable. */
export function classify(task: string, c: CouncilSettings = getSettings().council): Route {
  const t = task.trim();
  if (VOTE_RE.test(t)) return { pattern: 'vote', role: 'researcher', task: t, note: 'rules: a decision/comparison → council vote' };
  if (REVIEW_RE.test(t)) return { pattern: 'single', role: 'reviewer', task: t, note: 'rules: review/audit → reviewer' };
  if (BUILD_RE.test(t) && !RESEARCH_RE.test(t.slice(0, 40))) {
    const big = t.length > 160 || BIG_RE.test(t);
    if (!c.allowWrite) return { pattern: 'single', role: 'planner', task: t, note: 'rules: change requested but council edits are off → planner proposes the change' };
    return big
      ? { pattern: 'plan_build_review', role: 'builder', task: t, note: 'rules: multi-part change → plan → build → review' }
      : { pattern: 'single', role: 'builder', task: t, note: 'rules: small change → builder' };
  }
  if (PLAN_RE.test(t)) return { pattern: 'single', role: 'planner', task: t, note: 'rules: planning/design → planner' };
  if (RESEARCH_RE.test(t)) {
    return t.length < 140
      ? { pattern: 'single', role: 'quick', task: t, note: 'rules: short question → quick (local first)' }
      : { pattern: 'single', role: 'researcher', task: t, note: 'rules: codebase question → researcher' };
  }
  return { pattern: 'single', role: 'researcher', task: t, note: 'rules: default → researcher' };
}

/** Optional: ask the local model to classify (free, ~1–3s). Falls back to rules on any problem. */
export async function classifyWithLocal(task: string, signal: AbortSignal): Promise<Route> {
  const fallback = classify(task);
  const model = getSettings().model;
  if (!model) return fallback;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  const onAbort = () => ac.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const r = await streamChat({
      model,
      temperature: 0,
      signal: ac.signal,
      tools: [],
      messages: [
        {
          role: 'system',
          content:
            'You route coding requests to a council of AI agents. Reply with ONLY a JSON object: {"pattern": "single"|"plan_build_review"|"second_opinion"|"vote", "role": "planner"|"builder"|"reviewer"|"researcher"|"quick"}.\n' +
            '- vote: a decision or comparison where independent opinions help.\n- plan_build_review: a multi-part code change.\n- single+builder: a small code change.\n- single+reviewer: review/audit existing code.\n- single+planner: design or plan without changing code.\n- single+researcher: questions about a codebase.\n- single+quick: short general question.',
        },
        { role: 'user', content: task.slice(0, 4000) },
      ],
    });
    const j = JSON.parse((r.content.match(/\{[\s\S]*\}/) ?? ['{}'])[0]) as { pattern?: string; role?: string };
    const patterns: CouncilPattern[] = ['single', 'plan_build_review', 'second_opinion', 'vote'];
    const roles: CouncilRole[] = ['planner', 'builder', 'reviewer', 'researcher', 'quick'];
    if (!patterns.includes(j.pattern as CouncilPattern) || !roles.includes(j.role as CouncilRole)) return { ...fallback, note: `${fallback.note} (local router gave an unusable answer)` };
    let pattern = j.pattern as CouncilPattern;
    let role = j.role as CouncilRole;
    if (!getSettings().council.allowWrite && (pattern === 'plan_build_review' || pattern === 'second_opinion' || role === 'builder')) {
      pattern = 'single';
      role = 'planner';
    }
    return { pattern, role, task, note: `local router (${model}): ${pattern}/${role}` };
  } catch {
    return { ...fallback, note: `${fallback.note} (local router unavailable)` };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

export interface Pick {
  member: CouncilMemberRef;
  note: string;
}

/** Why a member can't take work right now, or null if it can. */
export function unavailableReason(ref: CouncilMemberRef, statuses: MemberStatus[], c: CouncilSettings = getSettings().council): string | null {
  if (ref === 'local') return getSettings().model ? null : 'no local model selected';
  const cfg = c.members[ref];
  if (!cfg?.enabled) return 'turned off';
  const st = statuses.find((s) => s.id === ref);
  if (!st?.installed) return 'not installed';
  if (!st.signedIn) return 'not signed in';
  if (c.requirePlanBilling && st.billing === 'api') return 'signed in with an API key (subscription-only is on)';
  if (isLimited(ref)) return 'cooling down after a usage limit';
  return null;
}

/** First available member for a role, skipping `exclude`. Notes which ones were skipped and why. */
export function pickMember(role: CouncilRole, statuses: MemberStatus[], exclude: CouncilMemberRef[] = []): Pick | null {
  const c = getSettings().council;
  const order = [...c.roles[role], ...MEMBER_IDS.filter((m) => !c.roles[role].includes(m))];
  const skipped: string[] = [];
  for (const ref of order) {
    if (exclude.includes(ref)) continue;
    const why = unavailableReason(ref, statuses, c);
    if (!why) {
      const primary = c.roles[role][0];
      return { member: ref, note: ref === primary ? `${role}: ${ref}` : `${role}: ${ref} (fallback${skipped.length ? `; skipped ${skipped.join(', ')}` : ''})` };
    }
    skipped.push(`${ref} – ${why}`);
  }
  return null;
}

export function availableMembers(statuses: MemberStatus[]): MemberId[] {
  return MEMBER_IDS.filter((m) => !unavailableReason(m, statuses));
}

/** Heavy roles get the member's stronger model when one is configured. */
export function modelFor(ref: CouncilMemberRef, role: CouncilRole | 'judge' | 'voter'): string | undefined {
  if (ref === 'local') return undefined;
  const cfg = getSettings().council.members[ref];
  const heavy = role === 'planner' || role === 'reviewer' || role === 'judge';
  return (heavy && cfg.heavyModel) || cfg.model || undefined;
}
