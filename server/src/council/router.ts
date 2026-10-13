import type { CouncilMemberRef, CouncilPattern, CouncilRisk, CouncilRole, CouncilSettings, MemberId, MemberStatus } from '@localdex/shared';
import { COUNCIL_ROLES, MEMBER_IDS, isBuilderRole } from '@localdex/shared';
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
  /** Risk rating from `assessRisk`; computed from the task when missing. */
  risk?: CouncilRisk;
  riskReasons?: string[];
}

// ---------- risk ----------

export interface RiskAssessment {
  risk: CouncilRisk;
  /** Short labels of the signals that matched, e.g. ['auth', 'migration']. */
  reasons: string[];
}

/** Keyword signals for risky changes. Each label is what the user sees on the run card. */
const HIGH_RISK: [string, RegExp][] = [
  ['migration', /\b(migrations?|(db|database|sql) (schema|migrat\w*)|schema (change|migration)s?|alter table|create table|(add|drop|rename) (a )?column)\b/i],
  ['auth', /\b(auth|authn|authz|authenticat\w*|authori[sz]\w*|log ?in|logout|log out|sign[- ]?in|sign[- ]?up|sessions?|passwords?|passwd|oauth\d?|sso|saml|jwt|(access|refresh|auth|bearer|csrf) tokens?|permissions?|rbac|acl|access control|(user|admin) roles?|roles and permissions|2fa|mfa)\b/i],
  ['payments', /\b(payments?|billing|checkout|invoic\w*|stripe|paypal|credit cards?|refunds?|payouts?)\b/i],
  ['secrets', /\b(encrypt\w*|decrypt\w*|crypto\w*|ciphers?|secrets?|api[- ]?keys?|private keys?|signing keys?|keys?(store|chain)|credentials?|certificates?|tls|ssl|hmac)\b|\.env\b/i],
  ['data deletion', /\b(delet\w* (all |the |every |old |existing )?(data|records?|rows?|users?|accounts?|database|tables?|backups?|history)|delete from|drop (table|database|schema|column|index)|truncate|rm -rf|purge|wipe|destroy (the )?(data|database))\b/i],
  ['deploy/infra', /\b(production|prod|deploy\w*|infra\w*|terraform|kubernetes|k8s|helm|dockerfile|docker-compose|ci( config| pipeline| workflow)?|ci\/cd|github actions|nginx)\b|\.github\/workflows/i],
  ['security fix', /\b(security (fix|patch|issue|bug|hole)s?|vulnerab\w*|cve-\d+|xss|csrf|(sql|command|shell|prompt) injection|path traversal|rce|sanitiz\w*)\b/i],
  ['major upgrade', /\b(major (version|upgrade|bump)s?|(upgrade|bump)\w* .{0,40}?\bto v?\d+(\.x|\.0)?(?![\w.]))/i],
  ['history rewrite', /\b(force[- ]push\w*|push (--force|-f)\b|rebase|reset --hard|rewrite (the )?(repo |commit )?history|filter-branch|filter-repo)/i],
];

const LOW_RISK: [string, RegExp][] = [
  ['docs', /\b(readme|docs|documentation|changelog|jsdoc|docstrings?)\b/i],
  ['typo', /\b(typos?|spelling|misspell\w*|wording)\b/i],
  ['comments', /\b(code comments?|comments? (in|to|for)|add(ing)? (a )?comments?)\b/i],
  ['formatting', /\b(formatting|reformat\w*|prettier|whitespace|indentation|lint warnings?)\b/i],
  ['test rename', /\brenam\w* .{0,60}\b(in|of) (the )?tests?\b|\btest names?\b/i],
];

/** How risky a task looks. High wins over low; nothing matched = normal. Pure and explainable on purpose. */
export function assessRisk(task: string): RiskAssessment {
  const high = HIGH_RISK.filter(([, re]) => re.test(task)).map(([label]) => label);
  if (high.length) return { risk: 'high', reasons: high };
  const low = LOW_RISK.filter(([, re]) => re.test(task)).map(([label]) => label);
  if (low.length) return { risk: 'low', reasons: low };
  return { risk: 'normal', reasons: [] };
}

