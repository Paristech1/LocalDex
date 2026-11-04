import fs from 'node:fs/promises';
import type { ChatMessage, Session, WorkerState } from '@localdex/shared';
import { getSettings } from '../config.js';
import { describeTextLine, parseLenientJson } from '../jsonRepair.js';
import { resolvePath } from '../tools/permissions.js';
import { contextLengthFor, estimateTokens, streamChat } from '../lmstudio.js';
import { bus } from './bus.js';
import { compactPrompt, mainSystemPrompt, workerSystemPrompt } from './prompts.js';
import { resetReads } from '../tools/readTracker.js';

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

const FILE_TOOLS = new Set(['write_file', 'edit_file']);

/**
 * Ground truth for summaries and goal checkpoints: every file the agent wrote or edited in `messages`, checked on disk
 * now (exists, line count in `wc -l` terms, size). Small models misremember these; this block does not.
 */
export async function verifiedFileFacts(messages: ChatMessage[], max = 40): Promise<string> {
  const paths: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const tc of m.tool_calls ?? []) {
      if (!FILE_TOOLS.has(tc.function.name)) continue;
      const a = parseLenientJson(tc.function.arguments) as { path?: unknown } | undefined;
      if (typeof a?.path === 'string' && a.path.trim()) paths.push(a.path.trim());
    }
  }
  const unique = [...new Set(paths.reverse())].reverse().slice(-max);
  const lines: string[] = [];
  for (const p of unique) {
    let abs = p;
    try {
      abs = resolvePath(p);
      const st = await fs.stat(abs);
      if (st.isDirectory()) lines.push(`- ${abs}: a directory`);
      else if (st.size > 2_000_000) lines.push(`- ${abs}: ${st.size} bytes`);
      else lines.push(`- ${abs}: ${describeTextLine(await fs.readFile(abs, 'utf8'))}`);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      lines.push(`- ${abs}: ${code === 'ENOENT' ? 'does not exist' : `could not be checked (${(e as Error).message.slice(0, 80)})`}`);
    }
  }
  return lines.length
    ? `Files on disk right now (checked by LocalDex, not recalled by the model; trust this over anything above):\n${lines.join('\n')}`
    : '';
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
    reasoning: 'off',
  });
  const facts = await verifiedFileFacts(messages).catch(() => '');
  return [res.content.trim() || '(summary unavailable)', facts].filter(Boolean).join('\n\n');
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
  // The reads that allowed edits are no longer in the context.
  resetReads(session.id, 'main');
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
  resetReads(session.id, `worker:${w.name}`);
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

/** Tool results longer than this are pruned when the context gets tight… */
export const PRUNE_OVER = 8_192;
/** …to their first PRUNE_HEAD and last PRUNE_TAIL characters. */
export const PRUNE_HEAD = 4_096;
export const PRUNE_TAIL = 1_024;
export const PRUNE_MARK = '\n\n[... tool result middle pruned ...]\n\n';

/**
 * Cheap first step before summarizing (pattern borrowed from DeepSeek Harness `compaction-tool-result-pruner`,
 * reimplemented): shorten old tool results that are over PRUNE_OVER characters to head + marker + tail. The latest
 * turn (everything after the last user message) is left alone, so the model still has what it just asked for; the
 * full text stays on the message as `original` for the session log. Returns how many were pruned and the characters saved.
 */
export function pruneToolResults(messages: ChatMessage[]): { pruned: number; savedChars: number } {
  let lastUser = -1;
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'user') lastUser = i;
  let pruned = 0;
  let savedChars = 0;
  for (let i = 0; i < lastUser; i++) {
    const m = messages[i];
    if (m.role !== 'tool' || m.content.length <= PRUNE_OVER || m.original !== undefined) continue;
    const short = `${m.content.slice(0, PRUNE_HEAD)}${PRUNE_MARK}${m.content.slice(-PRUNE_TAIL)}`;
    savedChars += m.content.length - short.length;
    m.original = m.content;
    m.content = short;
    pruned++;
  }
  return { pruned, savedChars };
}

export async function maybeCompactMain(session: Session, signal: AbortSignal): Promise<void> {
  if (!overThreshold(session.model, session.messages, session.usage.lastPromptTokens)) return;
  if (session.messages.length < MIN_MESSAGES_TO_COMPACT) return;
  // Trim first: often enough, and it costs no model call.
  const t = pruneToolResults(session.messages);
  if (t.pruned) {
    // LM Studio's last report is stale now; judge by the estimate of what is left.
    session.usage.lastPromptTokens = 0;
    const fits = !overThreshold(session.model, session.messages, 0);
    bus.log('info', `[main] pruned ${t.pruned} old tool result${t.pruned === 1 ? '' : 's'}, saved ~${Math.round(t.savedChars / 3.5)} tokens${fits ? '; no summary needed' : '; still over the threshold, summarizing'}`);
    if (fits) return;
  }
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
