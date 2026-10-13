import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type {
  AgentId,
  CouncilAccess,
  CouncilMemberRef,
  CouncilRole,
  CouncilRun,
  CouncilStep,
  MemberStatus,
  Session,
} from '@localdex/shared';
import { isBuilderRole } from '@localdex/shared';
import { getSettings } from '../config.js';
import { bus } from '../agent/bus.js';
import { approvedFolders } from '../tools/permissions.js';
import { MEMBERS, markLimited, memberStatuses, noteError } from './registry.js';
import { availableMembers, findImageRefs, modelFor, pickMember, unavailableReason, withRisk, type Route } from './router.js';
import {
  builderPrompt,
  checksFixPrompt,
  checksSummary,
  critiquePrompt,
  fixPrompt,
  judgePrompt,
  memberInstructions,
  parseQaVerdict,
  parseVerdict,
  plannerPrompt,
  qaFixPrompt,
  qaPrompt,
  restateVerdictPrompt,
  reviewerPrompt,
  visionPrompt,
  votePrompt,
} from './prompts.js';
import { detectCheckCommand, runChecks, type CheckRun } from './checks.js';
import { describeKinds, existingRedactions, redactSecrets } from './redact.js';
import { recordBuildOutcome, recordStep } from './stats.js';

const MAX_RUNS_KEPT = 30;
const MAX_OUTPUT = 20_000;
const MAX_TRANSCRIPT_ITEMS = 300;
const MAX_DIFF = 40_000;

export interface CouncilContext {
  session: Session;
  signal: AbortSignal;
  /** Save the session and push it to the UI. */
  persist(): void;
  /** Run a task on the local LM Studio model as a LocalDex worker (LocalDex's own permissions apply). */
  delegateLocal(name: string, task: string): Promise<string>;
}

const label = (m: CouncilMemberRef) => (m === 'local' ? 'Local' : MEMBERS[m].label);

/** Run one routed council request end to end. Always resolves; problems end up in run.status/result. */
export async function runCouncil(ctx: CouncilContext, input: Route): Promise<CouncilRun> {
  // Rate every run, whoever routed it; explicit patterns (slash commands, the lead agent) are never changed here.
  const route = withRisk(input);
  const run: CouncilRun = {
    id: randomUUID().slice(0, 8),
    pattern: route.pattern,
    task: route.task,
    status: 'running',
    startedAt: Date.now(),
    routeNote: route.note,
    risk: route.risk,
    riskReasons: route.riskReasons,
    steps: [],
  };
  const runs = (ctx.session.councilRuns ??= []);
  runs.push(run);
  if (runs.length > MAX_RUNS_KEPT) runs.splice(0, runs.length - MAX_RUNS_KEPT);
  ctx.persist();

  try {
    const folders = approvedFolders();
    if (!folders.length) throw new Error('No approved folders. Add your project folder in Settings → Workspace first; council members only work inside approved folders.');
    if (!route.task.trim()) throw new Error('Nothing to do: the task is empty.');
    const statuses = await memberStatuses();

    switch (route.pattern) {
      case 'single':
        run.result = await single(ctx, run, route, statuses);
        break;
      case 'plan_build_review':
        run.result = await planBuildReview(ctx, run, route.task, statuses, buildRole(route.role));
        break;
      case 'second_opinion':
        run.result = await secondOpinion(ctx, run, route.task, statuses, buildRole(route.role));
        break;
      case 'vote':
        run.result = await vote(ctx, run, route.task, statuses);
        break;
    }
    run.status = ctx.signal.aborted ? 'cancelled' : run.steps.some((s) => s.status === 'done') ? 'done' : 'error';
  } catch (e) {
    run.status = ctx.signal.aborted ? 'cancelled' : 'error';
    run.result = `Council run failed: ${(e as Error).message}`;
  } finally {
    run.endedAt = Date.now();
    for (const s of run.steps) if (s.status === 'running' || s.status === 'queued') s.status = 'cancelled';
    ctx.persist();
  }
  return run;
}

// ---------- patterns ----------

