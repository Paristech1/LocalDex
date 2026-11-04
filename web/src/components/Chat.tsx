import { useEffect, useRef, useState } from 'react';
import { MEMBER_IDS, RUN_ACCESS_LABELS, defaultRunAccess, type ChatMessage, type CouncilRunAccess, type EscalatePattern, type MemberId } from '@localdex/shared';
import { send, useStore, type Prompt } from '../store';
import { AssistantBubble, MessageList } from './Message';
import { ToolCard } from './ToolCard';
import { CouncilRunCard, MEMBER_META } from './Council';
import { Button, StatusDot, cx, inputCls, statusLabel } from './ui';

export function Chat() {
  const session = useStore((s) => s.session);
  const live = useStore((s) => s.live['main']);
  const status = useStore((s) => s.status['main']);
  const prompts = useStore((s) => s.prompts);
  const settings = useStore((s) => s.settings);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);

  const running = !!status && status.status !== 'idle' && status.status !== 'error';

  useEffect(() => {
    if (stick && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  });

  const [picker, setPicker] = useState(false);
  const sessionId = session?.id;
  useEffect(() => setPicker(false), [sessionId]);

  if (!session) return <div className="flex-1 grid place-items-center text-ink-400">No session</div>;

  const knownCallIds = new Set(session.messages.filter((m) => m.role === 'tool').map((m) => (m as { tool_call_id: string }).tool_call_id));
  // Calls already in the transcript (an assistant message with tool_calls) render there, with their live state;
  // only calls the transcript does not know yet get a card in the live bubble. Showing both drew every call twice.
  const transcriptCallIds = new Set(session.messages.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []).map((c) => c.id) : [])));
  const pendingTools = (live?.tools ?? []).filter((t) => !knownCallIds.has(t.callId) && transcriptCallIds.has(t.callId));
  const liveTools = (live?.tools ?? []).filter((t) => !knownCallIds.has(t.callId) && !transcriptCallIds.has(t.callId));
  const showLive = live && (live.content || live.reasoning || liveTools.length > 0);
  const noFolders = settings && settings.approvedFolders.length === 0;
  const councilMode = !!settings?.council.enabled && session.mode === 'council';
  const liveRun = [...(session.councilRuns ?? [])].reverse().find((r) => r.status === 'running');
  // Solo with the council on: the latest request can be handed to the council once the local agent has answered.
  const canEscalate = !!settings?.council.enabled && !councilMode && !running && !liveRun && hasRequest(session.messages);
  const afterAnswer = canEscalate && lastIsAnswer(session.messages);

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0">
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        className="flex-1 overflow-y-auto px-6 py-4"
      >
        <div className="max-w-3xl mx-auto">
          {session.messages.length <= 1 && !showLive && !liveRun && <Welcome noFolders={!!noFolders} council={councilMode} />}
          <MessageList messages={session.messages} pending={pendingTools} running={running} />
          {afterAnswer && !picker && (
            <div className="-mt-1 mb-2">
              <button type="button" onClick={() => setPicker(true)} className="text-[11px] text-ink-400 hover:text-[#7cc0f2]" title="Send your latest request, with a summary of what the local agent did, to the cloud council. The chat stays in Solo.">
                Hand to council ☁
              </button>
            </div>
          )}
          {showLive && (
            <AssistantBubble content={live.content || null} reasoning={live.reasoning} streaming={!live.done}>
              {liveTools.map((t) => (
                <ToolCard key={t.callId} name={t.name} args={t.args} result={t.result} ok={t.ok} startedAt={t.startedAt} />
              ))}
            </AssistantBubble>
          )}
          {liveRun && (
            <div className="my-3">
              <CouncilRunCard run={liveRun} defaultOpen compact />
            </div>
          )}
          {running && !showLive && !liveRun && (
            <div className="flex items-center gap-2 text-xs text-ink-400 my-3">
              <StatusDot status={status?.status} /> {statusLabel(status?.status, status?.detail)}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-ink-700 bg-ink-900/60">
        <div className="max-w-3xl mx-auto px-4 pt-3 pb-4 space-y-2">
          {prompts.map((p) => (
            <PromptCard key={p.id} prompt={p} />
          ))}
          {picker && canEscalate && <EscalatePicker sessionId={session.id} onClose={() => setPicker(false)} />}
          <Composer
            sessionId={session.id}
            running={running}
            status={status?.status}
            detail={status?.detail}
            council={councilMode}
            onEscalate={canEscalate && !picker ? () => setPicker(true) : undefined}
          />
        </div>
      </div>
    </div>
  );
}

