import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FEEDBACK_CATEGORIES, FEEDBACK_LABELS, type ChatMessage, type FeedbackCategory, type MessageFeedback, type TurnCheckpoint } from '@localdex/shared';
import { ToolCard } from './ToolCard';
import { ViaBadge, WorktreeChip } from './Council';
import { TurnCard } from './TurnCard';
import { cx } from './ui';

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
});

export function Reasoning({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cx('text-xs text-ink-400 hover:text-ink-200', streaming && 'pulse')}
      >
        {open ? '▾' : '▸'} {streaming ? 'thinking…' : 'reasoning'} ({text.length} chars)
      </button>
      {open && <pre className="mt-1 text-xs text-ink-300 whitespace-pre-wrap font-sans border-l-2 border-ink-600 pl-2 max-h-72 overflow-auto">{text}</pre>}
    </div>
  );
}

export function UserBubble({ text, images, onEdit, onFork }: { text: string; images?: string[]; onEdit?: (text: string) => void; onFork?: () => void }) {
  const [open, setOpen] = useState(false);
  // The clock line (C3) is for the model; it would only clutter the chat.
  if (text.startsWith('[context] Date and time: ')) return null;
  const isSystemish =/^\[(Goal|Loop|system|context|Resumed|Handed to council|Plan |job )/.test(text);
  if (isSystemish) {
    const [head, ...rest] = text.split('\n');
    return (
      <div className="flex flex-col items-center my-2">
        <div className="max-w-[90%] text-xs text-ink-300 bg-ink-800/60 border border-ink-700 rounded-md px-3 py-1.5">
          <button type="button" onClick={() => setOpen((o) => !o)} className="text-left">
            <span className="text-warn mr-1">◆</span> {head}
            {rest.length > 0 && <span className="text-ink-400 ml-1">{open ? '▾' : '▸'}</span>}
          </button>
          {open && rest.length > 0 && <pre className="mt-1 whitespace-pre-wrap font-sans text-ink-300">{rest.join('\n')}</pre>}
        </div>
        {images?.length ? <Thumbs images={images} /> : null}
      </div>
    );
  }
  return (
    <>
      <EditableUserBubble text={text} onEdit={onEdit} onFork={onFork} />
      {images?.length ? (
        <div className="flex justify-end -mt-1 mb-2">
          <Thumbs images={images} />
        </div>
      ) : null}
    </>
  );
}

/** A7: attached images, click to open full size. */
function Thumbs({ images }: { images: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-1">
      {images.map((id) => (
        <a key={id} href={`/api/attachments/${id}`} target="_blank" rel="noreferrer">
          <img src={`/api/attachments/${id}`} alt="attached image" className="h-20 max-w-[10rem] rounded-md object-cover border border-ink-600" />
        </a>
      ))}
    </div>
  );
}

/** U4: hover actions on your own messages. Edit re-runs from that point in a fork; the original stays as it was. */
function EditableUserBubble({ text, onEdit, onFork }: { text: string; onEdit?: (text: string) => void; onFork?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  if (editing && onEdit) {
    const canSave = !!draft.trim() && draft.trim() !== text.trim();
    const cancel = () => (setEditing(false), setDraft(text));
    const save = () => canSave && (setEditing(false), onEdit(draft.trim()));
    return (
      <div className="flex justify-end my-2">
        <div className="w-[85%] space-y-1">
          <textarea className="w-full min-h-[80px] rounded-xl border border-accent/60 bg-ink-800 px-3 py-2 text-sm text-ink-100 focus:outline-none" value={draft}
            onChange={(e) => setDraft(e.target.value)}
            // Same keys as the composer: Enter runs, Shift+Enter adds a line; Escape cancels.
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                save();
              }
            }}
            autoFocus
          />
          <div className="flex justify-end gap-2 text-xs">
            <span className="text-ink-400 mr-auto self-center">Runs in a new session forked from here; this one stays as it is.</span>
            <button type="button" className="px-2 py-1 text-ink-400 hover:text-ink-100" onClick={cancel}>
              Cancel
            </button>
            <button type="button" className="rounded-md bg-accent/20 px-2 py-1 text-accent hover:bg-accent/30 disabled:opacity-40" disabled={!canSave} onClick={save}>
              Save & run
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="group flex justify-end items-start gap-1 my-2">
      {(onEdit || onFork) && (
        <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 flex gap-1 pt-2 text-[11px] text-ink-400">
          {onEdit && (
            <button type="button" className="hover:text-ink-100" onClick={() => setEditing(true)} title="Edit and re-run from here (in a fork)">
              Edit
            </button>
          )}
          {onFork && (
            <button type="button" className="hover:text-ink-100" onClick={onFork} title="Copy the conversation up to here into a new session">
              Fork
            </button>
          )}
        </div>
      )}
      <div className="max-w-[85%] bg-ink-700 text-ink-100 rounded-2xl rounded-br-sm px-4 py-2 whitespace-pre-wrap">{text}</div>
    </div>
  );
}