async function single(ctx: CouncilContext, run: CouncilRun, route: Route, statuses: MemberStatus[]): Promise<string> {
  const access = accessFor(route.role);
  const prompt = route.role === 'vision' ? visionPrompt(route.task, findImageRefs(askedPart(route.task))) : route.task;
  if (route.member) {
    const why = unavailableReason(route.member, statuses);
    if (why) return `${label(route.member)} can't take this: ${why}.`;
    const step = await runStep(ctx, run, { role: route.role, member: route.member, access, prompt, note: 'requested' });
    return stepAnswer(step);
  }
  const step = await runRole(ctx, run, route.role, access, prompt, statuses);
  return step ? stepAnswer(step) : noMemberMessage(route.role, statuses);
}

async function planBuildReview(ctx: CouncilContext, run: CouncilRun, task: string, statuses: MemberStatus[], builderRole: CouncilRole): Promise<string> {
  const c = getSettings().council;
  const cwd = approvedFolders()[0];
  const out: string[] = [];
  const maxFixRounds = isRiskyRun(run) ? Math.max(1, c.maxFixRounds) : c.maxFixRounds;

  const plan = await runRole(ctx, run, 'planner', 'read', plannerPrompt(task), statuses);
  const planText = plan?.status === 'done' ? plan.output ?? '' : '';
  if (ctx.signal.aborted) return 'Cancelled.';

  const before = gitSnapshot(cwd);
  let builder = await runRole(ctx, run, builderRole, accessFor(builderRole), builderPrompt(task, planText || undefined), statuses);
  if (!builder || builder.status !== 'done') {
    return [`**The build step did not complete.** ${builder?.error ?? noMemberMessage(builderRole, statuses)}`, planText ? `### Plan (${label(plan!.member)})\n${planText}` : ''].filter(Boolean).join('\n\n');
  }
  if (ctx.signal.aborted) return 'Cancelled.';

  // Each round: project checks → reviewer → QA. The first gate that fails sends the builder into a fix round.
  const gate = checksGateFor(cwd, accessFor(builderRole));
  let report = builder.output ?? '';
  let g: Gates = { checks: null, review: null, reviewOk: false, reviewMissing: false, qa: null, qaOk: false, qaMissing: false };
  let fixes = 0;
  while (!ctx.signal.aborted) {
    g = { checks: null, review: null, reviewOk: false, reviewMissing: false, qa: null, qaOk: false, qaMissing: false };
    g.checks = await runChecksStep(ctx, run, gate, fixes);
    let feedback = '';
    let why = '';
    if (g.checks && !g.checks.ok) {
      feedback = checksFixPrompt(task, g.checks);
      why = 'checks failed';
    } else {
      const checksText = checksSummary(g.checks);
      const diff = gitDiffSince(cwd, before);
      g.review = await runRole(ctx, run, 'reviewer', 'read', reviewerPrompt(task, report, diff, planText || undefined, checksText), statuses, [builder.member]);
      if (!g.review || g.review.status !== 'done') break;
      ({ ok: g.reviewOk, missing: g.reviewMissing } = await readVerdict(ctx, run, g.review, 'review'));
      if (!g.reviewOk) {
        feedback = fixPrompt(task, g.reviewMissing ? `${g.review.output ?? ''}\n\n(The reviewer gave no verdict; treat its notes as requested fixes.)` : g.review.output ?? '');
        why = g.reviewMissing ? 'no verdict' : '';
      } else if (c.qaStep && !ctx.signal.aborted) {
        g.qa = await runRole(ctx, run, 'qa', 'read', qaPrompt(task, report, diff, stripVerdictLine(g.review.output ?? ''), checksText), statuses, [builder.member, g.review.member]);
        if (g.qa?.status === 'done') {
          ({ ok: g.qaOk, missing: g.qaMissing } = await readVerdict(ctx, run, g.qa, 'qa'));
          if (!g.qaOk) {
            feedback = qaFixPrompt(task, g.qa.output ?? '');
            why = 'QA';
          }
        }
      }
    }
    if (!feedback || fixes >= maxFixRounds || ctx.signal.aborted) break;
    fixes++;
    const fix = await runStep(ctx, run, { role: builderRole, member: builder.member, access: accessFor(builderRole), prompt: feedback, note: `fix round ${fixes}${why ? ` (${why})` : ''}` });
    if (fix.status !== 'done') break;
    builder = fix;
    report = `${report}\n\nFix round ${fixes}:\n${fix.output ?? ''}`;
  }

  recordBuildOutcome(run, overallVerdict(g));
  out.push(`**${gatesHeader(g, gate, c.qaStep)}** · built by ${label(builder.member)}${plan?.status === 'done' ? ` · planned by ${label(plan.member)}` : ''}`);
  out.push(`### What changed\n${report || '(no report)'}`);
  if (g.checks) out.push(`### Checks\n\`${g.checks.command}\` ${g.checks.ok ? 'passed' : g.checks.timedOut ? 'timed out' : `failed (exit ${g.checks.code ?? 'killed'})`}${g.checks.tail.trim() ? `\n\n\`\`\`\n${g.checks.tail.trim().slice(-1_500)}\n\`\`\`` : ''}`);
  if (g.review?.status === 'done') out.push(`### Review\n${stripVerdictLine(g.review.output ?? '')}`);
  if (g.qa?.status === 'done') out.push(`### QA\n${(g.qa.output ?? '').trim()}`);
  if (planText) out.push(`### Plan\n${planText}`);
  return out.join('\n\n');
}

