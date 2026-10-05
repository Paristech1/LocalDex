import { useState } from 'react';
import type { GoalMode, PlanStep, WorkerState } from '@localdex/shared';
import { send, useStore } from '../store';
import { AssistantBubble, MessageList } from './Message';
import { ToolCard } from './ToolCard';
import { Button, Field, StatusDot, cx, fmtTokens, inputCls, statusLabel, timeAgo } from './ui';

type Tab = 'plan' | 'workers' | 'goal' | 'context' | 'log';

export function RightPanel() {
  const [tab, setTab] = useState<Tab>('plan');
  const session = useStore((s) => s.session);
  const workerCount = Object.keys(session?.workers ?? {}).length;
  const planCount = session?.plan.length ?? 0;
  const goalActive = session?.goal?.active;
  const errorCount = useStore((s) => s.logs.filter((l) => l.level === 'error').length);

  const tabs: Array<{ id: Tab; label: string; badge?: string | number; hot?: boolean }> = [
    { id: 'plan', label: 'Plan', badge: planCount || undefined },
    { id: 'workers', label: 'Workers', badge: workerCount || undefined },
    { id: 'goal', label: 'Goal', badge: goalActive ? '●' : undefined, hot: !!goalActive },
    { id: 'context', label: 'Context' },
    { id: 'log', label: 'Log', badge: errorCount || undefined, hot: errorCount > 0 },
  ];

  return (
    <aside className="w-[380px] shrink-0 border-l border-ink-700 bg-ink-900/40 flex flex-col min-h-0">
      <div className="flex border-b border-ink-700 text-xs">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cx(
              'flex-1 py-2.5 flex items-center justify-center gap-1 border-b-2 transition-colors',
              tab === t.id ? 'border-accent text-ink-100' : 'border-transparent text-ink-400 hover:text-ink-200',
            )}
          >
            {t.label}
            {t.badge !== undefined && (
              <span className={cx('text-[10px] px-1 rounded', t.hot ? 'text-accent' : 'bg-ink-700 text-ink-300')}>{t.badge}</span>
            )}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {tab === 'plan' && <PlanPanel steps={session?.plan ?? []} />}
        {tab === 'workers' && <WorkersPanel />}
        {tab === 'goal' && <GoalPanel />}
        {tab === 'context' && <ContextPanel />}
        {tab === 'log' && <LogPanel />}
      </div>
    </aside>
  );
}

// ---------- Plan ----------

