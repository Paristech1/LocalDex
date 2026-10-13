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
import { getSettings } from '../config.js';
import { bus } from '../agent/bus.js';
import { approvedFolders } from '../tools/permissions.js';
import { MEMBERS, markLimited, memberStatuses, noteError } from './registry.js';
import { availableMembers, modelFor, pickMember, unavailableReason, withRisk, type Route } from './router.js';
import {
  builderPrompt,
  critiquePrompt,
  fixPrompt,
  judgePrompt,
  memberInstructions,
  parseVerdict,
  plannerPrompt,
  reviewerPrompt,
  votePrompt,
} from './prompts.js';

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
        run.result = await planBuildReview(ctx, run, route.task, statuses);
        break;
      case 'second_opinion':
        run.result = await secondOpinion(ctx, run, route.task, statuses);
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
  if (route.member) {
    const why = unavailableReason(route.member, statuses);
    if (why) return `${label(route.member)} can't take this: ${why}.`;
    const step = await runStep(ctx, run, { role: route.role, member: route.member, access, prompt: route.task, note: 'requested' });
    return stepAnswer(step);
  }
  const step = await runRole(ctx, run, route.role, access, route.task, statuses);
  return step ? stepAnswer(step) : noMemberMessage(route.role, statuses);
}

async function planBuildReview(ctx: CouncilContext, run: CouncilRun, task: string, statuses: MemberStatus[]): Promise<string> {
  const c = getSettings().council;
  const cwd = approvedFolders()[0];
  const out: string[] = [];
  const maxFixRounds = isRiskyRun(run) ? Math.max(1, c.maxFixRounds) : c.maxFixRounds;

  const plan = await runRole(ctx, run, 'planner', 'read', plannerPrompt(task), statuses);
  const planText = plan?.status === 'done' ? plan.output ?? '' : '';
  if (ctx.signal.aborted) return 'Cancelled.';

  const before = gitSnapshot(cwd);
  let builder = await runRole(ctx, run, 'builder', accessFor('builder'), builderPrompt(task, planText || undefined), statuses);
  if (!builder || builder.status !== 'done') {
    return [`**The build step did not complete.** ${builder?.error ?? noMemberMessage('builder', statuses)}`, planText ? `### Plan (${label(plan!.member)})\n${planText}` : ''].filter(Boolean).join('\n\n');
  }
  if (ctx.signal.aborted) return 'Cancelled.';

  let report = builder.output ?? '';
  let review: CouncilStep | null = null;
  let verdict: 'approve' | 'changes' | 'unknown' = 'unknown';
  for (let round = 0; round <= maxFixRounds; round++) {
    const diff = gitDiffSince(cwd, before);
    review = await runRole(ctx, run, 'reviewer', 'read', reviewerPrompt(task, report, diff, planText || undefined), statuses, [builder.member]);
    if (!review || review.status !== 'done') break;
    verdict = parseVerdict(review.output ?? '');
    if (verdict !== 'changes' || round === maxFixRounds || ctx.signal.aborted) break;
    const fix = await runStep(ctx, run, { role: 'builder', member: builder.member, access: accessFor('builder'), prompt: fixPrompt(task, review.output ?? ''), note: `fix round ${round + 1}` });
    if (fix.status !== 'done') break;
    builder = fix;
    report = `${report}\n\nFix round ${round + 1}:\n${fix.output ?? ''}`;
  }

  const v = verdict === 'approve' ? '✅ Approved' : verdict === 'changes' ? '⚠️ Changes still requested' : review?.status === 'done' ? 'Reviewed (no explicit verdict)' : '⚠️ Not reviewed';
  out.push(`**${v}**${review?.status === 'done' ? ` by ${label(review.member)}` : ''} · built by ${label(builder.member)}${plan?.status === 'done' ? ` · planned by ${label(plan.member)}` : ''}`);
  out.push(`### What changed\n${report || '(no report)'}`);
  if (review?.status === 'done') out.push(`### Review\n${(review.output ?? '').replace(/^\s*VERDICT:\s*\S+\s*\n?/i, '').trim()}`);
  if (planText) out.push(`### Plan\n${planText}`);
  return out.join('\n\n');
}

async function secondOpinion(ctx: CouncilContext, run: CouncilRun, task: string, statuses: MemberStatus[]): Promise<string> {
  const cwd = approvedFolders()[0];
  const before = gitSnapshot(cwd);
  const builder = await runRole(ctx, run, 'builder', accessFor('builder'), builderPrompt(task), statuses);
  if (!builder || builder.status !== 'done') return `**The build step did not complete.** ${builder?.error ?? noMemberMessage('builder', statuses)}`;
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
  return role === 'builder' && getSettings().council.allowWrite ? 'write' : 'read';
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
  role: CouncilStep['role'];
  member: CouncilMemberRef;
  access: CouncilAccess;
  prompt: string;
  note?: string;
}

async function runStep(ctx: CouncilContext, run: CouncilRun, spec: StepSpec): Promise<CouncilStep> {
  const c = getSettings().council;
  const sessionId = ctx.session.id;
  const risky = isRiskyRun(run);
  const heavyBuild = risky && spec.role === 'builder';
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

    // Child controller so a mid-run billing surprise can stop just this member.
    const ac = new AbortController();
    const onParentAbort = () => ac.abort();
    ctx.signal.addEventListener('abort', onParentAbort, { once: true });
    let billingAbort = '';

    const res = await MEMBERS[spec.member].run({
      prompt: spec.prompt,
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
    bus.emit({ type: 'turn_end', sessionId, agent });
    bus.emit({ type: 'agent_status', sessionId, agent, status: step.status === 'error' || step.status === 'limited' ? 'error' : 'idle', detail: step.error?.slice(0, 120) });
    ctx.persist();
  }
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