// ---------- plan → build → review gates: project checks, verdicts, QA ----------

interface Gates {
  checks: CheckRun | null;
  review: CouncilStep | null;
  reviewOk: boolean;
  /** The reviewer gave no readable verdict, even when asked again (counts as changes requested). */
  reviewMissing: boolean;
  qa: CouncilStep | null;
  qaOk: boolean;
  qaMissing: boolean;
}

interface ChecksGate {
  /** '' = nothing to run (no checks found, or the builder could not edit files). */
  command: string;
  source: 'settings' | 'detected';
  /** The user declined running the checks once; they are skipped for the rest of the run. */
  declined: boolean;
}

function checksGateFor(cwd: string, builderAccess: CouncilAccess): ChecksGate {
  // A read-only builder changed nothing, so there is nothing new to check.
  const c = getSettings().council;
  if (builderAccess !== 'write' || c.checksGate === false) return { command: '', source: 'detected', declined: false };
  const custom = (c.checkCommand ?? '').trim();
  return { command: custom || detectCheckCommand(cwd), source: custom ? 'settings' : 'detected', declined: false };
}

/**
 * Run the project's checks as their own step (member 'local'). Commands run on the user's machine,
 * so the user approves each run unless shell approval is set to "never". Returns null when nothing ran.
 */
async function runChecksStep(ctx: CouncilContext, run: CouncilRun, gate: ChecksGate, fixRound: number): Promise<CheckRun | null> {
  if (!gate.command || gate.declined || ctx.signal.aborted) return null;
  const sessionId = ctx.session.id;
  const cwd = approvedFolders()[0];
  const step: CouncilStep = {
    id: `${run.id}-${run.steps.length + 1}`,
    role: 'checks',
    member: 'local',
    access: 'read',
    status: 'running',
    startedAt: Date.now(),
    transcript: [],
    note: `${gate.source === 'settings' ? 'your check command' : 'detected'}: ${gate.command}${fixRound ? ` · after fix round ${fixRound}` : ''}`,
  };
  run.steps.push(step);
  const agent: AgentId = `member:${step.id}`;
  ctx.persist();
  try {
    if (getSettings().shellApproval !== 'never') {
      bus.emit({ type: 'agent_status', sessionId, agent: 'main', status: 'waiting', detail: "Approve running the project's checks?" });
      const approved = await bus.requestApproval(sessionId, agent, `Council: run the project's checks before review?\n\n$ ${gate.command}`, cwd, ctx.signal).catch(() => false);
      if (!approved) {
        step.status = ctx.signal.aborted ? 'cancelled' : 'skipped';
        step.error = ctx.signal.aborted ? 'Cancelled.' : 'You declined running the checks, so they are skipped for this run.';
        if (!ctx.signal.aborted) gate.declined = true;
        return null;
      }
    }
    bus.emit({ type: 'agent_status', sessionId, agent: 'main', status: 'running', detail: 'Council: running checks…' });
    const res = await runChecks(gate.command, cwd, Math.max(1, getSettings().council.checkTimeoutMinutes || 10) * 60_000, ctx.signal);
    step.output = res.tail;
    step.status = res.cancelled ? 'cancelled' : res.ok ? 'done' : 'error';
    if (!res.ok && !res.cancelled) step.error = res.timedOut ? `Checks timed out after ${getSettings().council.checkTimeoutMinutes || 10} min.` : `Checks failed (exit ${res.code ?? 'killed'}).`;
    return res.cancelled ? null : res;
  } finally {
    step.endedAt = Date.now();
    ctx.persist();
  }
}

