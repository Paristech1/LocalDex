// U3: the user's 👍/👎 on answers. Stored on the message (the session log) and rolled up: local answers per local
// model (<DATA_DIR>/feedback.json), council answers per member in the council scorecard.
// Pattern from DeepSeek Harness packages/feedback/message-feedback (ratings and a fixed category list), reimplemented.
import fs from 'node:fs';
import path from 'node:path';
import { FEEDBACK_CATEGORIES, type CouncilMemberRef, type FeedbackCategory, type FeedbackStats, type MessageFeedback, type Session } from '@localdex/shared';
import { DATA_DIR } from './config.js';
import { bus } from './agent/bus.js';
import { recordFeedback } from './council/stats.js';

const file = () => path.join(DATA_DIR, 'feedback.json');
let cache: FeedbackStats | null = null;

export function feedbackStats(): FeedbackStats {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as FeedbackStats;
    cache = { models: raw && typeof raw.models === 'object' ? raw.models : {} };
  } catch {
    cache = { models: {} };
  }
  return cache;
}

function save(): void {
  const s = feedbackStats();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(s, null, 2));
  } catch {
    /* best effort */
  }
  bus.emit({ type: 'feedback_stats', stats: s });
}

function bumpModel(model: string, fb: MessageFeedback, delta: 1 | -1): void {
  const m = (feedbackStats().models[model] ??= { up: 0, down: 0, categories: {} });
  m[fb.rating] = Math.max(0, m[fb.rating] + delta);
  if (fb.category) m.categories[fb.category] = Math.max(0, (m.categories[fb.category] ?? 0) + delta);
}

/** Who gets the credit: the local model, or every council member with a finished step in the run. */
function creditFor(s: Session, index: number): { model?: string; members: CouncilMemberRef[] } {
  const m = s.messages[index];
  if (m?.role !== 'assistant') return { members: [] };
  if (m.councilRunId) {
    const run = s.councilRuns?.find((r) => r.id === m.councilRunId);
    const members = [...new Set((run?.steps ?? []).filter((st) => st.status === 'done' && st.role !== 'checks').map((st) => st.member))];
    return { members };
  }
  return { model: m.model ?? s.model ?? undefined, members: [] };
}

function apply(s: Session, index: number, fb: MessageFeedback, delta: 1 | -1): void {
  const c = creditFor(s, index);
  if (c.model) bumpModel(c.model, fb, delta);
  for (const ref of c.members) recordFeedback(ref, fb.rating, delta);
}

/** Set, change or clear the rating on assistant message `index`. Returns false if that message can't be rated. */
export function rateMessage(s: Session, index: number, rating: 'up' | 'down' | null, category?: FeedbackCategory): boolean {
  const m = s.messages[index];
  if (!m || m.role !== 'assistant' || !m.content) return false;
  if (category && !FEEDBACK_CATEGORIES.includes(category)) category = undefined;
  if (!m.councilRunId && !m.model && s.model) m.model = s.model;
  const prev = m.feedback;
  if (prev) apply(s, index, prev, -1);
  if (rating) {
    m.feedback = { rating, ...(rating === 'down' && category ? { category } : {}), ts: Date.now() };
    apply(s, index, m.feedback, 1);
  } else {
    delete m.feedback;
  }
  save();
  return true;
}
