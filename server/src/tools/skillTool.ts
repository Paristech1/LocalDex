import { fail, ok, optStr, str, type ToolDef } from './types.js';
import { readSkill } from '../skills/store.js';

export const load_skill: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'load_skill',
      description:
        'Load an installed skill (reusable instructions) by name and return its full text. Call this first when the task matches a skill listed in the system prompt. Optionally pass `file` to read one of the skill\'s bundled files.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name exactly as listed.' },
          file: { type: 'string', description: 'Optional relative path of a bundled file inside the skill, e.g. "reference/api.md".' },
        },
        required: ['name'],
      },
    },
  },
  async run(args) {
    const r = readSkill(str(args.name, 'name').trim(), optStr(args.file)?.trim() || undefined);
    return r.ok ? ok(r.text) : fail(r.text);
  },
};