/**
 * Read a reviewer's or QA's verdict. A reply without one gets one short follow-up asking the same member for the
 * verdict line only; if that fails too, it counts as a rejection.
 */
async function readVerdict(ctx: CouncilContext, run: CouncilRun, step: CouncilStep, kind: 'review' | 'qa'): Promise<{ ok: boolean; missing: boolean }> {
  const parse = (t: string): boolean | null => {
    const v = kind === 'review' ? parseVerdict(t) : parseQaVerdict(t);
    return v === 'unknown' ? null : v === 'approve' || v === 'pass';
  };
  const first = parse(step.output ?? '');
  if (first !== null) return { ok: first, missing: false };
  if (ctx.signal.aborted) return { ok: false, missing: true };
  const again = await runStep(ctx, run, {
    role: step.role as StepSpec['role'],
    member: step.member,
    access: 'read',
    prompt: restateVerdictPrompt(kind, step.output ?? ''),
    note: 'no verdict given, asked to restate it',
  });
  const second = again.status === 'done' ? parse(again.output ?? '') : null;
  return second === null ? { ok: false, missing: true } : { ok: second, missing: false };
}

function stripVerdictLine(review: string): string {
  return review.replace(/^\s*VERDICT:\s*\S+\s*\n?/i, '').trim();
}

function overallVerdict(g: Gates): 'approve' | 'changes' | 'unknown' {
  if (g.checks && !g.checks.ok) return 'changes';
  if (g.review?.status !== 'done') return 'unknown';
  if (!g.reviewOk) return 'changes';
  return g.qa?.status === 'done' && !g.qaOk ? 'changes' : 'approve';
}

/** "✅ Checks passed · Approved by Codex · QA passed by Gemini" */
function gatesHeader(g: Gates, gate: ChecksGate, qaOn: boolean): string {
  const parts: string[] = [];
  let good = true;
  if (g.checks) {
    parts.push(g.checks.ok ? 'Checks passed' : g.checks.timedOut ? 'Checks timed out' : 'Checks failed');
    good &&= g.checks.ok;
  } else if (gate.declined) parts.push('Checks skipped (you declined)');
  if (g.review?.status === 'done') {
    const who = label(g.review.member);
    parts.push(g.reviewOk ? `Approved by ${who}` : `Changes still requested by ${who}${g.reviewMissing ? ' (no verdict given)' : ''}`);
    good &&= g.reviewOk;
    if (g.reviewOk && qaOn) {
      if (g.qa?.status === 'done') {
        const q = label(g.qa.member);
        parts.push(g.qaOk ? `QA passed by ${q}` : `QA failed by ${q}${g.qaMissing ? ' (no verdict given)' : ''}`);
        good &&= g.qaOk;
      } else {
        parts.push(`QA skipped (${g.qa?.error ?? 'no member available'})`);
        good = false;
      }
    }
  } else {
    parts.push(g.checks && !g.checks.ok ? 'Not reviewed (checks failed)' : 'Not reviewed');
    good = false;
  }
  return `${good ? '✅' : '⚠️'} ${parts.join(' · ')}`;
}

async function secondOpinion(ctx: CouncilContext, run: CouncilRun, task: string, statuses: MemberStatus[], builderRole: CouncilRole): Promise<string> {
  const cwd = approvedFolders()[0];
  const before = gitSnapshot(cwd);
  const builder = await runRole(ctx, run, builderRole, accessFor(builderRole), builderPrompt(task), statuses);
  if (!builder || builder.status !== 'done') return `**The build step did not complete.** ${builder?.error ?? noMemberMessage(builderRole, statuses)}`;
  const critic = await runRole(ctx, run, 'reviewer', 'read', critiquePrompt(task, builder.output ?? '', gitDiffSince(cwd, before)), statuses, [builder.member]);
  return [
    `**Built by ${label(builder.member)}**${critic?.status === 'done' ? ` · second opinion from ${label(critic.member)}` : ''}`,
    `### What changed\n${builder.output ?? ''}`,
    critic?.status === 'done' ? `### Second opinion\n${critic.output}` : `_No second opinion: ${critic?.error ?? 'no reviewer available'}_`,
  ].join('\n\n');
}