/**
 * Attach the risk rating to a route. With `upgrade` (router decisions only, never slash commands) and risk routing on,
 * a high-risk change headed to a lone builder is upgraded to plan → build → review.
 */
export function withRisk(route: Route, opts: { upgrade?: boolean } = {}, c: CouncilSettings = getSettings().council): Route {
  const { risk, reasons } = route.risk ? { risk: route.risk, reasons: route.riskReasons ?? [] } : assessRisk(route.task);
  const out: Route = { ...route, risk, riskReasons: reasons };
  if (opts.upgrade && c.riskRouting && risk === 'high' && c.allowWrite && out.pattern === 'single' && isBuilderRole(out.role) && !out.member) {
    out.pattern = 'plan_build_review';
    out.note = `${out.note}; high risk (${reasons.join(', ')}) → plan → build → review`;
  }
  return out;
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
        return { pattern: 'single', role: domainBuilder(who[2]).role, member: MEMBER_ALIASES[who[1].toLowerCase()], task: who[2].trim(), note: `/ask → ${MEMBER_ALIASES[who[1].toLowerCase()]}` };
      }
      return { pattern: 'single', role: classify(rest).role, task: rest, note: '/ask → router picks the member' };
    }
    case 'vote':
      return { pattern: 'vote', role: 'researcher', task: rest, note: '/vote' };
    case 'pbr':
    case 'build':
    case 'team':
      return { pattern: 'plan_build_review', role: domainBuilder(rest).role, task: rest, note: `/${cmd} → plan → build → review` };
    case 'second':
      return { pattern: 'second_opinion', role: domainBuilder(rest).role, task: rest, note: '/second → build + critique' };
    case 'frontend':
    case 'backend':
    case 'vision':
      return { pattern: 'single', role: cmd as CouncilRole, task: rest, note: `/${cmd}` };
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

const FRONTEND_RE = /\b(ui|ux|components?|css|scss|tailwind|layouts?|pages?|styles?|styling|react|jsx|tsx|buttons?|modals?|dialogs?|responsive|navbar|sidebar|frontend|front-end)\b|\.(tsx|jsx|css|scss|vue|svelte)\b/gi;
const BACKEND_RE = /\b(api|apis|endpoints?|route handlers?|databases?|db|sql|queries|postgres(ql)?|mysql|sqlite|server|queues?|auth middleware|middleware|migrations?|schema|backend|back-end|webhooks?|cron jobs?)\b/gi;
const IMAGE_FILE_RE = /(?:^|[\s'"`(\[])((?:[\w.~-]*[\\/])*[\w.~-]*?[\w~-]\.(?:png|jpe?g|webp|gif))\b/gi;
const IMAGE_WORD_RE = /\b(screenshots?|screen ?grabs?|mock-?ups?|design (image|file|comp|png|jpe?g)s?|wireframe images?)\b/i;

/** Image files (paths or file names) mentioned in a request, in order, without duplicates. */
export function findImageRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IMAGE_FILE_RE)) {
    const ref = m[1].trim();
    if (ref && !out.includes(ref)) out.push(ref);
  }
  return out;
}

/** True when the request is about an image: an image file is named, or it talks about a screenshot/mockup. */
export function mentionsImage(text: string): boolean {
  return findImageRefs(text).length > 0 || IMAGE_WORD_RE.test(text);
}

/** Which builder should take a change: frontend or backend when the signals point one way, else the plain builder. */
export function domainBuilder(task: string): { role: CouncilRole; why: string } {
  const fe = new Set((task.match(FRONTEND_RE) ?? []).map((w) => w.toLowerCase())).size;
  const be = new Set((task.match(BACKEND_RE) ?? []).map((w) => w.toLowerCase())).size;
  if (fe && !be) return { role: 'frontend', why: 'UI work' };
  if (be && !fe) return { role: 'backend', why: 'backend work' };
  return { role: 'builder', why: fe && be ? 'mixed frontend and backend' : 'no clear domain' };
}

