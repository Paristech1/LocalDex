import type { Session } from '@localdex/shared';
import { getSettings } from '../config.js';
import { streamChat } from '../lmstudio.js';
import { bus } from './bus.js';
import { renderTranscript } from './compact.js';
import { goalAssessPrompt } from './prompts.js';

export interface Assessment {
  done: boolean;
  remaining: string[];
  note: string;
}

/** Ask the model to audit progress against the goal using the recent transcript. */
export async function assessGoal(session: Session, signal: AbortSignal): Promise<Assessment> {
  const goal = session.goal;
  const model = session.model ?? getSettings().model;
  if (!goal || !model) return { done: true, remaining: [], note: 'no goal' };

  bus.emit({ type: 'agent_status', sessionId: session.id, agent: 'main', status: 'thinking', detail: 'Finish checkpoint…' });

  // Use the tail of the transcript so the audit fits comfortably in context.
  const recent = session.messages.slice(-30);
  const transcript = renderTranscript(recent).slice(-40_000);

  try {
    const res = await streamChat({
      model,
      messages: [
        { role: 'system', content: goalAssessPrompt(goal.brief, goal.doneCriteria, goal.mode) },
        { role: 'user', content: `Transcript excerpt (most recent last):\n\n${transcript}\n\nRespond with the JSON object only.` },
      ],
      tools: [],
      temperature: 0,
      signal,
    });
    const parsed = parseAssessment(res.content);
    if (goal.mode === 'loop') parsed.done = false;
    return parsed;
  } catch (e) {
    if (signal.aborted) return { done: false, remaining: [], note: 'cancelled' };
    bus.log('warn', `goal assessment failed: ${(e as Error).message}`);
    // Fail open: assume not done so the user keeps control via Stop/iteration cap.
    return { done: false, remaining: [], note: `assessment failed: ${(e as Error).message}` };
  }
}

function parseAssessment(text: string): Assessment {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as { done?: unknown; remaining?: unknown; note?: unknown };
      return {
        done: o.done === true || o.done === 'true',
        remaining: Array.isArray(o.remaining) ? o.remaining.map(String).slice(0, 12) : [],
        note: typeof o.note === 'string' ? o.note : '',
      };
    } catch {
      /* fall through */
    }
  }
  const done = /\bdone["']?\s*:\s*true\b/i.test(text) || /^(yes|done|complete)/i.test(text.trim());
  return { done, remaining: [], note: text.slice(0, 200) };
}