async function vote(ctx: CouncilContext, run: CouncilRun, question: string, statuses: MemberStatus[]): Promise<string> {
  const c = getSettings().council;
  const avail = availableMembers(statuses);
  let voters = c.voteMembers.filter((m) => avail.includes(m));
  if (voters.length < 2) voters = Array.from(new Set([...voters, ...avail])).slice(0, 3);
  if (voters.length === 0) return noMemberMessage('researcher', statuses);

  const steps = await Promise.all(voters.map((m) => runStep(ctx, run, { role: 'voter', member: m, access: 'read', prompt: votePrompt(question), note: 'vote' })));
  const answers = steps.filter((s) => s.status === 'done' && s.output).map((s) => ({ member: label(s.member), text: s.output! }));
  if (ctx.signal.aborted) return 'Cancelled.';
  if (answers.length === 0) return `No adviser answered.\n\n${steps.map((s) => `- ${label(s.member)}: ${s.error ?? s.status}`).join('\n')}`;
  if (answers.length === 1) return `Only ${answers[0].member} answered:\n\n${answers[0].text}`;

  let judge: CouncilMemberRef | null = unavailableReason(c.judge, statuses) ? null : c.judge;
  if (!judge) judge = pickMember('planner', statuses)?.member ?? null;
  let verdict = '';
  if (judge) {
    const j = await runStep(ctx, run, { role: 'judge', member: judge, access: 'read', prompt: judgePrompt(question, answers), note: judge === c.judge ? 'judge' : 'judge (fallback)' });
    verdict = j.status === 'done' ? j.output ?? '' : '';
  }
  return [
    verdict ? `### Council verdict (${label(judge!)})\n${verdict}` : '### Council answers (no judge available)',
    ...answers.map((a) => `### ${a.member}\n${a.text}`),
  ].join('\n\n');
}

// ---------- steps ----------

/** High-risk run with risk routing on: heavy builder model, edits always confirmed, at least one fix round. */
function isRiskyRun(run: CouncilRun): boolean {
  return run.risk === 'high' && getSettings().council.riskRouting;
}

function accessFor(role: CouncilRole | 'judge' | 'voter'): CouncilAccess {
  return isBuilderRole(role) && getSettings().council.allowWrite ? 'write' : 'read';
}

/** The build step of plan_build_review / second_opinion runs the route's domain builder, or the plain builder. */
function buildRole(role: CouncilRole): CouncilRole {
  return isBuilderRole(role) ? role : 'builder';
}

/** The user's own request, without the conversation history Council mode appends (so old image names don't leak in). */
function askedPart(task: string): string {
  return task.split('\n\n---\nEarlier in this conversation')[0];
}

function stepAnswer(step: CouncilStep): string {
  if (step.status === 'done') return step.output || '(no answer)';
  return `**${label(step.member)} could not finish** (${step.status}): ${step.error ?? 'unknown error'}${step.output ? `\n\nPartial output:\n${step.output}` : ''}`;
}

function noMemberMessage(role: CouncilRole, statuses: MemberStatus[]): string {
  const c = getSettings().council;
  const lines = [...new Set([...c.roles[role], 'claude', 'codex', 'gemini', 'cursor'] as CouncilMemberRef[])].map((m) => `- ${label(m)}: ${unavailableReason(m, statuses) ?? 'available'}`);
  return `No council member is available for the ${role} role.\n${lines.join('\n')}\n\nCheck Settings → Council.`;
}

/**
 * Run a role with automatic fallback: if the picked member hits a usage limit, isn't signed in or isn't installed,
 * the next member in the role's order takes over. `prefer` lists members to avoid if possible (e.g. the builder when picking a reviewer).
 */