export function AssistantBubble({
  content,
  reasoning,
  children,
  streaming,
  label,
  via,
  councilRunId,
  onFork,
  feedback,
  onRate,
}: {
  onFork?: () => void;
  feedback?: MessageFeedback;
  onRate?: (rating: 'up' | 'down' | null, category?: FeedbackCategory) => void;
  content: string | null;
  reasoning?: string;
  children?: React.ReactNode;
  streaming?: boolean;
  label?: string;
  via?: string;
  councilRunId?: string;
}) {
  return (
    <div className={cx('group relative my-2', via && 'border-l-2 border-[#7cc0f2]/40 pl-3')}>
      {label && <div className="text-[11px] text-ink-400 mb-1 font-mono">{label}</div>}
      {via && <ViaBadge via={via} />}
      {councilRunId && <WorktreeChip runId={councilRunId} />}
      <Reasoning text={reasoning ?? ''} streaming={streaming && !content} />
      {content && (
        <div className="text-ink-100">
          <Markdown text={content} />
          {streaming && <span className="inline-block w-2 h-4 bg-accent ml-0.5 align-text-bottom pulse" />}
        </div>
      )}
      {children}
      {content && !streaming && (onRate || onFork) && <AnswerActions feedback={feedback} onRate={onRate} onFork={onFork} />}
    </div>
  );
}

/** U3/U4: under a finished answer — 👍/👎 (a 👎 offers a reason; click the same thumb again to clear) and Fork from here. */
function AnswerActions({ feedback, onRate, onFork }: { feedback?: MessageFeedback; onRate?: (rating: 'up' | 'down' | null, category?: FeedbackCategory) => void; onFork?: () => void }) {
  const [asking, setAsking] = useState(false);
  const r = feedback?.rating;
  return (
    <div className={cx('mt-1 flex flex-wrap items-center gap-1 text-[11px] text-ink-400', !r && !asking && 'opacity-0 group-hover:opacity-100 focus-within:opacity-100')}>
      {onRate && <RateButtons r={r} feedback={feedback} asking={asking} setAsking={setAsking} onRate={onRate} />}
      {onFork && (
        <button type="button" onClick={onFork} title="Copy the conversation up to here into a new session" className="ml-1 px-1 rounded hover:text-ink-100">
          Fork from here
        </button>
      )}
    </div>
  );
}

