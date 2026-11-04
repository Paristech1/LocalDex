import { fail, ok, optNum, optStr, str, type ToolDef } from './types.js';

/**
 * Goal tools (A5). Pattern from DeepSeek Harness `goal/tool-goal`, reimplemented: the model reads the goal, trims the
 * remaining list, and marks it complete or blocked itself, with a revision id so a stale update is refused. Offered
 * only while a goal is running, so they cost nothing otherwise.
 */

const NO_GOAL = 'There is no active goal in this session.';

function revision(v: unknown): number | undefined {
  const n = optNum(v);
  return n === undefined ? undefined : Math.floor(n);
}

export const get_goal: ToolDef = {
  mainOnly: true,
  schema: {
    type: 'function',
    function: {
      name: 'get_goal',
      description: 'Read the active goal: brief, done criteria, remaining items, iteration and the current revision id (needed by update_goal, complete_goal and block_goal).',
      parameters: { type: 'object', properties: {} },
    },
  },
  async run(_args, ctx) {
    if (!ctx.goal) return fail(NO_GOAL);
    return ok(ctx.goal.view());
  },
};

export const update_goal: ToolDef = {
  mainOnly: true,
  schema: {
    type: 'function',
    function: {
      name: 'update_goal',
      description: 'Replace the list of remaining items for the active goal (what is still not done). Pass the revision id from get_goal.',
      parameters: {
        type: 'object',
        properties: {
          revision: { type: 'integer', description: 'Current revision id from get_goal.' },
          remaining: { type: 'array', items: { type: 'string' }, description: 'Everything still to do, short items.' },
          note: { type: 'string', description: 'One line on progress (optional).' },
        },
        required: ['revision', 'remaining'],
      },
    },
  },
  async run(args, ctx) {
    if (!ctx.goal) return fail(NO_GOAL);
    const rev = revision(args.revision);
    if (rev === undefined) return fail('revision is required: call get_goal first and pass its revision id.');
    const remaining = Array.isArray(args.remaining) ? args.remaining.map((r) => String(r).trim()).filter(Boolean).slice(0, 30) : undefined;
    return ctx.goal.update(rev, { remaining, note: optStr(args.note) });
  },
};

export const complete_goal: ToolDef = {
  mainOnly: true,
  schema: {
    type: 'function',
    function: {
      name: 'complete_goal',
      description: 'Mark the active goal as finished. Only after you verified the done criteria with tool results (tests run, files checked). Pass the revision id from get_goal.',
      parameters: {
        type: 'object',
        properties: {
          revision: { type: 'integer' },
          summary: { type: 'string', description: 'What was done and how it was verified.' },
        },
        required: ['revision', 'summary'],
      },
    },
  },
  async run(args, ctx) {
    if (!ctx.goal) return fail(NO_GOAL);
    const rev = revision(args.revision);
    if (rev === undefined) return fail('revision is required: call get_goal first and pass its revision id.');
    return ctx.goal.complete(rev, str(args.summary, 'summary'));
  },
};

export const block_goal: ToolDef = {
  mainOnly: true,
  schema: {
    type: 'function',
    function: {
      name: 'block_goal',
      description: 'Report that the goal cannot progress right now (missing access, a decision only the user can make, a failing dependency). Say exactly what is needed. After 3 consecutive blocked rounds the goal stops and the user is told.',
      parameters: {
        type: 'object',
        properties: {
          revision: { type: 'integer' },
          reason: { type: 'string', description: 'What blocks the goal and what would unblock it.' },
        },
        required: ['revision', 'reason'],
      },
    },
  },
  async run(args, ctx) {
    if (!ctx.goal) return fail(NO_GOAL);
    const rev = revision(args.revision);
    if (rev === undefined) return fail('revision is required: call get_goal first and pass its revision id.');
    return ctx.goal.block(rev, str(args.reason, 'reason'));
  },
};