async function runRole(
  ctx: CouncilContext,
  run: CouncilRun,
  role: CouncilRole,
  access: CouncilAccess,
  prompt: string,
  statuses: MemberStatus[],
  avoid: CouncilMemberRef[] = [],
): Promise<CouncilStep | null> {
  const exclude: CouncilMemberRef[] = [];
  let last: CouncilStep | null = null;
  for (let attempt = 0; attempt < 4 && !ctx.signal.aborted; attempt++) {
    const pick = pickMember(role, statuses, [...exclude, ...avoid]) ?? (avoid.length ? pickMember(role, statuses, exclude) : null);
    if (!pick) break;
    const step = await runStep(ctx, run, { role, member: pick.member, access, prompt, note: attempt ? `${pick.note} (retry after ${label(last!.member)} failed)` : pick.note });
    last = step;
    if (step.status === 'done' || step.status === 'cancelled') return step;
    // Only hand off for problems another member can fix; a real error in the task itself is reported.
    const handoff = step.status === 'limited' || /not signed in|not installed|not found|API key|subscription-only/i.test(step.error ?? '');
    if (!handoff) return step;
    exclude.push(pick.member);
  }
  return last;
}

interface StepSpec {
  role: Exclude<CouncilStep['role'], 'checks'>;
  member: CouncilMemberRef;
  access: CouncilAccess;
  prompt: string;
  note?: string;
}