function PlanPanel({ steps }: { steps: PlanStep[] }) {
  if (!steps.length) {
    return <Empty>The agent will post its task plan here when it starts multi-step work (via the update_plan tool).</Empty>;
  }
  const done = steps.filter((s) => s.status === 'done').length;
  return (
    <div>
      <div className="text-xs text-ink-400 mb-2">
        {done}/{steps.length} done
      </div>
      <div className="h-1 bg-ink-700 rounded-full mb-3 overflow-hidden">
        <div className="h-full bg-accent" style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
      <ol className="space-y-1.5">
        {steps.map((s) => (
          <li key={s.id} className="flex items-start gap-2 text-sm">
            <span
              className={cx(
                'mt-0.5 w-4 h-4 rounded border grid place-items-center text-[10px] shrink-0',
                s.status === 'done' && 'bg-accent border-accent text-ink-950',
                s.status === 'in_progress' && 'border-warn text-warn pulse',
                s.status === 'pending' && 'border-ink-500',
                s.status === 'skipped' && 'border-ink-600 text-ink-500',
              )}
            >
              {s.status === 'done' ? '✓' : s.status === 'in_progress' ? '›' : s.status === 'skipped' ? '–' : ''}
            </span>
            <span className={cx(s.status === 'done' && 'text-ink-300 line-through', s.status === 'skipped' && 'text-ink-500')}>{s.title}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------- Workers ----------

function WorkersPanel() {
  const session = useStore((s) => s.session);
  const workers = Object.values(session?.workers ?? {}).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!workers.length) {
    return (
      <Empty>
        No workers yet. The agent spawns workers with <code className="font-mono">delegate_to_worker</code> for independent sub-tasks; several run in parallel
        (concurrency is set in Settings).
      </Empty>
    );
  }
  return (
    <div className="space-y-2">
      {workers.map((w) => (
        <WorkerCard key={w.name} worker={w} sessionId={session!.id} />
      ))}
    </div>
  );
}

function WorkerCard({ worker: w, sessionId }: { worker: WorkerState; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const agent = `worker:${w.name}`;
  const status = useStore((s) => s.status[agent]);
  const live = useStore((s) => s.live[agent]);
  const effective = status?.status ?? w.status;
  const busy = effective !== 'idle' && effective !== 'error';
  const knownIds = new Set(w.messages.filter((m) => m.role === 'tool').map((m) => (m as { tool_call_id: string }).tool_call_id));
  const liveTools = (live?.tools ?? []).filter((t) => !knownIds.has(t.callId));

  return (
    <div className="rounded-lg border border-ink-600 bg-ink-900/60">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full text-left px-3 py-2 flex items-center gap-2">
        <StatusDot status={effective} />
        <span className="font-mono text-sm text-ink-100">{w.name}</span>
        <span className="text-[11px] text-ink-400 flex-1 truncate">{statusLabel(effective, status?.detail)}</span>
        <span className="text-[11px] text-ink-400">{timeAgo(w.updatedAt)}</span>
        <span className="text-ink-400 text-xs">{open ? '▾' : '▸'}</span>
      </button>
      <div className="px-3 pb-2 text-xs text-ink-300">
        {w.lastTask && (
          <div className="truncate">
            <span className="text-ink-400">task:</span> {w.lastTask}
          </div>
        )}
        {w.archive.length > 0 && <div className="text-ink-400">{w.archive.length} compaction(s)</div>}
      </div>
      {open && (
        <div className="border-t border-ink-700 px-3 py-2 max-h-[60vh] overflow-y-auto text-sm">
          <MessageList messages={w.messages} />
          {live && (live.content || live.reasoning || liveTools.length > 0) && (
            <AssistantBubble content={live.content || null} reasoning={live.reasoning} streaming={!live.done}>
              {liveTools.map((t) => (
                <ToolCard key={t.callId} name={t.name} args={t.args} result={t.result} ok={t.ok} startedAt={t.startedAt} />
              ))}
            </AssistantBubble>
          )}
          <div className="flex gap-2 mt-2">
            <Button size="sm" disabled={busy} onClick={() => send({ type: 'reset_worker', sessionId, name: w.name })} title="Clear this worker's memory (archived)">
              Reset memory
            </Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => send({ type: 'delete_worker', sessionId, name: w.name })}>
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Goal ----------

function GoalPanel() {
  const session = useStore((s) => s.session);
  const goal = session?.goal;
  const [mode, setMode] = useState<GoalMode>('goal');
  const [brief, setBrief] = useState('');
  const [criteria, setCriteria] = useState('');
  const [maxIter, setMaxIter] = useState(10);
  if (!session) return null;

  if (goal?.active) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-accent/40 bg-accent/5 px-3 py-2">
          <div className="text-xs text-accent font-medium">{goal.mode === 'goal' ? 'Goal active' : 'Loop active'}</div>
          <div className="text-sm mt-1 whitespace-pre-wrap">{goal.brief}</div>
          {goal.doneCriteria && (
            <div className="text-xs text-ink-300 mt-2">
              <span className="text-ink-400">Done when:</span> {goal.doneCriteria}
            </div>
          )}
          <div className="text-xs text-ink-400 mt-2">
            Iteration {goal.iteration}/{goal.maxIterations}
          </div>
        </div>
        {goal.lastAssessment && (
          <div className="text-xs text-ink-300">
            <div className="text-ink-400 mb-0.5">Last checkpoint</div>
            {goal.lastAssessment}
          </div>
        )}
        {goal.remaining.length > 0 && (
          <div className="text-xs">
            <div className="text-ink-400 mb-0.5">Remaining</div>
            <ul className="list-disc pl-4 space-y-0.5 text-ink-200">
              {goal.remaining.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex gap-2">
          <Button variant="danger" size="sm" onClick={() => send({ type: 'stop', sessionId: session.id })}>
            ■ Stop run
          </Button>
          <Button size="sm" onClick={() => send({ type: 'clear_goal', sessionId: session.id })}>
            Clear goal
          </Button>
        </div>
        <p className="text-[11px] text-ink-400">
          After each turn a finish checkpoint asks the model whether the goal is met. If not, it auto-continues until done or the iteration cap. Stop
          pauses the current run; Clear removes the goal.
        </p>
      </div>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!brief.trim()) return;
        send({ type: 'set_goal', sessionId: session.id, goal: { mode, brief: brief.trim(), doneCriteria: criteria.trim(), maxIterations: maxIter } });
      }}
    >
      {goal && !goal.active && (
        <div className="text-xs text-ink-400 rounded-md border border-ink-700 px-3 py-2">
          Previous {goal.mode}: <span className="text-ink-200">{goal.brief}</span> — finished after {goal.iteration} iteration(s).
          {goal.lastAssessment ? ` ${goal.lastAssessment}` : ''}
        </div>
      )}
      <div className="flex rounded-md border border-ink-600 overflow-hidden text-xs">
        {(['goal', 'loop'] as GoalMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cx('flex-1 py-1.5', mode === m ? 'bg-ink-600 text-ink-100' : 'text-ink-300 hover:bg-ink-700')}
          >
            {m === 'goal' ? 'Goal (until done)' : 'Loop (keep working)'}
          </button>
        ))}
      </div>
      <Field label={mode === 'goal' ? 'Goal' : 'Brief'} hint={mode === 'goal' ? 'What must be true when finished.' : 'The agent picks the next valuable thing each iteration.'}>
        <textarea className={cx(inputCls, 'min-h-[80px]')} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder={mode === 'goal' ? 'e.g. All tests in /tests pass and the README documents the new CLI flags.' : 'e.g. Keep improving test coverage of src/, one module at a time.'} />
      </Field>
      {mode === 'goal' && (
        <Field label="Done criteria (optional)">
          <input className={inputCls} value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder="e.g. npm test exits 0" />
        </Field>
      )}
      <Field label="Max iterations">
        <input type="number" min={1} max={200} className={inputCls} value={maxIter} onChange={(e) => setMaxIter(Number(e.target.value))} />
      </Field>
      <Button type="submit" variant="primary" disabled={!brief.trim()}>
        {mode === 'goal' ? 'Start goal' : 'Start loop'}
      </Button>
    </form>
  );
}

// ---------- Context ----------

function ContextPanel() {
  const session = useStore((s) => s.session);
  const settings = useStore((s) => s.settings);
  const models = useStore((s) => s.models);
  const status = useStore((s) => s.status['main']);
  const [showSummary, setShowSummary] = useState(false);
  if (!session || !settings) return null;
  const info = models.find((m) => m.id === session.model);
  const ctx = settings.contextLength || info?.contextLength || 0;
  const running = !!status && status.status !== 'idle' && status.status !== 'error';
  const workerMsgs = Object.values(session.workers).reduce((n, w) => n + w.messages.length, 0);

  return (
    <div className="space-y-3 text-sm">
      <Stat label="Messages in context" value={`${session.messages.length} (+${workerMsgs} in workers)`} />
      <Stat label="Last prompt size" value={ctx ? `${fmtTokens(session.usage.lastPromptTokens)} / ${fmtTokens(ctx)} tokens` : `${fmtTokens(session.usage.lastPromptTokens)} tokens (context length unknown)`} />
      <Stat label="Total tokens this session" value={`${fmtTokens(session.usage.promptTokens)} in · ${fmtTokens(session.usage.completionTokens)} out`} />
      <Stat label="Compactions" value={`${session.compactions} (${session.archive.length} archived transcript(s))`} />
      <Stat label="Auto-compact" value={settings.autoCompactThreshold > 0 && ctx ? `at ${Math.round(settings.autoCompactThreshold * 100)}% of ${fmtTokens(ctx)}` : settings.autoCompactThreshold > 0 ? 'enabled (needs a known context length)' : 'off'} />

      <div className="pt-1">
        <Button variant="primary" size="sm" disabled={running || session.messages.length < 4} onClick={() => send({ type: 'compact', sessionId: session.id })}>
          Compact &amp; Resume now
        </Button>
        <p className="text-[11px] text-ink-400 mt-2">
          Summarizes the conversation (decisions, files changed, open items, worker state) and starts a fresh context seeded with that summary. The full
          transcript is kept in the session file.
        </p>
      </div>

      {session.compactSummary && (
        <div>
          <button type="button" className="text-xs text-ink-300 hover:text-ink-100" onClick={() => setShowSummary((s) => !s)}>
            {showSummary ? '▾' : '▸'} Latest summary
          </button>
          {showSummary && <pre className="mt-1 text-xs whitespace-pre-wrap font-sans text-ink-200 border-l-2 border-ink-600 pl-2 max-h-96 overflow-auto">{session.compactSummary}</pre>}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-ink-400">{label}</div>
      <div className="text-ink-100">{value}</div>
    </div>
  );
}

// ---------- Log ----------

function LogPanel() {
  const logs = useStore((s) => s.logs);
  if (!logs.length) return <Empty>Server events and warnings show up here.</Empty>;
  return (
    <div className="space-y-1 font-mono text-[11px]">
      {[...logs].reverse().map((l) => (
        <div key={l.id} className={cx('flex gap-2', l.level === 'error' ? 'text-danger' : l.level === 'warn' ? 'text-warn' : 'text-ink-300')}>
          <span className="text-ink-500 shrink-0">{new Date(l.ts).toLocaleTimeString()}</span>
          <span className="break-words">{l.message}</span>
        </div>
      ))}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-ink-400 leading-relaxed">{children}</div>;
}
