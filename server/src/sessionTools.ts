// U1: session search, export and automatic titles.
// Patterns from DeepSeek Harness session-query (full-text search over session logs), session-log-export
// (Markdown/JSON export) and session-title-first-prompt-llm (one short model call for a title). Reimplemented;
// search uses MiniSearch (pure JS, typo-tolerant) so there is no native dependency.
import MiniSearch from 'minisearch';
import type { ChatMessage, Session } from '@localdex/shared';
import { getSettings } from './config.js';
import { streamChat } from './lmstudio.js';
import { getSession, listSessions, saveSession } from './store.js';
import { bus } from './agent/bus.js';

export interface SessionHit {
  id: string;
  title: string;
  updatedAt: number;
  /** A short piece of text around the first match. */
  snippet: string;
  score: number;
}

/** Text the user and the model actually wrote (no tool output, no internal [system]/[context] notes). */
function searchableText(s: Session): string {
  const parts: string[] = [];
  for (const m of [...(s.archive ?? []).flat(), ...s.messages]) {
    if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
    if (/^\[(system|context)\]/.test(m.content)) continue;
    parts.push(m.content);
  }
  return parts.join('\n');
}

function snippetFor(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    at = lower.indexOf(t.toLowerCase());
    if (at >= 0) break;
  }
  if (at < 0) return text.slice(0, 140).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, at - 50);
  return `${start > 0 ? '…' : ''}${text.slice(start, at + 90).replace(/\s+/g, ' ').trim()}…`;
}

/** Search every session's title and messages. Typo-tolerant and prefix-matching; best match first. */
export function searchSessions(query: string, limit = 30): SessionHit[] {
  const q = query.trim();
  if (!q) return [];
  const docs = listSessions().map((sum) => {
    const s = getSession(sum.id);
    return { id: sum.id, title: sum.title, updatedAt: sum.updatedAt, text: s ? searchableText(s) : '' };
  });
  const ms = new MiniSearch({ fields: ['title', 'text'], storeFields: ['title', 'updatedAt', 'text'], searchOptions: { boost: { title: 3 }, fuzzy: 0.2, prefix: true, combineWith: 'AND' } });
  ms.addAll(docs);
  return ms
    .search(q)
    .slice(0, limit)
    .map((r) => ({ id: String(r.id), title: r.title as string, updatedAt: r.updatedAt as number, score: Math.round(r.score * 100) / 100, snippet: snippetFor(r.text as string, r.terms) }));
}

// ---------- export ----------

function roleLabel(m: ChatMessage): string {
  if (m.role === 'user') return 'You';
  if (m.role === 'assistant') return m.via ? `☁ ${m.via}` : 'LocalDex';
  if (m.role === 'tool') return `Tool result (${m.name ?? 'tool'})`;
  return 'System';
}

function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((x) => x.length));
  const f = '`'.repeat(longest + 1);
  return `${f}\n${text}\n${f}`;
}

/** The whole conversation as Markdown: messages in order, tool calls and results in collapsible blocks. */
export function exportMarkdown(s: Session): string {
  const out: string[] = [
    `# ${s.title}`,
    '',
    `- Session: \`${s.id}\` · created ${new Date(s.createdAt).toISOString()} · updated ${new Date(s.updatedAt).toISOString()}`,
    `- Model: ${s.model ?? '(none)'}${s.mode === 'council' ? ' · Council mode' : ''}`,
    ...(s.compactions ? [`- Compacted ${s.compactions}× (earlier parts are under "Archived" at the end)`] : []),
    '',
  ];
  const render = (messages: ChatMessage[]) => {
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        out.push(`<details><summary>${roleLabel(m)}${m.ok === false ? ' — failed' : ''}</summary>`, '', fence(body), '', '</details>', '');
        continue;
      }
      if (typeof m.content === 'string' && m.content.trim()) out.push(`### ${roleLabel(m)}`, '', m.content.trim(), '');
      for (const tc of (m.role === 'assistant' ? m.tool_calls : undefined) ?? []) {
        out.push(`<details><summary>Tool call: <code>${tc.function.name}</code></summary>`, '', fence(tc.function.arguments || '{}'), '', '</details>', '');
      }
    }
  };
  render(s.messages);
  if (s.archive?.length) {
    out.push('---', '', '## Archived (before Compact & Resume)', '');
    s.archive.forEach((part, i) => {
      out.push(`### Part ${i + 1}`, '');
      render(part);
    });
  }
  return out.join('\n');
}

/** A filesystem-safe download name. */
export function exportFileName(s: Session, ext: 'md' | 'json'): string {
  const slug = s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'session';
  return `localdex-${slug}-${s.id}.${ext}`;
}

// ---------- automatic titles ----------

/** The placeholder title the runner gives a session from the first line of its first message. */
export function isDefaultTitle(s: Session): boolean {
  if (s.titleSource === 'user' || s.titleSource === 'auto') return false;
  return true;
}

/**
 * Ask the local model for a short title once the first run has finished (never during it: LM Studio serves one
 * request per model, so a title call would delay the user's run). Skipped when the user renamed the session,
 * when Settings → autoTitle is off, or with no local model. One short call, no tools, reasoning off.
 */
export async function autoTitle(s: Session): Promise<boolean> {
  const st = getSettings();
  if (st.autoTitle === false || !isDefaultTitle(s)) return false;
  const model = s.model ?? st.model;
  const first = s.messages.find((m) => m.role === 'user' && typeof m.content === 'string' && !/^\[/.test(m.content));
  if (!model || !first) return false;
  const reply = s.messages.find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const r = await streamChat({
      model,
      temperature: 0,
      tools: [],
      reasoning: 'off',
      signal: ac.signal,
      messages: [
        { role: 'system', content: 'Write a title for this chat: 3 to 7 words, no quotes, no trailing period, no emoji. Reply with the title only.' },
        { role: 'user', content: `Request: ${(first.content as string).slice(0, 1500)}${reply ? `\n\nAnswer (start): ${(reply.content as string).slice(0, 500)}` : ''}` },
      ],
    });
    const title = cleanTitle(r.content);
    if (!title || !isDefaultTitle(s)) return false; // the user may have renamed it meanwhile
    s.title = title;
    s.titleSource = 'auto';
    saveSession(s);
    bus.emit({ type: 'sessions', sessions: listSessions() });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function cleanTitle(raw: string): string {
  const line = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim().split('\n').find((l) => l.trim()) ?? '';
  return line
    .replace(/^(title\s*:\s*)/i, '')
    .replace(/^["'“”‘’`*#\s]+|["'“”‘’`*.\s]+$/g, '')
    .slice(0, 60)
    .trim();
}