async function runStep(ctx: CouncilContext, run: CouncilRun, spec: StepSpec): Promise<CouncilStep> {
  const c = getSettings().council;
  const sessionId = ctx.session.id;
  const risky = isRiskyRun(run);
  const heavyBuild = risky && isBuilderRole(spec.role);
  const step: CouncilStep = {
    id: `${run.id}-${run.steps.length + 1}`,
    role: spec.role,
    member: spec.member,
    model: modelFor(spec.member, spec.role, { heavy: heavyBuild }),
    access: spec.access,
    status: 'running',
    startedAt: Date.now(),
    transcript: [],
    note: heavyBuild ? `${spec.note ? `${spec.note} · ` : ''}heavy model (high risk)` : spec.note,
  };
  run.steps.push(step);
  const agent: AgentId = `member:${step.id}`;
  bus.emit({ type: 'agent_status', sessionId, agent, status: 'running', detail: `${label(spec.member)} · ${spec.role}` });
  bus.emit({ type: 'agent_status', sessionId, agent: 'main', status: 'running', detail: `Council: ${label(spec.member)} (${spec.role})…` });
  bus.emit({ type: 'turn_start', sessionId, agent });
  ctx.persist();

  let lastPersist = Date.now();
  const persistSoon = () => {
    if (Date.now() - lastPersist > 1500) {
      lastPersist = Date.now();
      ctx.persist();
    }
  };
  const pushItem = (item: CouncilStep['transcript'][number]) => {
    if (step.transcript.length < MAX_TRANSCRIPT_ITEMS) step.transcript.push(item);
  };

  try {
    const cwd = approvedFolders()[0];
    const instructions = memberInstructions(spec.role, spec.access, cwd);

    if (spec.member === 'local') {
      const report = await ctx.delegateLocal(`council-${spec.role}`, `${instructions}\n\n${spec.prompt}`);
      step.output = report.slice(0, MAX_OUTPUT);
      step.status = ctx.signal.aborted ? 'cancelled' : /^\[worker error\]/.test(report) ? 'error' : 'done';
      if (step.status === 'error') step.error = report.slice(0, 400);
      step.billing = 'plan';
      return step;
    }

    const st = (await memberStatuses()).find((s) => s.id === spec.member);
    if (c.requirePlanBilling && st?.billing === 'api') {
      step.status = 'error';
      step.error = `${label(spec.member)} is signed in with an API key, and subscription-only is on. Sign in with your subscription (${st.loginCommand}) or turn off "Subscription only" in Settings → Council.`;
      return step;
    }

    // Human in the loop: a cloud agent that can edit files only starts after the user approves it.
    if (spec.access === 'write' && risky && !c.confirmWrites) {
      const why = `High-risk change (${(run.riskReasons ?? []).join(', ') || 'risky'}): asking before edits even though "Ask me before each member that can edit files" is off.`;
      pushItem({ kind: 'note', text: why });
      bus.log('info', `[council] ${why}`);
    }
    if (spec.access === 'write' && (c.confirmWrites || risky)) {
      bus.emit({ type: 'agent_status', sessionId, agent: 'main', status: 'waiting', detail: `Approve ${label(spec.member)} editing files?` });
      const approved = await bus
        .requestApproval(sessionId, agent, `Council: let ${label(spec.member)} (${spec.role}) edit files in ${cwd}?\n\n${spec.prompt.slice(0, 600)}${spec.prompt.length > 600 ? '…' : ''}`, cwd, ctx.signal)
        .catch(() => false);
      if (!approved) {
        step.status = ctx.signal.aborted ? 'cancelled' : 'skipped';
        step.error = ctx.signal.aborted ? 'Cancelled.' : 'You declined file edits for this step.';
        return step;
      }
      bus.emit({ type: 'agent_status', sessionId, agent: 'main', status: 'running', detail: `Council: ${label(spec.member)} (${spec.role})…` });
    }

    // Cloud members only: the prompt leaves this machine, so credentials in it are replaced first.
    const prompt = c.redactSecrets !== false ? redactForCloud(spec.prompt, step) : spec.prompt;

    // Child controller so a mid-run billing surprise can stop just this member.
    const ac = new AbortController();
    const onParentAbort = () => ac.abort();
    ctx.signal.addEventListener('abort', onParentAbort, { once: true });
    let billingAbort = '';

    const res = await MEMBERS[spec.member].run({
      prompt,
      instructions,
      cwd,
      extraDirs: approvedFolders().slice(1),
      access: spec.access,
      model: step.model,
      signal: ac.signal,
      timeoutMs: Math.max(1, c.timeoutMinutes) * 60_000,
      onEvent: (ev) => {
        switch (ev.kind) {
          case 'text': {
            const lastItem = step.transcript.at(-1);
            if (lastItem?.kind === 'text') lastItem.text = (lastItem.text ?? '') + ev.delta;
            else pushItem({ kind: 'text', text: ev.delta });
            bus.emit({ type: 'assistant_delta', sessionId, agent, delta: ev.delta });
            break;
          }
          case 'thinking':
            bus.emit({ type: 'reasoning_delta', sessionId, agent, delta: ev.delta });
            break;
          case 'tool_start':
            pushItem({ kind: 'tool', id: ev.id, name: ev.name, args: ev.args });
            bus.emit({ type: 'tool_start', sessionId, agent, callId: ev.id, name: ev.name, args: ev.args });
            break;
          case 'tool_end': {
            const t = [...step.transcript].reverse().find((x) => x.kind === 'tool' && x.id === ev.id);
            const result = ev.result.length > 2000 ? `${ev.result.slice(0, 2000)}…` : ev.result;
            if (t) {
              t.ok = ev.ok;
              t.result = result;
            } else pushItem({ kind: 'tool', id: ev.id, name: '(tool)', ok: ev.ok, result });
            bus.emit({ type: 'tool_end', sessionId, agent, callId: ev.id, name: t?.name ?? '(tool)', ok: ev.ok, result });
            break;
          }
          case 'billing':
            step.billing = ev.billing;
            if (ev.billing === 'api' && c.requirePlanBilling) {
              billingAbort = `${label(spec.member)} started on API billing (${ev.detail ?? 'API key'}), so LocalDex stopped it. Subscription-only is on.`;
              ac.abort();
            }
            break;
          case 'note':
            pushItem({ kind: 'note', text: ev.text });
            break;
        }
        persistSoon();
      },
    });
    ctx.signal.removeEventListener('abort', onParentAbort);

    step.billing = step.billing ?? res.billing;
    if (res.model) step.model = res.model;
    step.usage = res.usage;
    step.output = (res.text || '').slice(0, MAX_OUTPUT);
    if (billingAbort) {
      step.status = 'error';
      step.error = billingAbort;
    } else if (res.ok) {
      step.status = 'done';
      noteError(spec.member, undefined);
    } else if (res.cancelled || ctx.signal.aborted) {
      step.status = 'cancelled';
      step.error = res.error;
    } else if (res.limited) {
      step.status = 'limited';
      step.error = res.error;
      markLimited(spec.member, res.error ?? 'usage limit', res.limitResetsAt);
    } else {
      step.status = 'error';
      step.error = res.error;
      noteError(spec.member, res.error);
    }
    return step;
  } catch (e) {
    step.status = ctx.signal.aborted ? 'cancelled' : 'error';
    step.error = (e as Error).message;
    return step;
  } finally {
    step.endedAt = Date.now();
    recordStep(step, run);
    bus.emit({ type: 'turn_end', sessionId, agent });
    bus.emit({ type: 'agent_status', sessionId, agent, status: step.status === 'error' || step.status === 'limited' ? 'error' : 'idle', detail: step.error?.slice(0, 120) });
    ctx.persist();
  }
}