function Welcome({ noFolders, council }: { noFolders: boolean; council?: boolean }) {
  if (council && !noFolders) {
    return (
      <div className="text-center py-16 text-ink-300">
        <div className="text-3xl font-semibold text-ink-100 tracking-tight">
          LocalDex <span className="text-[#7cc0f2]">Council</span>
        </div>
        <div className="mt-2 text-sm">Claude, Codex, Gemini and Cursor on your subscriptions. Routed by task.</div>
        <div className="mt-6 inline-grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-left text-xs">
          <span className="font-mono text-ink-200">/ask claude …</span>
          <span className="text-ink-400">one member, by name</span>
          <span className="font-mono text-ink-200">/build …</span>
          <span className="text-ink-400">plan → build → review</span>
          <span className="font-mono text-ink-200">/second …</span>
          <span className="text-ink-400">build, then a second opinion</span>
          <span className="font-mono text-ink-200">/review …</span>
          <span className="text-ink-400">reviewer only</span>
          <span className="font-mono text-ink-200">/vote …</span>
          <span className="text-ink-400">independent answers + a judge</span>
          <span className="font-mono text-ink-200">/frontend, /backend …</span>
          <span className="text-ink-400">the UI or backend builder</span>
          <span className="font-mono text-ink-200">/vision …</span>
          <span className="text-ink-400">look at a screenshot or mockup</span>
          <span className="font-mono text-ink-200">anything else</span>
          <span className="text-ink-400">the router picks</span>
        </div>
      </div>
    );
  }
  return (
    <div className="text-center py-16 text-ink-300">
      <div className="text-3xl font-semibold text-ink-100 tracking-tight">LocalDex</div>
      <div className="mt-2 text-sm">Your files. Your terminal. Your local model.</div>
      {noFolders ? (
        <div className="mt-6 inline-block text-left text-xs bg-warn/10 border border-warn/30 text-warn rounded-md px-4 py-3">
          No approved folders yet. Open <b>Settings → Workspace</b> and add the project folder the agent may work in.
        </div>
      ) : (
        <div className="mt-6 text-xs text-ink-400 space-y-1">
          <div>Describe a task. The agent reads, edits, runs commands and reports back.</div>
          <div>Use the right panel to set a Goal, watch Workers, or Compact context.</div>
        </div>
      )}
    </div>
  );
}