/** Keyword routing: instant, free, predictable. Also rates risk and applies the risk policy. */
export function classify(task: string, c: CouncilSettings = getSettings().council): Route {
  return withRisk(classifyIntent(task, c), { upgrade: true }, c);
}

function classifyIntent(task: string, c: CouncilSettings): Route {
  const t = task.trim();
  if (VOTE_RE.test(t)) return { pattern: 'vote', role: 'researcher', task: t, note: 'rules: a decision/comparison → council vote' };
  if (mentionsImage(t)) return { pattern: 'single', role: 'vision', task: t, note: 'rules: refers to an image → vision' };
  if (REVIEW_RE.test(t)) return { pattern: 'single', role: 'reviewer', task: t, note: 'rules: review/audit → reviewer' };
  if (BUILD_RE.test(t) && !RESEARCH_RE.test(t.slice(0, 40))) {
    const big = t.length > 160 || BIG_RE.test(t);
    if (!c.allowWrite) return { pattern: 'single', role: 'planner', task: t, note: 'rules: change requested but council edits are off → planner proposes the change' };
    const d = domainBuilder(t);
    return big
      ? { pattern: 'plan_build_review', role: d.role, task: t, note: `rules: multi-part change → plan → build (${d.role}: ${d.why}) → review` }
      : { pattern: 'single', role: d.role, task: t, note: `rules: small change → ${d.role} (${d.why})` };
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
            'You route coding requests to a council of AI agents. Reply with ONLY a JSON object: {"pattern": "single"|"plan_build_review"|"second_opinion"|"vote", "role": "planner"|"builder"|"frontend"|"backend"|"reviewer"|"researcher"|"vision"|"quick"}.\n' +
            '- vote: a decision or comparison where independent opinions help.\n- plan_build_review: a multi-part code change.\n- single+builder: a small code change (frontend: UI/CSS/components; backend: API/database/server; builder: mixed or unclear).\n- single+vision: the request refers to an image, screenshot or mockup.\n- single+reviewer: review/audit existing code.\n- single+planner: design or plan without changing code.\n- single+researcher: questions about a codebase.\n- single+quick: short general question.',
        },
        { role: 'user', content: task.slice(0, 4000) },
      ],
    });
    const j = JSON.parse((r.content.match(/\{[\s\S]*\}/) ?? ['{}'])[0]) as { pattern?: string; role?: string };
    const patterns: CouncilPattern[] = ['single', 'plan_build_review', 'second_opinion', 'vote'];
    const roles: CouncilRole[] = COUNCIL_ROLES;
    if (!patterns.includes(j.pattern as CouncilPattern) || !roles.includes(j.role as CouncilRole)) return { ...fallback, note: `${fallback.note} (local router gave an unusable answer)` };
    let pattern = j.pattern as CouncilPattern;
    let role = j.role as CouncilRole;
    // Build patterns always run a builder; refine a plain builder by domain, and never let a read-only role "build".
    if (pattern === 'plan_build_review' || pattern === 'second_opinion') {
      if (!isBuilderRole(role)) role = 'builder';
    }
    if (role === 'builder') role = domainBuilder(task).role;
    if (!getSettings().council.allowWrite && (pattern === 'plan_build_review' || pattern === 'second_opinion' || isBuilderRole(role))) {
      pattern = 'single';
      role = 'planner';
    }
    return withRisk({ pattern, role, task, note: `local router (${model}): ${pattern}/${role}` }, { upgrade: true });
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

/** Heavy roles get the member's stronger model when one is configured. `heavy` asks for it on any role (e.g. a risky build). */
export function modelFor(ref: CouncilMemberRef, role: CouncilRole | 'judge' | 'voter', opts: { heavy?: boolean } = {}): string | undefined {
  if (ref === 'local') return undefined;
  const cfg = getSettings().council.members[ref];
  const heavy = opts.heavy || role === 'planner' || role === 'reviewer' || role === 'qa' || role === 'judge';
  return (heavy && cfg.heavyModel) || cfg.model || undefined;
}
