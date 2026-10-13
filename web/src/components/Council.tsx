import { useEffect, useId, useState } from 'react';
import {
  COUNCIL_ROLES,
  MEMBER_IDS,
  quorumLabel,
  type CouncilMemberRef,
  type CouncilMemberStats,
  type CouncilPattern,
  type CouncilPeerRank,
  type CouncilRisk,
  type CouncilRole,
  type CouncilRun,
  type CouncilSettings,
  type CouncilStep,
  type MemberId,
  type MemberStatus,
  type Settings,
} from '@localdex/shared';
import { send, useStore } from '../store';
import { Markdown } from './Message';
import { ToolCard } from './ToolCard';
import { Button, Field, Toggle, cx, fmtTokens, inputCls } from './ui';

// ---------- shared bits ----------

export const MEMBER_META: Record<CouncilMemberRef, { label: string; color: string }> = {
  claude: { label: 'Claude', color: '#e8a07a' },
  codex: { label: 'Codex', color: '#a9b6ff' },
  gemini: { label: 'Gemini', color: '#7cc0f2' },
  cursor: { label: 'Cursor', color: '#d6dde6' },
  local: { label: 'Local', color: '#7cf2c6' },
};

const PATTERN_LABEL: Record<CouncilPattern, string> = {
  single: 'Single member',
  plan_build_review: 'Plan → Build → Review',
  second_opinion: 'Build + second opinion',
  vote: 'Council vote',
};

const ROLE_HINT: Record<CouncilRole, string> = {
  planner: 'Writes the implementation plan (read-only)',
  builder: 'Makes the changes (edits only if allowed below)',
  frontend: 'Builds UI work: components, CSS, layout (edits like the builder)',
  backend: 'Builds API, database and server work (edits like the builder)',
  reviewer: 'Checks the diff, asks for fixes (read-only)',
  qa: 'Tries to break approved changes with edge cases (read-only)',
  researcher: 'Answers questions about the codebase (read-only)',
  vision: 'Looks at screenshots and mockups you mention (read-only)',
  quick: 'Short questions (local model first = free)',
};

const roleName = (role: string) => (role === 'qa' ? 'QA' : role);

/** Step-row labels that differ from the role id. */
const STEP_LABEL: Partial<Record<CouncilStep['role'], string>> = { peer: 'peer review', qa: 'QA' };
const STEP_HINT: Partial<Record<CouncilStep['role'], string>> = {
  voter: 'Answers the question independently (read-only)',
  peer: 'Ranks every answer blind, its own included, without knowing whose is whose (read-only)',
  judge: 'Combines the answers into one recommendation (read-only)',
  checks: "The project's own checks, run on your machine",
};

export function VendorBadge({ member, dim }: { member: CouncilMemberRef; dim?: boolean }) {
  const m = MEMBER_META[member];
  return (
    <span
      className={cx('inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded border', dim && 'opacity-60')}
      style={{ color: m.color, borderColor: `${m.color}55`, background: `${m.color}12` }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: m.color }} />
      {m.label}
    </span>
  );
}

