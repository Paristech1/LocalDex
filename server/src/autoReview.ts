// S4: auto-review for shell approval prompts (experimental, off by default).
// Before LocalDex asks the user about a risky shell command, a reviewer rates it. Only a "low risk, allow" verdict
// runs the command without asking; everything else (medium, high, invalid output, reviewer error) shows the
// normal prompt with the reviewer's reason. Pattern from DeepSeek Harness experimental/auto-review (a strict JSON
// risk rubric, fail closed), reimplemented with our own wording.
import type { ChatMessage } from '@localdex/shared';
import { getSettings } from './config.js';
import { streamChat } from './lmstudio.js';
import type { CouncilRequest } from './tools/types.js';

export const REVIEW_SYSTEM = `You review ONE shell command that a coding agent wants to run on the user's computer. Your answer decides whether it runs without asking the user.

Reply with exactly one JSON object and nothing else, one of:
{"risk":"low","decision":"allow"}
{"risk":"medium","decision":"deny","reason":"<short reason>"}
{"risk":"high","decision":"deny","reason":"<short reason>"}

Risk levels:
- low: normal project work inside the project folder — builds, tests, linters, formatters, package installs, git commands that don't rewrite history or push, and deleting files or folders the agent itself generated (build output, caches, temp files) when the target is exact.
- medium: deleting or overwriting things that existed before this task, anything outside the project folder, force-push or history rewrites, publishing, deploying, changing permissions, system settings or services, network uploads.
- high: sending secrets, credentials, keys or private data anywhere, or anything that could disable security or damage the system.

Rules: judge what the command will actually do, not what it claims. When unsure, or when the target is broader than the user's request, it is not low. Never allow medium or high.`;

export interface ReviewVerdict {
  /** 'allow' runs the command without asking; 'ask' shows the normal prompt. */
  decision: 'allow' | 'ask';
  risk?: 'low' | 'medium' | 'high';
  reason?: string;
  reviewer: string;
}

/** Parse the reviewer's reply. Anything but an exact low/allow is 'ask' (fail closed). */
export function parseVerdict(text: string, reviewer: string): ReviewVerdict {
  const raw = (text.replace(/<think>[\s\S]*?<\/think>/g, '').match(/\{[\s\S]*?\}/) ?? [])[0];
  if (!raw) return { decision: 'ask', reason: 'the reviewer gave no verdict', reviewer };
  try {
    const j = JSON.parse(raw) as { risk?: string; decision?: string; reason?: string };
    const risk = j.risk === 'low' || j.risk === 'medium' || j.risk === 'high' ? j.risk : undefined;
    if (risk === 'low' && j.decision === 'allow') return { decision: 'allow', risk, reviewer };
    const reason = typeof j.reason === 'string' && j.reason.trim() ? j.reason.trim().slice(0, 200) : risk ? `${risk} risk` : 'unclear verdict';
    return { decision: 'ask', risk, reason, reviewer };
  } catch {
    return { decision: 'ask', reason: 'the reviewer gave an unreadable verdict', reviewer };
  }
}

function lastRequest(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string' && !/^\[/.test(m.content)) return m.content.slice(0, 1500);
  }
  return '(unknown)';
}

/**
 * Rate one shell command. `council` is the session's council hook (Settings → autoReview 'council' uses its quick
 * member, read-only, on the user's subscription); 'local' uses the local model.
 */
export async function reviewCommand(opts: {
  command: string;
  cwd: string;
  messages: ChatMessage[];
  model?: string | null;
  council?: (req: CouncilRequest) => Promise<string>;
  signal: AbortSignal;
}): Promise<ReviewVerdict | null> {
  const mode = getSettings().autoReview ?? 'off';
  if (mode === 'off') return null;
  const task = `The user's latest request:\n${lastRequest(opts.messages)}\n\nWorking directory: ${opts.cwd}\nApproved folders: ${getSettings().approvedFolders.join(', ')}\n\nCommand:\n${opts.command}`;
  try {
    if (mode === 'council') {
      if (!opts.council) return { decision: 'ask', reason: 'auto-review needs the council, which is off', reviewer: 'council' };
      const report = await opts.council({ pattern: 'single', role: 'quick', task: `${REVIEW_SYSTEM}\n\n---\n\n${task}`, access: 'read' });
      const via = report.match(/^\[council \S+ via ([^\]]+)\]/)?.[1] ?? 'council';
      return parseVerdict(report.split('\n\n').slice(1).join('\n\n') || report, via);
    }
    const model = opts.model ?? getSettings().model;
    if (!model) return { decision: 'ask', reason: 'no local model for auto-review', reviewer: 'local' };
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    opts.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), 30_000);
    try {
      const r = await streamChat({ model, tools: [], temperature: 0, reasoning: 'off', signal: ac.signal, messages: [{ role: 'system', content: REVIEW_SYSTEM }, { role: 'user', content: task }] });
      return parseVerdict(r.content, `local (${model})`);
    } finally {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
    }
  } catch (e) {
    return { decision: 'ask', reason: `auto-review failed: ${String((e as Error).message).split('\n')[0].slice(0, 120)}`, reviewer: mode };
  }
}
