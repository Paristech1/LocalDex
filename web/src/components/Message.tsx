import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage } from '@localdex/shared';
import { ToolCard } from './ToolCard';
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

export function UserBubble({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const isSystemish = /^\[(Goal|Loop|system|Resumed)/.test(text);
  if (isSystemish) {
    const [head, ...rest] = text.split('\n');
    return (
      <div className="flex justify-center my-2">
        <div className="max-w-[90%] text-xs text-ink-300 bg-ink-800/60 border border-ink-700 rounded-md px-3 py-1.5">
          <button type="button" onClick={() => setOpen((o) => !o)} className="text-left">
            <span className="text-warn mr-1">◆</span> {head}
            {rest.length > 0 && <span className="text-ink-400 ml-1">{open ? '▾' : '▸'}</span>}
          </button>
          {open && rest.length > 0 && <pre className="mt-1 whitespace-pre-wrap font-sans text-ink-300">{rest.join('\n')}</pre>}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-end my-2">
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
}: {
  content: string | null;
  reasoning?: string;
  children?: React.ReactNode;
  streaming?: boolean;
  label?: string;
}) {
  return (
    <div className="my-2">
      {label && <div className="text-[11px] text-ink-400 mb-1 font-mono">{label}</div>}
      <Reasoning text={reasoning ?? ''} streaming={streaming && !content} />
      {content && (
        <div className="text-ink-100">
          <Markdown text={content} />
          {streaming && <span className="inline-block w-2 h-4 bg-accent ml-0.5 align-text-bottom pulse" />}
        </div>
      )}
      {children}
    </div>
  );
}

/** Render a full message list (main or worker), pairing tool calls with their results. */
export function MessageList({ messages, label }: { messages: ChatMessage[]; label?: string }) {
  const toolResults = new Map<string, Extract<ChatMessage, { role: 'tool' }>>();
  for (const m of messages) if (m.role === 'tool') toolResults.set(m.tool_call_id, m);

  return (
    <>
      {messages.map((m, i) => {
        if (m.role === 'system' || m.role === 'tool') return null;
        if (m.role === 'user') return <UserBubble key={i} text={m.content} />;
        return (
          <AssistantBubble key={i} content={m.content} reasoning={m.reasoning} label={label}>
            {m.tool_calls?.map((tc) => {
              const r = toolResults.get(tc.id);
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
                  result={r?.content ?? '(no result recorded)'}
                  ok={r ? r.ok !== false : false}
                />
              );
            })}
          </AssistantBubble>
        );
      })}
    </>
  );
}
