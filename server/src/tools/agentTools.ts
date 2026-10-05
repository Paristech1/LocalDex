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
    let raw = args.steps;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        return fail('steps must be an array of {title, status}.');
      }
    }
    if (!Array.isArray(raw)) return fail('steps must be an array of {title, status}.');
    const steps: PlanStep[] = raw.map((s, i) => {
      const o = (s ?? {}) as Record<string, unknown>;
      const status = String(o.status ?? 'pending');
      return {
        id: `s${i + 1}`,
        title: String(o.title ?? o.step ?? o.content ?? `Step ${i + 1}`),
        status: (['pending', 'in_progress', 'done', 'skipped'].includes(status) ? status : 'pending') as PlanStep['status'],
      };
    });
    ctx.updatePlan(steps);
    const summary = steps.map((s) => `${mark(s.status)} ${s.title}`).join('\n');
    return ok(`Plan updated:\n${summary}`);
  },
};

function mark(s: PlanStep['status']): string {
  return s === 'done' ? '[x]' : s === 'in_progress' ? '[>]' : s === 'skipped' ? '[-]' : '[ ]';
}
