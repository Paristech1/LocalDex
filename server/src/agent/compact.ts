import type { ChatMessage, Session, WorkerState } from '@localdex/shared';
import { getSettings } from '../config.js';
import { contextLengthFor, estimateTokens, streamChat } from '../lmstudio.js';
import { bus } from './bus.js';
import { compactPrompt, mainSystemPrompt, workerSystemPrompt } from './prompts.js';

const MAX_TRANSCRIPT_CHARS = 160_000;
const MIN_MESSAGES_TO_COMPACT = 4;

/** Render messages as a readable transcript for the summarizer, trimming bulky tool output. */
export function renderTranscript(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') parts.push(`USER:\n${m.content}`);
    else if (m.role === 'assistant') {
      let s = `ASSISTANT:\n${m.content ?? ''}`;
      for (const tc of m.tool_calls ?? []) {
        s += `\n→ ${tc.function.name}(${clip(tc.function.arguments, 600)})`;
      }
      parts.push(s);
    } else if (m.role === 'tool') {
      parts.push(`TOOL RESULT (${m.name ?? m.tool_call_id}${m.ok === false ? ', FAILED' : ''}):\n${clip(m.content, 800)}`);
    }
  }
  let text = parts.join('\n\n');
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    const head = text.slice(0, 20_000);
    const tail = text.slice(-(MAX_TRANSCRIPT_CHARS - 20_000));
    text = `${head}\n\n[... ${text.length - MAX_TRANSCRIPT_CHARS} characters omitted ...]\n\n${tail}`;
  }
  return text;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}… [+${s.length - n} chars]` : s;
}

export async function summarize(
  model: string,
  messages: ChatMessage[],
  kind: 'main' | 'worker',
  previousSummary: string | null,
  signal?: AbortSignal,
): Promise<string> {
  const transcript = renderTranscript(messages);
  const user = `${previousSummary ? `Summary of even earlier context:\n${previousSummary}\n\n---\n\n` : ''}Transcript to summarize:\n\n${transcript}`;
  const res = await streamChat({
    model,
    messages: [
      { role: 'system', content: compactPrompt(kind) },
      { role: 'user', content: user },
    ],
    tools: [],
    temperature: 0.1,
    signal,
  });
  return res.content.trim() || '(summary unavailable)';
}

export function resumeMessage(summary: string, goalBrief?: string | null): string {
  return `[Resumed from compacted context]\nThe conversation so far has been summarized. Continue from this state; the files on disk reflect all previous work.\n\n${summary}${goalBrief ? `\n\nActive goal: ${goalBrief}` : ''}`;
}

/** Compact the main conversation. Mutates session.messages in place so a running loop sees the new context. */
export async function compactMain(session: Session, signal?: AbortSignal, reason = 'manual'): Promise<string> {
  const model = session.model ?? getSettings().model;
  if (!model) throw new Error('No model selected.');
  if (session.messages.length < MIN_MESSAGES_TO_COMPACT) throw new Error('Not enough conversation to compact.');

  bus.emit({ type: 'agent_status', sessionId: session.id, agent: 'main', status: 'thinking', detail: `Compacting (${reason})…` });
  bus.log('info', `[main] compacting ${session.messages.length} messages (${reason})`);

  const summary = await summarize(model, session.messages, 'main', session.compactSummary, signal);

  // Pending tool calls (assistant tool_calls without results) are dropped with the old context.
  session.archive.push(session.messages.slice());
  session.compactSummary = summary;
  session.compactions += 1;
  session.usage.lastPromptTokens = 0;
  session.messages.splice(
    0,
    session.messages.length,
    { role: 'system', content: mainSystemPrompt() },
    { role: 'user', content: resumeMessage(summary, session.goal?.active ? session.goal.brief : null), ts: Date.now() },
  );
  bus.emit({ type: 'session', session });
  return summary;
}

export async function compactWorker(session: Session, w: WorkerState, signal?: AbortSignal): Promise<void> {
  const model = w.model ?? getSettings().workerModel ?? session.model ?? getSettings().model;
  if (!model || w.messages.length < MIN_MESSAGES_TO_COMPACT) return;
  bus.log('info', `[worker:${w.name}] compacting ${w.messages.length} messages`);
  const prev = w.archive.length ? extractSummary(w.messages) : null;
  const summary = await summarize(model, w.messages, 'worker', prev, signal);
  w.archive.push(w.messages.slice());
  w.messages.splice(
    0,
    w.messages.length,
    { role: 'system', content: workerSystemPrompt(w.name) },
    { role: 'user', content: resumeMessage(summary), ts: Date.now() },
  );
  w.updatedAt = Date.now();
}

function extractSummary(messages: ChatMessage[]): string | null {
  const m = messages[1];
  return m && m.role === 'user' && m.content.startsWith('[Resumed from compacted context]') ? m.content : null;
}

// ---------- Automatic compaction ----------

function overThreshold(model: string | null, messages: ChatMessage[], reportedPromptTokens: number): boolean {
  const threshold = getSettings().autoCompactThreshold;
  if (threshold <= 0) return false;
  const ctx = contextLengthFor(model);
  if (ctx <= 0) return false;
  const used = Math.max(reportedPromptTokens, estimateTokens(messages));
  return used >= ctx * threshold;
}

export async function maybeCompactMain(session: Session, signal: AbortSignal): Promise<void> {
  if (!overThreshold(session.model, session.messages, session.usage.lastPromptTokens)) return;
  if (session.messages.length < MIN_MESSAGES_TO_COMPACT) return;
  try {
    await compactMain(session, signal, 'auto: context nearly full');
  } catch (e) {
    bus.log('warn', `auto-compact failed: ${(e as Error).message}`);
  }
}

export async function maybeCompactWorker(session: Session, w: WorkerState): Promise<void> {
  if (!overThreshold(w.model, w.messages, 0)) return;
  try {
    await compactWorker(session, w);
  } catch (e) {
    bus.log('warn', `worker auto-compact failed: ${(e as Error).message}`);
  }
}
