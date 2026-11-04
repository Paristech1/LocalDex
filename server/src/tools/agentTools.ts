import type { PlanStep } from '@localdex/shared';
import { fail, ok, str, type ToolDef } from './types.js';

export const ask_user: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        'Ask the user a question and wait for their answer. Use when you need a decision or missing information you cannot infer.',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
    },
  },
  async run(args, ctx) {
    const q = str(args.question, 'question');
    const answer = await ctx.askUser(q);
    return ok(`User answered: ${answer}`);
  },
};

export const delegate_to_worker: ToolDef = {
  mainOnly: true,
  schema: {
    type: 'function',
    function: {
      name: 'delegate_to_worker',
      description:
        'Delegate an independent task to a named worker agent. Workers have the same file/shell tools and keep their own conversation history, so reusing a name continues that worker\'s context. Call this tool several times in one turn to run tasks in parallel. Returns the worker\'s final report.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short worker name, e.g. "tests" or "frontend".' },
          task: {
            type: 'string',
            description: 'Complete, self-contained instructions. Include file paths and what to report back.',
          },
        },
        required: ['name', 'task'],
      },
    },
  },
  async run(args, ctx) {
    if (!ctx.delegate) return fail('Workers can only be spawned by the main agent.');
    const name = str(args.name, 'name').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'worker';
    const task = str(args.task, 'task');
    const result = await ctx.delegate(name, task);
    return ok(`[worker "${name}" report]\n${result}`);
  },
};

export const update_plan: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'update_plan',
      description:
        'Replace the visible task plan. Call at the start of multi-step work and whenever a step changes status. Keep steps short.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'skipped'] },
              },
              required: ['title', 'status'],
            },
          },
        },
        required: ['steps'],
      },
    },
  },
  async run(args, ctx) {
    if (!ctx.updatePlan) return fail('Plan updates are not available here.');
    const steps = normalizePlan(args);
    if (!steps) return fail('steps must be a list, e.g. {"steps": [{"title": "Write the file", "status": "in_progress"}, {"title": "Run tests", "status": "pending"}]}');
    ctx.updatePlan(steps);
    const summary = steps.map((s) => `${mark(s.status)} ${s.title}`).join('\n');
    const open = steps.some((s) => s.status !== 'done' && s.status !== 'skipped');
    return ok(`Plan updated:\n${summary}${open ? '\nWhen a step finishes, call update_plan again with the whole list and that step set to "done".' : ''}`);
  },
};

const STATUS_WORDS: Array<[RegExp, PlanStep['status']]> = [
  [/^(done|complete|completed|finished|success|ok|x|✓|✔|true|yes|closed|resolved)$/i, 'done'],
  [/^(in[ _-]?progress|active|doing|current|started|running|wip|working|>|ongoing)$/i, 'in_progress'],
  [/^(skipped|skip|cancelled|canceled|dropped|-|n\/a|not needed)$/i, 'skipped'],
  [/^(pending|todo|to do|open|not started|waiting|queued|next|planned|false|no|\s*)$/i, 'pending'],
];

function statusFrom(v: unknown): PlanStep['status'] {
  if (v === true) return 'done';
  const t = String(v ?? '').trim();
  for (const [re, st] of STATUS_WORDS) if (re.test(t)) return st;
  return 'pending';
}

/**
 * Accept the many shapes small models send: strings ("Write file", "[x] Write file"), objects with
 * title/step/content/text/name/task/description, done/completed booleans, status synonyms, and
 * the list under steps/plan/items/tasks/todos (or the whole argument being the list).
 */
export function normalizePlan(args: Record<string, unknown> | unknown[]): PlanStep[] | null {
  let raw: unknown = Array.isArray(args) ? args : (args.steps ?? args.plan ?? args.items ?? args.tasks ?? args.todos);
  if (typeof raw === 'string') {
    const parsed = (() => {
      try {
        return JSON.parse(raw as string) as unknown;
      } catch {
        return null;
      }
    })();
    // A plain multi-line string: one step per line.
    raw = parsed ?? (raw as string).split('\n').map((l) => l.trim()).filter(Boolean);
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.slice(0, 30).map((s, i) => {
    if (typeof s === 'string' || typeof s === 'number') {
      const text = String(s).trim();
      const m = /^(?:[-*•]|\d+[.)])?\s*\[(.)\]\s*(.*)$/.exec(text) ?? /^([✓✔✗>])\s*(.*)$/.exec(text);
      if (m) {
        const marker = m[1];
        const st: PlanStep['status'] = /[xX✓✔]/.test(marker) ? 'done' : marker === '>' ? 'in_progress' : marker === '-' ? 'skipped' : 'pending';
        return { id: `s${i + 1}`, title: m[2].trim() || `Step ${i + 1}`, status: st };
      }
      return { id: `s${i + 1}`, title: text.replace(/^(?:[-*•]|\d+[.)])\s*/, '') || `Step ${i + 1}`, status: 'pending' };
    }
    const o = (s ?? {}) as Record<string, unknown>;
    const title = o.title ?? o.step ?? o.content ?? o.text ?? o.name ?? o.task ?? o.description ?? o.label;
    let status: PlanStep['status'] = statusFrom(o.status ?? o.state);
    if (o.status === undefined && o.state === undefined) {
      if (o.done === true || o.completed === true || o.checked === true) status = 'done';
      else if (o.in_progress === true || o.active === true) status = 'in_progress';
    }
    return { id: `s${i + 1}`, title: String(title ?? `Step ${i + 1}`).trim() || `Step ${i + 1}`, status };
  });
}

function mark(s: PlanStep['status']): string {
  return s === 'done' ? '[x]' : s === 'in_progress' ? '[>]' : s === 'skipped' ? '[-]' : '[ ]';
}
