import type { CouncilMemberRef, CouncilPattern, CouncilRole } from '@localdex/shared';
import { domainBuilder, mentionsImage } from '../council/router.js';
import { fail, ok, optStr, str, type ToolDef } from './types.js';

const MEMBERS = ['auto', 'claude', 'codex', 'gemini', 'cursor'];
const PATTERNS: CouncilPattern[] = ['plan_build_review', 'second_opinion', 'vote'];

export const ask_member: ToolDef = {
  mainOnly: true,
  schema: {
    type: 'function',
    function: {
      name: 'ask_member',
      description:
        'Hand a task to a stronger cloud model on the user\'s council (Claude, Codex, Gemini or Cursor; they run on the user\'s subscriptions and work directly in the project folder). Use for hard problems, big changes, code review, or reading a large codebase. member "auto" picks the best available one. access "write" lets it edit files; "read" (default) is read-only. Returns the member\'s final report.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Complete, self-contained instructions, including file paths and what to report back.' },
          member: { type: 'string', enum: MEMBERS, description: 'Default "auto".' },
          access: { type: 'string', enum: ['read', 'write'], description: 'Default "read".' },
        },
        required: ['task'],
      },
    },
  },
  async run(args, ctx) {
    if (!ctx.council) return fail('The model council is not available here. The user can turn it on in Settings → Council.');
    const task = str(args.task, 'task');
    const member = (optStr(args.member) ?? 'auto').toLowerCase();
    if (!MEMBERS.includes(member)) return fail(`member must be one of: ${MEMBERS.join(', ')}`);
    const write = optStr(args.access) === 'write';
    const role: CouncilRole = write
      ? domainBuilder(task).role
      : mentionsImage(task) ? 'vision' : /review|audit|check/i.test(task) ? 'reviewer' : /plan|design/i.test(task) ? 'planner' : 'researcher';
    const report = await ctx.council({ pattern: 'single', role, member: member === 'auto' ? undefined : (member as CouncilMemberRef), task, access: write ? 'write' : 'read' });
    return ok(report);
  },
};

export const council: ToolDef = {
  mainOnly: true,
  schema: {
    type: 'function',
    function: {
      name: 'council',
      description:
        'Run a multi-model council pattern on the user\'s cloud subscriptions. "plan_build_review": one model plans, another implements in the project folder, a third reviews the diff (with a fix round). "second_opinion": one implements, another critiques. "vote": several models answer a question independently and a judge combines them (read-only). Returns the combined result.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', enum: PATTERNS },
          task: { type: 'string', description: 'The task or question, complete and self-contained.' },
        },
        required: ['pattern', 'task'],
      },
    },
  },
  async run(args, ctx) {
    if (!ctx.council) return fail('The model council is not available here. The user can turn it on in Settings → Council.');
    const pattern = str(args.pattern, 'pattern') as CouncilPattern;
    if (!PATTERNS.includes(pattern)) return fail(`pattern must be one of: ${PATTERNS.join(', ')}`);
    const task = str(args.task, 'task');
    return ok(await ctx.council({ pattern, role: pattern === 'vote' ? 'researcher' : domainBuilder(task).role, task }));
  },
};