function Composer({
  sessionId,
  running,
  status,
  detail,
  council,
  onEscalate,
}: {
  sessionId: string;
  running: boolean;
  status?: string;
  detail?: string;
  council?: boolean;
  onEscalate?: () => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const councilSettings = useStore((s) => s.settings?.council);
  const fallback: CouncilRunAccess = councilSettings ? defaultRunAccess(councilSettings) : 'read';
  // Per message, never saved: starts from Settings → Council and follows it when those settings change.
  const [access, setAccess] = useState<CouncilRunAccess>(fallback);
  useEffect(() => setAccess(fallback), [fallback]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    send({ type: 'send_message', sessionId, content: t, ...(council ? { access } : {}) });
    setText('');
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(220, el.scrollHeight) + 'px';
  }, [text]);

  return (
    <div className={cx('rounded-xl border bg-ink-900', council ? 'border-[#7cc0f2]/40 focus-within:border-[#7cc0f2]/70' : 'border-ink-600 focus-within:border-accent/60')}>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder={
          council
            ? running
              ? 'Queue a follow-up — it runs when the council finishes…'
              : 'Ask the council… (/ask claude, /build, /second, /review, /vote; Enter to send)'
            : running
              ? 'Send a correction — it is delivered before the next model call…'
              : 'What should LocalDex do? (Enter to send, Shift+Enter for newline)'
        }
        className="w-full bg-transparent resize-none px-4 pt-3 pb-1 text-sm focus:outline-none placeholder:text-ink-400"
      />
      <div className="flex items-center justify-between px-3 pb-2">
        <div className="flex items-center gap-2 text-xs text-ink-400 min-w-0">
          <StatusDot status={status as never} />
          <span className="truncate">{statusLabel(status as never, detail)}</span>
        </div>
        <div className="flex items-center gap-2">
          {council && <AccessPicker value={access} onChange={setAccess} />}
          {onEscalate && (
            <Button variant="ghost" size="sm" onClick={onEscalate} title="Hand your latest request to the council; the chat stays in Solo">
              Hand to council ☁
            </Button>
          )}
          {running && (
            <Button variant="danger" size="sm" onClick={() => send({ type: 'stop', sessionId })}>
              ■ Stop
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={submit} disabled={!text.trim()}>
            {running ? 'Send correction' : 'Send'} ↵
          </Button>
        </div>
      </div>
    </div>
  );
}

const ACCESS_ORDER: CouncilRunAccess[] = ['read', 'confirm', 'auto'];
const ACCESS_TITLE: Record<CouncilRunAccess, string> = {
  read: 'Every member is read-only for this message',
  confirm: 'The builder may edit files; each edit step asks you first',
  auto: 'The builder may edit files without asking (high-risk changes still ask)',
};

/** Per-message edit access for Council mode. */
function AccessPicker({ value, onChange }: { value: CouncilRunAccess; onChange: (v: CouncilRunAccess) => void }) {
  return (
    <div role="radiogroup" aria-label="Edit access for this message" className="flex rounded-md border border-ink-600 overflow-hidden text-[11px]">
      {ACCESS_ORDER.map((a) => (
        <button
          key={a}
          type="button"
          role="radio"
          aria-checked={value === a}
          title={ACCESS_TITLE[a]}
          onClick={() => onChange(a)}
          className={cx(
            'px-2 py-1 whitespace-nowrap transition-colors',
            value === a ? (a === 'auto' ? 'bg-warn/15 text-warn' : 'bg-ink-700 text-ink-100') : 'text-ink-400 hover:text-ink-200',
          )}
        >
          {RUN_ACCESS_LABELS[a]}
        </button>
      ))}
    </div>
  );
}

const ESCALATE_OPTIONS: Array<{ id: EscalatePattern; label: string; hint: string }> = [
  { id: 'auto', label: 'Auto', hint: 'The router picks' },
  { id: 'single', label: 'Ask one member', hint: 'One member answers' },
  { id: 'plan_build_review', label: 'Plan → Build → Review', hint: 'Planned, built and reviewed' },
  { id: 'second_opinion', label: 'Second opinion', hint: 'Built, then critiqued' },
  { id: 'vote', label: 'Vote', hint: 'Independent answers and a judge' },
  { id: 'arena', label: 'Arena', hint: 'Two builders race in separate copies; you keep one' },
];

/** "Hand to council": pick how the council takes over the latest request. */
function EscalatePicker({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [pattern, setPattern] = useState<EscalatePattern>('auto');
  const [member, setMember] = useState<MemberId | ''>('');
  const [note, setNote] = useState('');
  const councilSettings = useStore((s) => s.settings?.council);
  const members = councilSettings?.members;
  const enabled = MEMBER_IDS.filter((m) => members?.[m]?.enabled !== false);
  // Same per-hand-over access as the Council composer: starts from Settings → Council, never saved.
  const fallback: CouncilRunAccess = councilSettings ? defaultRunAccess(councilSettings) : 'read';
  const [access, setAccess] = useState<CouncilRunAccess>(fallback);
  useEffect(() => setAccess(fallback), [fallback]);
  const go = () => {
    send({ type: 'council_escalate', sessionId, pattern, access, ...(pattern === 'single' && member ? { member } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
    onClose();
  };
  return (
    <div className="rounded-lg border border-[#7cc0f2]/40 bg-ink-900 px-3 py-2.5 text-sm space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-[#7cc0f2]">Hand to council ☁</span>
        <span className="text-[11px] text-ink-400 truncate">Your latest request and what the local agent did. The chat stays in Solo.</span>
        <span className="flex-1" />
        <button type="button" onClick={onClose} className="text-ink-400 hover:text-ink-100 text-xs" aria-label="Close">
          ✕
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        {ESCALATE_OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            title={o.hint}
            onClick={() => setPattern(o.id)}
            className={cx('rounded-md border px-2 py-1 text-xs', pattern === o.id ? 'border-[#7cc0f2]/60 bg-[#7cc0f2]/10 text-ink-100' : 'border-ink-600 text-ink-300 hover:text-ink-100')}
          >
            {o.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {pattern === 'single' && (
          <select className={cx(inputCls, 'w-auto text-xs')} value={member} onChange={(e) => setMember(e.target.value as MemberId | '')} aria-label="Member">
            <option value="">Router picks</option>
            {enabled.map((m) => (
              <option key={m} value={m}>
                {MEMBER_META[m].label}
              </option>
            ))}
          </select>
        )}
        <AccessPicker value={access} onChange={setAccess} />
        <input
          className={cx(inputCls, 'flex-1 min-w-[10rem] text-xs')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go();
          }}
          placeholder="Add a note (optional)"
        />
        <Button variant="primary" size="sm" onClick={go}>
          Hand over
        </Button>
      </div>
    </div>
  );
}

function hasRequest(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === 'user' && m.content.trim() && !m.content.startsWith('['));
}

/** The last message is a finished assistant answer (not a tool call in progress). */
function lastIsAnswer(messages: ChatMessage[]): boolean {
  const last = messages.at(-1);
  // A run that stopped (stuck / LM Studio error / limits) ends on LocalDex's own note: offer the hand-over there too.
  if (last?.role === 'user' && /^\[(system\] (Run stopped|Step limit)|Goal paused)/.test(last.content)) return true;
  return last?.role === 'assistant' && !!last.content?.trim() && !last.tool_calls?.length;
}

function PromptCard({ prompt }: { prompt: Prompt }) {
  const [answer, setAnswer] = useState('');
  const isMember = prompt.agent.startsWith('member:');
  const who = prompt.agent === 'main' ? 'Agent' : isMember ? 'Council' : prompt.agent.replace('worker:', 'Worker ');
  if (prompt.kind === 'approval') {
    return (
      <div className="rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
        <div className="text-warn text-xs font-medium mb-1">{isMember ? 'A council member wants to edit files' : `${who} wants to run a command`}</div>
        <pre className="font-mono text-xs bg-ink-950 rounded-md px-3 py-2 whitespace-pre-wrap break-words">{prompt.command}</pre>
        <div className="text-[11px] text-ink-400 mt-1">in {prompt.cwd}</div>
        <div className="flex gap-2 mt-2">
          <Button variant="primary" size="sm" onClick={() => send({ type: 'approval_response', id: prompt.id, approved: true })}>
            {isMember ? 'Allow edits' : 'Allow'}
          </Button>
          <Button variant="danger" size="sm" onClick={() => send({ type: 'approval_response', id: prompt.id, approved: false })}>
            Deny
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-accent/40 bg-accent/5 px-4 py-3 text-sm">
      <div className="text-accent text-xs font-medium mb-1">{who} asks</div>
      <div className="whitespace-pre-wrap">{prompt.question}</div>
      <form
        className="flex gap-2 mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!answer.trim()) return;
          send({ type: 'ask_user_response', id: prompt.id, answer: answer.trim() });
        }}
      >
        <input className={cx(inputCls, 'flex-1')} autoFocus value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer…" />
        <Button type="submit" variant="primary" size="sm" disabled={!answer.trim()}>
          Reply
        </Button>
      </form>
    </div>
  );
}