/** "☁ claude → cursor → codex" label on assistant messages that came from the cloud. */
export function ViaBadge({ via }: { via: string }) {
  return (
    <div className="text-[11px] text-ink-400 mb-1 flex items-center gap-1.5" title="Written by cloud council members. The task and relevant files were sent to these vendors.">
      <span className="text-[#7cc0f2]">☁</span>
      <span className="font-mono">{via}</span>
    </div>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const STEP_STYLE: Record<CouncilStep['status'], string> = {
  queued: 'text-ink-400',
  running: 'text-warn pulse',
  done: 'text-accent',
  error: 'text-danger',
  limited: 'text-warn',
  skipped: 'text-ink-400',
  cancelled: 'text-ink-400',
};
const STEP_ICON: Record<CouncilStep['status'], string> = { queued: '○', running: '●', done: '✓', error: '✗', limited: '⏳', skipped: '–', cancelled: '■' };

// ---------- run card ----------

export function CouncilRunCard({ run, defaultOpen, compact }: { run: CouncilRun; defaultOpen?: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const riskRouting = useStore((s) => s.settings?.council.riskRouting ?? true);
  const running = run.status === 'running';
  const now = useNow(running);
  const tokens = run.steps.reduce((n, s) => n + (s.usage ? s.usage.inputTokens + s.usage.outputTokens : 0), 0);
  return (
    <div className={cx('rounded-lg border bg-ink-900/60', running ? 'border-warn/40' : run.status === 'error' ? 'border-danger/30' : 'border-ink-600')}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full text-left px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-ink-100">{PATTERN_LABEL[run.pattern]}</span>
          <span className={cx('text-[11px]', running ? 'text-warn pulse' : run.status === 'done' ? 'text-accent-dim' : run.status === 'error' ? 'text-danger' : 'text-ink-400')}>
            {running ? 'running' : run.status}
          </span>
          {run.risk && <RiskChip risk={run.risk} reasons={run.riskReasons ?? []} />}
          {run.quorum && (
            <span className={cx('text-[10px] truncate', run.quorum.dropped ? 'text-warn' : 'text-ink-400')} title="Advisers needed before the grace timer starts / advisers asked">
              {quorumLabel(run.quorum)}
            </span>
          )}
          <span className="flex-1" />
          <span className="text-[11px] text-ink-400">
            {dur((run.endedAt ?? now) - run.startedAt)}
            {tokens ? ` · ${fmtTokens(tokens)} tok` : ''}
          </span>
          <span className="text-ink-400 text-xs">{open ? '▾' : '▸'}</span>
        </div>
        {!compact && <div className="text-xs text-ink-300 truncate mt-0.5">{run.task.split('\n')[0]}</div>}
        <div className="flex flex-wrap items-center gap-1 mt-1.5">
          {run.steps.filter((s) => s.role !== 'peer').map((s, i) => (
            <span key={s.id} className="flex items-center gap-1">
              {i > 0 && <span className="text-ink-500 text-[10px]">→</span>}
              <VendorBadge member={s.member} dim={s.status !== 'done' && s.status !== 'running'} />
            </span>
          ))}
          {run.steps.length === 0 && running && <span className="text-[11px] text-ink-400 pulse">routing…</span>}
        </div>
      </button>
      {open && (
        <div className="border-t border-ink-700 px-3 py-2 space-y-2">
          {run.routeNote && <div className="text-[11px] text-ink-400">router: {run.routeNote}</div>}
          {run.risk === 'high' && riskRouting && (
            <div className="text-[11px] text-warn">High risk: planned and reviewed, built on the heavy model, and every edit needs your approval.</div>
          )}
          {run.steps.map((s) => (
            <StepRow key={s.id} step={s} now={now} defaultOpen={s.status === 'running'} />
          ))}
          {run.peerRanking && run.peerRanking.length > 0 && <PeerRanking ranking={run.peerRanking} />}
          {!running && run.status === 'error' && run.result && <div className="text-xs text-danger whitespace-pre-wrap">{run.result}</div>}
        </div>
      )}
    </div>
  );
}

function PeerRanking({ ranking }: { ranking: CouncilPeerRank[] }) {
  return (
    <div className="rounded-md border border-ink-700 bg-ink-950/40 px-2.5 py-1.5">
      <div className="text-[11px] text-ink-400 mb-1" title="Each adviser ranked every answer without knowing whose was whose. Combined with a Borda count; 1 is best.">
        Peer ranking (blind)
      </div>
      <ol className="space-y-0.5">
        {ranking.map((r, i) => (
          <li key={r.member} className="flex items-center gap-2 text-xs">
            <span className="w-4 text-right text-ink-400">{i + 1}.</span>
            <VendorBadge member={r.member} />
            <span className="text-ink-300">avg {r.avgRank.toFixed(1)}</span>
            <span className="text-[10px] text-ink-400">
              {r.votes} vote{r.votes === 1 ? '' : 's'}
              {r.selfRank ? ` · ranked itself #${r.selfRank}` : ''}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const RISK_CLS: Record<CouncilRisk, string> = {
  high: 'border-danger/40 bg-danger/10 text-danger',
  normal: 'border-ink-600 text-ink-300',
  low: 'border-ink-600 text-ink-400',
};

function RiskChip({ risk, reasons }: { risk: CouncilRisk; reasons: string[] }) {
  return (
    <span
      className={cx('rounded border px-1.5 py-px text-[10px] leading-4 truncate max-w-[14rem]', RISK_CLS[risk])}
      title={reasons.length ? `${risk} risk: ${reasons.join(', ')}` : `${risk} risk`}
    >
      {risk} risk{reasons.length ? ` · ${reasons.join(', ')}` : ''}
    </span>
  );
}

/** What the previous member handed over when it stopped mid-task. */
function HandoffBox({ handoff }: { handoff: NonNullable<CouncilStep['handoff']> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-ink-700 bg-ink-900/40">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full text-left px-2 py-1 flex items-center gap-1.5 text-[11px] text-ink-300 hover:text-ink-100">
        <span className="text-ink-500">{open ? '▾' : '▸'}</span>
        Handoff from <VendorBadge member={handoff.from} />
      </button>
      {open && <pre className="border-t border-ink-800 px-2 py-1.5 font-mono text-[11px] text-ink-200 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">{handoff.text}</pre>}
    </div>
  );
}

function StepRow({ step, now, defaultOpen }: { step: CouncilStep; now: number; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [showWork, setShowWork] = useState(false);
  const live = useStore((s) => s.live[`member:${step.id}`]);
  const running = step.status === 'running';
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);
  const toolCount = step.transcript.filter((t) => t.kind === 'tool').length;
  const elapsed = step.startedAt ? (step.endedAt ?? now) - step.startedAt : 0;

  return (
    <div className="rounded-md border border-ink-700 bg-ink-950/40">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full text-left px-2.5 py-1.5 flex items-center gap-2 text-xs">
        <span className={cx('w-3 text-center', STEP_STYLE[step.status])}>{STEP_ICON[step.status]}</span>
        <span className="text-ink-300 w-[76px] shrink-0 capitalize whitespace-nowrap" title={step.role in ROLE_HINT ? ROLE_HINT[step.role as CouncilRole] : STEP_HINT[step.role]}>
          {STEP_LABEL[step.role] ?? step.role}
        </span>
        <VendorBadge member={step.member} />
        {step.model && <span className="font-mono text-[10px] text-ink-400 truncate max-w-[90px]">{step.model}</span>}
        <span
          className={cx('text-[10px] px-1 rounded', step.access === 'write' ? 'bg-warn/15 text-warn' : 'bg-ink-700 text-ink-300')}
          title={step.access === 'write' ? 'May edit files in the project folder' : 'Read-only'}
        >
          {step.access === 'write' ? 'edits' : 'read'}
        </span>
        {step.billing === 'api' && <span className="text-[10px] text-danger" title="This run was billed to an API key">API</span>}
        {!!step.redactions && (
          <span className="text-[10px] px-1 rounded bg-accent/15 text-accent whitespace-nowrap" title="Keys, tokens or passwords were replaced with [REDACTED] before this member saw the prompt">
            {step.redactions} {step.redactions === 1 ? 'secret' : 'secrets'} removed
          </span>
        )}
        {step.continued && (
          <span className="text-[10px] px-1 rounded bg-ink-700 text-ink-300 whitespace-nowrap" title="Picked up this member's own session from the previous message; only the new message was sent">
            continued session
          </span>
        )}
        <span className="flex-1" />
        <span className="text-[10px] text-ink-400 whitespace-nowrap shrink-0">
          {elapsed ? dur(elapsed) : ''}
          {step.usage ? ` · ${fmtTokens(step.usage.inputTokens + step.usage.outputTokens)}` : ''}
        </span>
        <span className="text-ink-500">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="border-t border-ink-800 px-2.5 py-2 text-sm space-y-2">
          {step.note && <div className="text-[11px] text-ink-400">{step.note}</div>}
          {step.error && <div className={cx('text-xs whitespace-pre-wrap break-words', step.status === 'limited' || step.status === 'skipped' ? 'text-warn' : 'text-danger')}>{step.error}</div>}
          {step.handoff && <HandoffBox handoff={step.handoff} />}
          {running && live ? (
            <>
              {live.content && (
                <div className="text-ink-100 text-[13px]">
                  <Markdown text={live.content} />
                  <span className="inline-block w-2 h-3.5 bg-accent ml-0.5 align-text-bottom pulse" />
                </div>
              )}
              {live.tools.map((t) => (
                <ToolCard key={t.callId} name={t.name} args={t.args} result={t.result} ok={t.ok} startedAt={t.startedAt} />
              ))}
              {!live.content && !live.tools.length && <div className="text-xs text-ink-400 pulse">starting {MEMBER_META[step.member].label}…</div>}
            </>
          ) : (
            <>
              {step.output && (
                <div className="text-ink-100 text-[13px] max-h-[50vh] overflow-y-auto">
                  {step.role === 'checks' ? <pre className="text-[11px] font-mono whitespace-pre-wrap break-words text-ink-200">{step.output}</pre> : <Markdown text={step.output} />}
                </div>
              )}
              {running && !step.output && <div className="text-xs text-ink-400 pulse">working…</div>}
              {step.transcript.length > 0 && (
                <div>
                  <button type="button" className="text-[11px] text-ink-400 hover:text-ink-200" onClick={() => setShowWork((w) => !w)}>
                    {showWork ? '▾' : '▸'} work log ({toolCount} tool call{toolCount === 1 ? '' : 's'})
                  </button>
                  {showWork && (
                    <div className="mt-1 space-y-1">
                      {step.transcript.map((t, i) =>
                        t.kind === 'tool' ? (
                          <ToolCard key={i} name={t.name ?? 'tool'} args={t.args} result={t.result ?? (running ? undefined : '(no result)')} ok={t.ok} />
                        ) : t.kind === 'text' && t.text ? (
                          <div key={i} className="text-xs text-ink-300 whitespace-pre-wrap border-l-2 border-ink-700 pl-2">
                            {t.text.length > 1200 ? `${t.text.slice(0, 1200)}…` : t.text}
                          </div>
                        ) : null,
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- right panel ----------

function memberState(st: MemberStatus | undefined, cfg: CouncilSettings['members'][MemberId], now: number): { text: string; tone: 'ok' | 'warn' | 'bad' | 'off' } {
  if (!cfg.enabled) return { text: 'off', tone: 'off' };
  if (!st) return { text: 'checking…', tone: 'off' };
  if (!st.installed) return { text: 'not installed', tone: 'bad' };
  if (!st.signedIn) return { text: 'not signed in', tone: 'warn' };
  if (st.limitedUntil && st.limitedUntil > now) return { text: `limit · back ${new Date(st.limitedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, tone: 'warn' };
  if (st.billing === 'api') return { text: 'API key ⚠', tone: 'bad' };
  return { text: st.billing === 'plan' ? 'ready · plan' : 'ready', tone: 'ok' };
}

const TONE: Record<string, string> = { ok: 'text-accent', warn: 'text-warn', bad: 'text-danger', off: 'text-ink-400' };

export function CouncilPanel({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const settings = useStore((s) => s.settings);
  const statuses = useStore((s) => s.council);
  const session = useStore((s) => s.session);
  const now = useNow(true);
  if (!settings || !session) return null;
  const c = settings.council;
  const runs = [...(session.councilRuns ?? [])].reverse();
  const hasMemberSessions = Object.keys(session.memberSessions ?? {}).length > 0;

  if (!c.enabled) {
    return (
      <div className="text-xs text-ink-400 leading-relaxed space-y-2">
        <p>The model council lets LocalDex hand work to Claude, Codex, Gemini and Cursor through their own CLIs/SDK on your subscription logins: route by task, tag-team (plan → build → review) or vote.</p>
        {onOpenSettings && (
          <Button size="sm" variant="primary" onClick={onOpenSettings}>
            Set up in Settings → Council
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] text-ink-400">Members</span>
          <button type="button" className="text-[11px] text-ink-400 hover:text-ink-100" onClick={() => send({ type: 'council_refresh' })} title="Re-check install and sign-in">
            ↻ check
          </button>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {MEMBER_IDS.map((id) => {
            const st = statuses.find((s) => s.id === id);
            const state = memberState(st, c.members[id], now);
            return (
              <div key={id} className="rounded-md border border-ink-700 bg-ink-900/60 px-2 py-1.5" title={st?.lastError ?? st?.path ?? ''}>
                <VendorBadge member={id} dim={state.tone === 'off'} />
                <div className={cx('text-[11px] mt-1', TONE[state.tone])}>{state.text}</div>
              </div>
            );
          })}
        </div>
      </div>

      <Scorecard />

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] text-ink-400">Runs {runs.length ? `(${runs.length})` : ''}</span>
          {hasMemberSessions && (
            <button
              type="button"
              className="text-[11px] text-ink-400 hover:text-ink-100"
              onClick={() => send({ type: 'council_new_conversation', sessionId: session.id })}
              title={`Members forget this chat's sessions (${Object.keys(session.memberSessions ?? {}).join(', ')}); the next message starts fresh with the chat history`}
            >
              New conversation with members
            </button>
          )}
        </div>
        {runs.length === 0 ? (
          <div className="text-xs text-ink-400 leading-relaxed">
            No council runs yet. Switch the top bar to <b className="text-ink-200">Council</b> and send a message, or let the local agent call <code className="font-mono">ask_member</code>.
            <div className="mt-2 font-mono text-[11px] text-ink-300 space-y-0.5">
              <div>/ask claude explain src/auth</div>
              <div>/build add rate limiting to the API</div>
              <div>/review the last change</div>
              <div>/vote zod or valibot for validation?</div>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {runs.map((r, i) => (
              <CouncilRunCard key={r.id} run={r} defaultOpen={i === 0} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- scorecard ----------

const DASH = '—';
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : DASH);

function roleBreakdown(m: CouncilMemberStats): string {
  const lines = Object.entries(m.byRole)
    .filter(([, c]) => c && (c.runs || c.skipped))
    .map(([role, c]) => `${role}: ${c!.done}/${c!.runs} ok${c!.limited ? `, ${c!.limited} limit` : ''}${c!.skipped ? `, ${c!.skipped} declined` : ''}`);
  const b = m.builder;
  if (b.approvedFirst + b.approvedAfterFixes + b.changesRequested) lines.push(`builds: ${b.approvedFirst} approved first try, ${b.approvedAfterFixes} after fixes, ${b.changesRequested} still had changes`);
  if (m.reviewer.none) lines.push(`reviews without a verdict: ${m.reviewer.none}`);
  if (m.voter.answers) lines.push(`votes: ${m.voter.answers} answers, avg ${Math.round(m.voter.answerChars / m.voter.answers)} chars`);
  if (m.peerRanking.count) lines.push(`peer rank: avg ${(m.peerRanking.rankSum / m.peerRanking.count).toFixed(1)} of ${(m.peerRanking.ofSum / m.peerRanking.count).toFixed(1)}`);
  return lines.join('\n');
}

function ScoreRow({ id, m }: { id: CouncilMemberRef; m?: CouncilMemberStats }) {
  const has = !!m && m.runs > 0;
  // Success counts finished attempts only; cancellations were your call, not the member's.
  const finished = m ? m.done + m.errors + m.limited : 0;
  const builds = m ? m.builder.approvedFirst + m.builder.approvedAfterFixes + m.builder.changesRequested : 0;
  const reviews = m ? m.reviewer.approve + m.reviewer.changes : 0;
  const tokens = m ? m.inputTokens + m.outputTokens : 0;
  return (
    <tr className="border-t border-ink-800" title={m ? roleBreakdown(m) : ''}>
      <td className="py-1 pr-1.5">
        <VendorBadge member={id} dim={!has} />
      </td>
      <td className="text-right px-1">{has ? m!.runs : DASH}</td>
      <td className={cx('text-right px-1', has && finished > 0 && m!.done / finished < 0.7 && 'text-warn')}>{has ? pct(m!.done, finished) : DASH}</td>
      <td className="text-right px-1">{has ? dur(m!.durationMs / m!.runs) : DASH}</td>
      <td className="text-right px-1">{tokens ? fmtTokens(tokens) : DASH}</td>
      <td className={cx('text-right px-1', !!m?.limited && 'text-warn')}>{has ? m!.limited : DASH}</td>
      <td className="text-right px-1" title={builds ? `${m!.builder.approvedFirst} first try · ${m!.builder.approvedAfterFixes} after fixes · ${m!.builder.changesRequested} still changes` : ''}>
        {pct(m ? m.builder.approvedFirst + m.builder.approvedAfterFixes : 0, builds)}
      </td>
      <td className="text-right pl-1">{reviews ? `${m!.reviewer.approve}/${m!.reviewer.changes}` : DASH}</td>
    </tr>
  );
}

function Scorecard() {
  const stats = useStore((s) => s.councilStats);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);
  const any = !!stats && Object.values(stats.members).some((m) => m && (m.runs || m.skipped));

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] text-ink-400" title={stats ? `Counting since ${new Date(stats.since).toLocaleString()}` : ''}>
          Scorecard
        </span>
        {any && (
          <button
            type="button"
            className={cx('text-[11px]', confirming ? 'text-danger font-medium' : 'text-ink-400 hover:text-ink-100')}
            onClick={() => {
              if (!confirming) return setConfirming(true);
              setConfirming(false);
              send({ type: 'council_stats_reset' });
            }}
            title="Clear all member stats"
          >
            {confirming ? 'Click again to clear' : 'Reset'}
          </button>
        )}
      </div>
      {!any ? (
        <div className="text-xs text-ink-400">No stats yet. Each member's runs, success rate, time and tokens show up here after council runs.</div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-ink-700 bg-ink-900/60 px-2 py-1">
          <table className="w-full text-[11px] tabular-nums text-ink-200 whitespace-nowrap">
            <thead>
              <tr className="text-ink-400 text-[10px]">
                <th className="text-left font-normal pb-1">Member</th>
                <th className="text-right font-normal px-1" title="Steps started (declined edits not counted)">Runs</th>
                <th className="text-right font-normal px-1" title="Finished OK, out of runs that weren't cancelled">OK</th>
                <th className="text-right font-normal px-1" title="Average time per run">Avg</th>
                <th className="text-right font-normal px-1" title="Input + output tokens">Tok</th>
                <th className="text-right font-normal px-1" title="Usage-limit hits">Lim</th>
                <th className="text-right font-normal px-1" title="Plan → build → review: builds the reviewer approved">Build</th>
                <th className="text-right font-normal pl-1" title="As reviewer: approved / asked for changes">Rev</th>
              </tr>
            </thead>
            <tbody>
              {REFS.map((id) => (
                <ScoreRow key={id} id={id} m={stats!.members[id]} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- settings tab ----------

type TabProps = { settings: Settings; patch: (p: Partial<Settings>) => void };
const REFS: CouncilMemberRef[] = ['claude', 'codex', 'gemini', 'cursor', 'local'];

export function CouncilSettingsTab({ settings, patch }: TabProps) {
  const c = settings.council;
  const statuses = useStore((s) => s.council);
  const login = useStore((s) => s.councilLogin);
  const setC = (p: Partial<CouncilSettings>) => patch({ council: { ...c, ...p } });
  const setMember = (id: MemberId, p: Partial<CouncilSettings['members'][MemberId]>) => setC({ members: { ...c.members, [id]: { ...c.members[id], ...p } } });
  const setRole = (role: CouncilRole, idx: number, ref: CouncilMemberRef | '') => {
    const list = [...c.roles[role]];
    if (ref) list[idx] = ref;
    else list.splice(idx, 1);
    setC({ roles: { ...c.roles, [role]: Array.from(new Set(list.filter(Boolean))) } });
  };
  const now = Date.now();

  return (
    <>
      <div>
        <h3 className="font-medium">Model council</h3>
        <p className="text-xs text-ink-400 mt-1">
          Hands work to cloud models through each vendor's own CLI or SDK, on the subscription you are signed into there. LocalDex never sees your passwords or keys and removes API-key variables before starting a member, so nothing is billed to an API account.
        </p>
      </div>
      <Toggle label="Enable the model council" checked={c.enabled} onChange={(v) => setC({ enabled: v })} />
      <div className="text-xs text-warn bg-warn/10 border border-warn/30 rounded-md px-3 py-2">
        Members run in the cloud: the task text and any files a member reads are sent to that vendor. Use it only on projects you are comfortable sharing with them.
      </div>

      <h4 className="text-sm font-medium pt-2">Members</h4>
      <ul className="space-y-2">
        {MEMBER_IDS.map((id) => {
          const st = statuses.find((s) => s.id === id);
          const cfg = c.members[id];
          const state = memberState(st, cfg, now);
          return (
            <li key={id} className="bg-ink-800 rounded-md px-3 py-2 space-y-2">
              <div className="flex items-center gap-3">
                <VendorBadge member={id} />
                <span className={cx('text-xs', TONE[state.tone])}>{state.text}</span>
                <span className="flex-1 text-[11px] text-ink-400 truncate font-mono">{st?.version ?? ''}</span>
                <div className="w-14 shrink-0">
                  <Toggle label="" checked={cfg.enabled} onChange={(v) => setMember(id, { enabled: v })} />
                </div>
              </div>
              {st && (
                <div className="text-[11px] text-ink-400 space-y-0.5">
                  {st.path && <div className="font-mono truncate">{st.path}</div>}
                  {st.account && <div>account: {st.account}</div>}
                  {st.signedIn && <div>billing: {st.billing === 'plan' ? 'your subscription' : st.billing === 'api' ? <span className="text-danger">API key (blocked while “Subscription only” is on)</span> : 'could not tell'}</div>}
                  {st.lastError && <div className="text-danger break-words">{st.lastError}</div>}
                </div>
              )}
              {st && (!st.installed || !st.signedIn || st.billing === 'api') && (
                <div className="text-xs">
                  {st.canLoginInApp ? (
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="primary" disabled={!st.installed} onClick={() => send({ type: 'council_login', member: id })}>
                        Sign in to {MEMBER_META[id].label}
                      </Button>
                      {login?.member === id && !login.done && <span className="text-ink-400 pulse">waiting for the browser…</span>}
                      {login?.member === id && login.error && <span className="text-danger">{login.error}</span>}
                    </div>
                  ) : (
                    <div>
                      <span className="text-ink-400">{st.installed ? 'Sign in from Terminal:' : 'Install, then sign in from Terminal:'}</span>
                      <CopyCode text={st.installed ? st.loginCommand : `${INSTALL[id]}\n${st.loginCommand}`} />
                    </div>
                  )}
                  {login?.member === id && login.url && !login.done && (
                    <div className="mt-1 text-[11px] text-ink-400 break-all">
                      If no browser opened: <a className="text-accent underline" href={login.url} target="_blank" rel="noreferrer">{login.url}</a>
                    </div>
                  )}
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <ModelInput label="Model" value={cfg.model ?? ''} placeholder={id === 'cursor' ? 'auto' : 'CLI default'} suggestions={modelOptions(id, st)} onCommit={(v) => setMember(id, { model: v || undefined })} />
                <ModelInput label="Heavy model (plan/review/judge)" value={cfg.heavyModel ?? ''} placeholder="same as model" suggestions={modelOptions(id, st)} onCommit={(v) => setMember(id, { heavyModel: v || undefined })} />
              </div>
            </li>
          );
        })}
      </ul>
      <HealthReport statuses={statuses} />

      <h4 className="text-sm font-medium pt-2">Roles</h4>
      <p className="text-xs text-ink-400 -mt-2">For each role, members are tried left to right. A member that is off, signed out or at its usage limit is skipped automatically.</p>
      <div className="space-y-2">
        {COUNCIL_ROLES.map((role) => (
          <div key={role} className="grid grid-cols-[110px_1fr] gap-3 items-center">
            <div>
              <div className="text-sm capitalize">{roleName(role)}</div>
              <div className="text-[10px] text-ink-400 leading-tight">{ROLE_HINT[role]}</div>
            </div>
            <div className="flex gap-1.5">
              {[0, 1, 2].map((idx) => (
                <select key={idx} className={cx(inputCls, 'text-xs py-1')} value={c.roles[role][idx] ?? ''} onChange={(e) => setRole(role, idx, e.target.value as CouncilMemberRef | '')} disabled={idx > c.roles[role].length}>
                  <option value="">{idx === 0 ? '(none)' : '—'}</option>
                  {REFS.filter((r) => r === c.roles[role][idx] || !c.roles[role].includes(r)).map((r) => (
                    <option key={r} value={r}>
                      {MEMBER_META[r].label}
                    </option>
                  ))}
                </select>
              ))}
            </div>
          </div>
        ))}
      </div>

      <h4 className="text-sm font-medium pt-2">Behavior</h4>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Council mode handles messages with" hint="'Auto' routes each message by what it asks for. Slash commands (/ask, /build, /review, /vote) always win.">
          <select className={inputCls} value={c.defaultPattern} onChange={(e) => setC({ defaultPattern: e.target.value as CouncilSettings['defaultPattern'] })}>
            <option value="auto">Auto (router decides)</option>
            <option value="single">One member per message</option>
            <option value="plan_build_review">Plan → Build → Review</option>
            <option value="second_opinion">Build + second opinion</option>
            <option value="vote">Council vote</option>
          </select>
        </Field>
        <Field label="Router" hint="Rules are instant and free. The local model can classify fuzzier requests.">
          <select className={inputCls} value={c.routing} onChange={(e) => setC({ routing: e.target.value as CouncilSettings['routing'] })}>
            <option value="rules">Keyword rules</option>
            <option value="local">Local model (falls back to rules)</option>
          </select>
        </Field>
        <Field label="Vote judge" hint="Combines the advisers' answers.">
          <select className={inputCls} value={c.judge} onChange={(e) => setC({ judge: e.target.value as CouncilMemberRef })}>
            {REFS.map((r) => (
              <option key={r} value={r}>
                {MEMBER_META[r].label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Vote members">
          <div className="flex flex-wrap gap-3 pt-1">
            {MEMBER_IDS.map((id) => (
              <label key={id} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={c.voteMembers.includes(id)}
                  onChange={(e) => setC({ voteMembers: e.target.checked ? [...c.voteMembers, id] : c.voteMembers.filter((x) => x !== id) })}
                />
                {MEMBER_META[id].label}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Vote quorum" hint="Answers needed before the grace timer starts.">
          <input
            type="number"
            min={1}
            max={Math.max(1, c.voteMembers.length)}
            className={inputCls}
            value={c.voteQuorum}
            onChange={(e) => setC({ voteQuorum: Math.max(1, Math.min(Math.max(1, c.voteMembers.length), Math.round(Number(e.target.value)) || 1)) })}
          />
        </Field>
        <Field label="Vote grace period (seconds)" hint="After quorum, how long to wait for the rest. Slower advisers are then stopped.">
          <input
            type="number"
            min={0}
            max={600}
            className={inputCls}
            value={c.voteGraceSeconds}
            onChange={(e) => setC({ voteGraceSeconds: Math.max(0, Math.min(600, Math.round(Number(e.target.value)) || 0)) })}
          />
        </Field>
        <Field label="Review → fix rounds" hint="How many times the builder may fix issues the reviewer finds.">
          <input type="number" min={0} max={3} className={inputCls} value={c.maxFixRounds} onChange={(e) => setC({ maxFixRounds: Math.max(0, Math.min(3, Number(e.target.value))) })} />
        </Field>
        <Field label="Timeout per member run (minutes)">
          <input type="number" min={1} max={120} className={inputCls} value={c.timeoutMinutes} onChange={(e) => setC({ timeoutMinutes: Math.max(1, Number(e.target.value)) })} />
        </Field>
        <Field label="Check command" hint="Runs in the project folder after each build, before review. Leave empty to detect typecheck, lint and test scripts, pytest, cargo or go.">
          <input type="text" className={cx(inputCls, 'font-mono text-xs')} placeholder="auto-detect" value={c.checkCommand ?? ''} disabled={c.checksGate === false} onChange={(e) => setC({ checkCommand: e.target.value })} />
        </Field>
        <Field label="Checks timeout (minutes)">
          <input type="number" min={1} max={120} className={inputCls} value={c.checkTimeoutMinutes ?? 10} disabled={c.checksGate === false} onChange={(e) => setC({ checkTimeoutMinutes: Math.max(1, Math.min(120, Number(e.target.value) || 10)) })} />
        </Field>
      </div>
      <div className="space-y-1 pt-1">
        <Toggle label="Let builders (builder, frontend, backend) edit files in approved folders" checked={c.allowWrite} onChange={(v) => setC({ allowWrite: v })} />
        <div className={cx(!c.allowWrite && 'opacity-40 pointer-events-none')}>
          <Toggle label="Ask me before each member that can edit files" checked={c.confirmWrites} onChange={(v) => setC({ confirmWrites: v })} />
        </div>
        <Toggle label="Run the project's checks before review (asks before running)" checked={c.checksGate !== false} onChange={(v) => setC({ checksGate: v })} />
        <Toggle label="QA tries to break approved changes" checked={c.qaStep !== false} onChange={(v) => setC({ qaStep: v })} />
        <Toggle label="Always plan and review risky changes" checked={c.riskRouting} onChange={(v) => setC({ riskRouting: v })} />
        <Toggle label="Advisers rank each other's answers (blind) before the judge" checked={c.peerReview !== false} onChange={(v) => setC({ peerReview: v })} />
        <Toggle label="Subscription only (refuse members signed in with an API key)" checked={c.requirePlanBilling} onChange={(v) => setC({ requirePlanBilling: v })} />
        <Toggle label="Remove secrets before sending to members" checked={c.redactSecrets !== false} onChange={(v) => setC({ redactSecrets: v })} />
        <Toggle label="Suggest asking the council when the local model is stuck" checked={c.consultNudges} onChange={(v) => setC({ consultNudges: v })} />
        <Toggle label="Continue a member's own session on follow-up messages" checked={c.continueSessions !== false} onChange={(v) => setC({ continueSessions: v })} />
      </div>
      <p className="text-[11px] text-ink-400">
        Blind ranking adds one extra read-only run per adviser in each vote: every adviser sees all answers as Response A, B, C… without names, ranks them, and the judge gets the combined ranking.
        When you follow up with the same member in Council mode, it picks up its own earlier session (files it read, its reasoning) and gets only your new message instead of the pasted chat history. Plan → build → review and votes always start fresh.
      </p>
      <p className="text-[11px] text-ink-400">
        Removing secrets replaces API keys, tokens, passwords and private keys in prompts, chat history and diffs with [REDACTED] before they reach a cloud member. Members can still open files in the project folder themselves.
      </p>
      <p className="text-[11px] text-ink-400">
        Risky changes are ones that touch auth, payments, secrets, database migrations, deploy config, git history, or delete data. With the risky-changes switch on they always go plan → build → review, the builder uses its heavy model, and you approve every edit. With edits off, every member is read-only: planners plan, reviewers review, and change requests come back as proposals. Members never get LocalDex's own tools; they use their vendor's tools inside the project folder. To point a member at a specific executable, set <span className="font-mono">council.members.&lt;name&gt;.command</span> in <span className="font-mono">~/.localdex/config.json</span>.
      </p>
      <details className="pt-1">
        <summary className="text-xs text-ink-300 cursor-pointer select-none">Advanced</summary>
        <div className="space-y-2 pt-2">
          <Toggle label="Trust project config (load the project's own agent settings)" checked={c.trustProjectConfig} onChange={(v) => setC({ trustProjectConfig: v })} />
          <div className="text-xs text-warn bg-warn/10 border border-warn/30 rounded-md px-3 py-2">
            Only turn this on for repos you trust. When on, members load the folder's <span className="font-mono">.claude/settings.json</span> hooks, <span className="font-mono">.mcp.json</span> servers and Cursor project settings, and Gemini runs with <span className="font-mono">--skip-trust</span>. A cloned repo can use these to run commands or slip in instructions. Off: members use only your own config, and Gemini runs only in folders you have trusted in Gemini.
          </div>
        </div>
      </details>
    </>
  );
}

const INSTALL: Record<MemberId, string> = {
  claude: 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex',
  gemini: 'npm i -g @google/gemini-cli',
  cursor: 'npm install   # in the LocalDex folder (installs @cursor/sdk)',
};

/** Fallback picks when a member has not listed its models yet. */
const SUGGEST: Record<MemberId, string[]> = {
  claude: ['sonnet', 'opus', 'haiku'],
  codex: [],
  gemini: [],
  cursor: ['auto', 'composer-2.5'],
};

type ModelOption = { value: string; note: string };

/** The member's own list first (labelled by where it came from), then the built-in picks it did not already include. */
function modelOptions(id: MemberId, st: MemberStatus | undefined): ModelOption[] {
  const listed = st?.models ?? [];
  const note = st?.modelsSource === 'account' ? 'from your account' : 'suggested';
  const seen = new Set(listed);
  return [...listed.map((value) => ({ value, note })), ...SUGGEST[id].filter((m) => !seen.has(m)).map((value) => ({ value, note: 'suggested' }))];
}

function HealthReport({ statuses }: { statuses: MemberStatus[] }) {
  // The health check is done once a status arrives with a newer healthCheckedAt than when we asked.
  const lastRun = Math.max(0, ...statuses.map((s) => s.healthCheckedAt ?? 0));
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const running = pendingSince !== null && lastRun <= pendingSince;
  useEffect(() => {
    if (pendingSince !== null && lastRun > pendingSince) setPendingSince(null);
  }, [lastRun, pendingSince]);
  const run = () => {
    setPendingSince(lastRun);
    send({ type: 'council_refresh', deep: true });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end gap-3">
        {lastRun > 0 && <span className="text-[11px] text-ink-400">Last health check {new Date(lastRun).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>}
        <Button size="sm" onClick={() => send({ type: 'council_refresh' })} disabled={running}>
          ↻ Re-check members
        </Button>
        <Button size="sm" onClick={run} disabled={running}>
          {running ? 'Checking…' : 'Run health check'}
        </Button>
      </div>
      {lastRun > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {MEMBER_IDS.map((id) => {
            const st = statuses.find((s) => s.id === id);
            return (
              <div key={id} className="rounded-md border border-ink-700 bg-ink-900/60 px-2.5 py-2">
                <div className="text-xs font-medium mb-1" style={{ color: MEMBER_META[id].color }}>
                  {MEMBER_META[id].label}
                </div>
                <ul className="space-y-0.5">
                  {(st?.checks ?? []).map((c) => (
                    <li key={c.name} className="flex gap-1.5 text-[11px] leading-snug">
                      <span className={cx('shrink-0 w-3', c.ok ? 'text-accent' : 'text-danger')} aria-label={c.ok ? 'passed' : 'failed'}>
                        {c.ok ? '✓' : '✗'}
                      </span>
                      <span className="text-ink-100 shrink-0">{c.name}</span>
                      {c.detail && (
                        <span className="text-ink-400 truncate" title={c.detail}>
                          {c.detail}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ModelInput({ label, value, placeholder, suggestions, onCommit }: { label: string; value: string; placeholder: string; suggestions: ModelOption[]; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  // One datalist per input: each member has its own model list.
  const id = `dl-${useId().replace(/\W+/g, '')}`;
  const fromAccount = suggestions.filter((s) => s.note === 'from your account').length;
  return (
    <label className="block">
      <span className="text-[11px] text-ink-400">
        {label}
        {fromAccount > 0 && <span> · {fromAccount} from your account</span>}
      </span>
      <input
        className={cx(inputCls, 'text-xs py-1 font-mono')}
        value={v}
        placeholder={placeholder}
        list={suggestions.length ? id : undefined}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v.trim() !== value && onCommit(v.trim())}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {suggestions.length > 0 && (
        <datalist id={id}>
          {suggestions.map((s) => (
            <option key={s.value} value={s.value} label={s.note} />
          ))}
        </datalist>
      )}
    </label>
  );
}

function CopyCode({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2 mt-1">
      <pre className="flex-1 font-mono text-[11px] bg-ink-950 rounded px-2 py-1 whitespace-pre-wrap">{text}</pre>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          void navigator.clipboard?.writeText(text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? 'copied' : 'copy'}
      </Button>
    </div>
  );
}
