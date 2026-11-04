// U4: fork a session at a message, or edit a user message and re-run from there in a fork (history is never destroyed).
// Pattern from DeepSeek Harness subagent-fork-in-process (a child seeded with the parent's completed turns), reimplemented.
import type { ChatMessage, Session } from '@localdex/shared';
import { createSession, saveNow } from './store.js';

/**
 * Messages [0, end) with no tool call left without its result: an assistant message whose calls are not all
 * answered inside the slice is cut, with everything after it (the next model call would be rejected otherwise).
 */
export function cleanSlice(messages: ChatMessage[], end: number): ChatMessage[] {
  const slice = messages.slice(0, Math.max(0, Math.min(end, messages.length)));
  const answered = new Set(slice.filter((m) => m.role === 'tool').map((m) => (m as Extract<ChatMessage, { role: 'tool' }>).tool_call_id));
  for (let i = 0; i < slice.length; i++) {
    const m = slice[i];
    if (m.role === 'assistant' && m.tool_calls?.length && m.tool_calls.some((c) => !answered.has(c.id))) return structuredClone(slice.slice(0, i));
  }
  return structuredClone(slice);
}

/**
 * A new session with the conversation up to `end` (exclusive). Carries the model, mode, plan, archive and worker
 * memory; not council copies, Solo checkpoints, member vendor sessions, goals, plan mode or stats (those refer to
 * state outside the conversation, or to the original session's undo history).
 */
export function forkAt(src: Session, end: number, title?: string): Session {
  const s = createSession(src.model);
  s.messages = cleanSlice(src.messages, end);
  s.archive = structuredClone(src.archive ?? []);
  s.plan = structuredClone(src.plan ?? []);
  s.workers = structuredClone(src.workers ?? {});
  for (const w of Object.values(s.workers)) w.status = 'idle';
  s.compactions = src.compactions;
  s.compactSummary = src.compactSummary;
  s.mode = src.mode;
  s.title = (title ?? `${src.title} (fork)`).slice(0, 80);
  // Not 'default', so the automatic title never replaces it; the user can still rename it.
  s.titleSource = 'auto';
  s.forkedFrom = { sessionId: src.id, title: src.title, at: s.messages.length };
  saveNow(s);
  return s;
}

/** The index of a user message the UI may edit (not an internal [system]/[Goal]… note). */
export function isEditableUserMessage(src: Session, index: number): boolean {
  const m = src.messages[index];
  return !!m && m.role === 'user' && typeof m.content === 'string' && !/^\[/.test(m.content);
}