function RateButtons({ r, feedback, asking, setAsking, onRate }: { r?: 'up' | 'down'; feedback?: MessageFeedback; asking: boolean; setAsking: (v: boolean) => void; onRate: (rating: 'up' | 'down' | null, category?: FeedbackCategory) => void }) {
  return (
    <>
      <button type="button" aria-label="Good answer" aria-pressed={r === 'up'} className={cx('px-1 rounded hover:text-ink-100', r === 'up' && 'text-accent')} onClick={() => (setAsking(false), onRate(r === 'up' ? null : 'up'))}>
        👍
      </button>
      <button type="button" aria-label="Bad answer" aria-pressed={r === 'down'} className={cx('px-1 rounded hover:text-ink-100', r === 'down' && 'text-danger')} onClick={() => (r === 'down' ? (setAsking(false), onRate(null)) : (setAsking(true), onRate('down')))}>
        👎
      </button>
      {r === 'down' && feedback?.category && !asking && <span>{FEEDBACK_LABELS[feedback.category]}</span>}
      {asking &&
        FEEDBACK_CATEGORIES.map((c) => (
          <button key={c} type="button" className={cx('rounded border px-1.5 py-0.5', feedback?.category === c ? 'border-danger/50 text-danger' : 'border-ink-600 hover:text-ink-100')} onClick={() => (setAsking(false), onRate('down', c))}>
            {FEEDBACK_LABELS[c]}
          </button>
        ))}
    </>
  );
}

export interface PendingTool {
  callId: string;
  result?: string;
  ok?: boolean;
  startedAt?: number;
}

/**
 * Render a full message list (main or worker), pairing tool calls with their results.
 * `pending`: live state of calls that have no result in `messages` yet; `running`: a run is in flight, so a call
 * without a result is still executing (not "failed").
 */
export function MessageList({ messages, label, pending, running, turns, onFork, onEdit, onRate }: { messages: ChatMessage[]; label?: string; pending?: PendingTool[]; running?: boolean; turns?: TurnCheckpoint[]; onFork?: (index: number) => void; onEdit?: (index: number, text: string) => void; onRate?: (index: number, rating: 'up' | 'down' | null, category?: FeedbackCategory) => void }) {
  const live = new Map((pending ?? []).map((t) => [t.callId, t]));
  const toolResults = new Map<string, Extract<ChatMessage, { role: 'tool' }>>();
  for (const m of messages) if (m.role === 'tool') toolResults.set(m.tool_call_id, m);
  // Each turn's "Changed files" card goes under the last assistant message written before the turn ended.
  const cards = new Map<number, TurnCheckpoint[]>();
  for (const t of turns ?? []) {
    let at = -1;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'assistant' && (m.ts ?? 0) <= (t.endedAt ?? Infinity)) at = i;
    }
    if (at < 0) at = messages.length - 1;
    cards.set(at, [...(cards.get(at) ?? []), t]);
  }

  return (
    <>
      {messages.map((m, i) => {
        if (m.role === 'system' || m.role === 'tool') return cards.get(i)?.map((t) => <TurnCard key={t.id} turn={t} />) ?? null;
        if (m.role === 'user') return (
          <div key={i}>
            <UserBubble text={m.content} images={m.images} onEdit={onEdit ? (t) => onEdit(i, t) : undefined} onFork={onFork ? () => onFork(i) : undefined} />
            {cards.get(i)?.map((t) => <TurnCard key={t.id} turn={t} />)}
          </div>
        );
        return (
          <div key={i}>
          <AssistantBubble content={m.content} reasoning={m.reasoning} label={label} via={m.via} councilRunId={m.councilRunId} onFork={onFork && m.content && !running ? () => onFork(i) : undefined} feedback={m.feedback} onRate={onRate && !(running && i === messages.length - 1) ? (r, c) => onRate(i, r, c) : undefined}>
            {m.tool_calls?.map((tc) => {
              const r = toolResults.get(tc.id);
              const p = r ? undefined : live.get(tc.id);
              let args: unknown = tc.function.arguments;
              try {
                args = JSON.parse(tc.function.arguments);
              } catch {
                /* raw */
              }
              return (
                <ToolCard
                  key={tc.id}
                  name={tc.function.name}
                  args={args}
                  result={r ? r.content : p ? p.result : running ? undefined : '(no result recorded)'}
                  ok={r ? r.ok !== false : p ? p.ok : running ? undefined : false}
                  startedAt={p?.startedAt}
                />
              );
            })}
          </AssistantBubble>
          {cards.get(i)?.map((t) => <TurnCard key={t.id} turn={t} />)}
          </div>
        );
      })}
    </>
  );
}