/**
 * Redact a cloud member's prompt and record it on the step. Counts markers already placed upstream
 * (git diff, chat history) too, so the step shows everything that was held back from this member.
 */
function redactForCloud(text: string, step: CouncilStep): string {
  const r = redactSecrets(text);
  const all = existingRedactions(r.text);
  if (all.count > 0) {
    step.redactions = all.count;
    step.transcript.push({ kind: 'note', text: `Removed ${all.count} secret${all.count === 1 ? '' : 's'} before sending (${describeKinds(all.kinds)})` });
  }
  return r.text;
}

/** Redact text bound for council members when the setting is on (default). */
export function redactIfEnabled(text: string): string {
  return getSettings().council.redactSecrets !== false ? redactSecrets(text).text : text;
}

// ---------- git helpers (read-only) ----------

interface GitSnap {
  repo: boolean;
  head: string;
  dirty: Set<string>;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

/** Files already modified before the builder started, so the reviewer sees only the builder's changes when possible. */
export function gitSnapshot(cwd: string): GitSnap {
  const inside = git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) return { repo: false, head: '', dirty: new Set() };
  const head = git(cwd, ['rev-parse', 'HEAD']).out.trim();
  const dirty = new Set(
    git(cwd, ['status', '--porcelain'])
      .out.split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean),
  );
  return { repo: true, head, dirty };
}

export function gitDiffSince(cwd: string, before: GitSnap): string {
  if (!before.repo) return '';
  const changed = git(cwd, ['status', '--porcelain'])
    .out.split('\n')
    .map((l) => ({ code: l.slice(0, 2), file: l.slice(3).trim() }))
    .filter((x) => x.file && !before.dirty.has(x.file));
  if (!changed.length) return before.dirty.size ? '(no new changes outside files that were already modified before this run)' : '';
  const tracked = changed.filter((x) => x.code !== '??').map((x) => x.file);
  const untracked = changed.filter((x) => x.code === '??').map((x) => x.file);
  let diff = tracked.length ? git(cwd, ['diff', '--no-color', 'HEAD', '--', ...tracked]).out : '';
  if (untracked.length) diff += `\nNew files:\n${untracked.map((f) => `+ ${f}`).join('\n')}`;
  // Redact before truncating so a cut can't leave half a key behind the marker.
  diff = redactIfEnabled(diff);
  return diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… [diff truncated]` : diff;
}

/** One-line summary of a run for chat labels: "claude → cursor → codex". */
export function runVia(run: CouncilRun): string {
  const names = run.steps.filter((s) => s.status === 'done').map((s) => label(s.member));
  return Array.from(new Set(names)).join(' → ') || 'council';
}

export function runSummary(run: CouncilRun): string {
  const dur = (s: CouncilStep) => (s.startedAt && s.endedAt ? ` · ${Math.round((s.endedAt - s.startedAt) / 1000)}s` : '');
  return [
    `pattern: ${run.pattern}${run.routeNote ? ` (${run.routeNote})` : ''}${run.risk ? ` · risk: ${run.risk}${run.riskReasons?.length ? ` (${run.riskReasons.join(', ')})` : ''}` : ''}`,
    ...run.steps.map((s) => `${s.status === 'done' ? '✓' : s.status === 'limited' ? '⏳' : s.status === 'cancelled' ? '■' : '✗'} ${s.role} → ${label(s.member)}${s.model ? ` (${s.model})` : ''} [${s.access}]${dur(s)}${s.error ? ` — ${s.error.slice(0, 200)}` : ''}`),
  ].join('\n');
}
