import { useEffect, useState } from 'react';
import {
  COUNCIL_ROLES,
  MEMBER_IDS,
  type CouncilMemberRef,
  type CouncilPattern,
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
  reviewer: 'Checks the diff, asks for fixes (read-only)',
  researcher: 'Answers questions about the codebase (read-only)',
  quick: 'Short questions (local model first = free)',
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
          <span className="flex-1" />
          <span className="text-[11px] text-ink-400">
            {dur((run.endedAt ?? now) - run.startedAt)}
            {tokens ? ` · ${fmtTokens(tokens)} tok` : ''}
          </span>
          <span className="text-ink-400 text-xs">{open ? '▾' : '▸'}</span>
        </div>
        {!compact && <div className="text-xs text-ink-300 truncate mt-0.5">{run.task.split('\n')[0]}</div>}
        <div className="flex flex-wrap items-center gap-1 mt-1.5">
          {run.steps.map((s, i) => (
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
          {!running && run.status === 'error' && run.result && <div className="text-xs text-danger whitespace-pre-wrap">{run.result}</div>}
        </div>
      )}
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
        <span className="text-ink-300 w-[68px] shrink-0 capitalize">{step.role}</span>
        <VendorBadge member={step.member} />
        {step.model && <span className="font-mono text-[10px] text-ink-400 truncate max-w-[90px]">{step.model}</span>}
        <span
          className={cx('text-[10px] px-1 rounded', step.access === 'write' ? 'bg-warn/15 text-warn' : 'bg-ink-700 text-ink-300')}
          title={step.access === 'write' ? 'May edit files in the project folder' : 'Read-only'}
        >
          {step.access === 'write' ? 'edits' : 'read'}
        </span>
        {step.billing === 'api' && <span className="text-[10px] text-danger" title="This run was billed to an API key">API</span>}
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
                  <Markdown text={step.output} />
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

      <div>
        <div className="text-[11px] text-ink-400 mb-1.5">Runs {runs.length ? `(${runs.length})` : ''}</div>
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
                <ModelInput label="Model" value={cfg.model ?? ''} placeholder={id === 'cursor' ? 'auto' : 'CLI default'} suggestions={SUGGEST[id]} onCommit={(v) => setMember(id, { model: v || undefined })} />
                <ModelInput label="Heavy model (plan/review/judge)" value={cfg.heavyModel ?? ''} placeholder="same as model" suggestions={SUGGEST[id]} onCommit={(v) => setMember(id, { heavyModel: v || undefined })} />
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex justify-end">
        <Button size="sm" onClick={() => send({ type: 'council_refresh' })}>
          ↻ Re-check members
        </Button>
      </div>

      <h4 className="text-sm font-medium pt-2">Roles</h4>
      <p className="text-xs text-ink-400 -mt-2">For each role, members are tried left to right. A member that is off, signed out or at its usage limit is skipped automatically.</p>
      <div className="space-y-2">
        {COUNCIL_ROLES.map((role) => (
          <div key={role} className="grid grid-cols-[110px_1fr] gap-3 items-center">
            <div>
              <div className="text-sm capitalize">{role}</div>
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
        <Field label="Review → fix rounds" hint="How many times the builder may fix issues the reviewer finds.">
          <input type="number" min={0} max={3} className={inputCls} value={c.maxFixRounds} onChange={(e) => setC({ maxFixRounds: Math.max(0, Math.min(3, Number(e.target.value))) })} />
        </Field>
        <Field label="Timeout per member run (minutes)">
          <input type="number" min={1} max={120} className={inputCls} value={c.timeoutMinutes} onChange={(e) => setC({ timeoutMinutes: Math.max(1, Number(e.target.value)) })} />
        </Field>
      </div>
      <div className="space-y-1 pt-1">
        <Toggle label="Let the builder edit files in approved folders" checked={c.allowWrite} onChange={(v) => setC({ allowWrite: v })} />
        <div className={cx(!c.allowWrite && 'opacity-40 pointer-events-none')}>
          <Toggle label="Ask me before each member that can edit files" checked={c.confirmWrites} onChange={(v) => setC({ confirmWrites: v })} />
        </div>
        <Toggle label="Always plan and review risky changes" checked={c.riskRouting} onChange={(v) => setC({ riskRouting: v })} />
        <Toggle label="Subscription only (refuse members signed in with an API key)" checked={c.requirePlanBilling} onChange={(v) => setC({ requirePlanBilling: v })} />
      </div>
      <p className="text-[11px] text-ink-400">
        Risky changes are ones that touch auth, payments, secrets, database migrations, deploy config, git history, or delete data. With the risky-changes switch on they always go plan → build → review, the builder uses its heavy model, and you approve every edit. With edits off, every member is read-only: planners plan, reviewers review, and change requests come back as proposals. Members never get LocalDex's own tools; they use their vendor's tools inside the project folder. To point a member at a specific executable, set <span className="font-mono">council.members.&lt;name&gt;.command</span> in <span className="font-mono">~/.localdex/config.json</span>.
      </p>
    </>
  );
}

const INSTALL: Record<MemberId, string> = {
  claude: 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex',
  gemini: 'npm i -g @google/gemini-cli',
  cursor: 'npm install   # in the LocalDex folder (installs @cursor/sdk)',
};

const SUGGEST: Record<MemberId, string[]> = {
  claude: ['sonnet', 'opus', 'haiku'],
  codex: [],
  gemini: [],
  cursor: ['auto', 'composer-2.5'],
};

function ModelInput({ label, value, placeholder, suggestions, onCommit }: { label: string; value: string; placeholder: string; suggestions: string[]; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const id = `dl-${label}-${placeholder}`.replace(/\W+/g, '-');
  return (
    <label className="block">
      <span className="text-[11px] text-ink-400">{label}</span>
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
            <option key={s} value={s} />
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
