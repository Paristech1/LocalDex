// Stand-in for @cursor/sdk's Agent/Cursor API surface, for LocalDex tests only.
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const c = require('./fakebin/_common.cjs');
export const Cursor = {
  models: {
    async list() {
      if (c.flag('cursor_signed_out')) { const e = new Error('API key is required'); e.name = 'AuthenticationError'; throw e; }
      return [{ id: 'composer-fake-2', displayName: 'Composer Fake 2' }, { id: 'gpt-fake-6', displayName: 'GPT Fake 6', aliases: ['gpt-6'] }];
    },
  },
  auth: {
    async status() { return c.flag('cursor_signed_out') ? { status: 'logged-out' } : { status: 'logged-in', email: 'paris@example.com' }; },
    async login({ onLoginUrl }) { onLoginUrl?.('https://cursor.com/loginDeepControl?challenge=test'); await c.sleep(500); return { apiKey: 'redacted', email: 'paris@example.com' }; },
  },
};
export const Agent = {
  async create(opts) {
    const readOnly = (opts.disallowedTools ?? []).includes('edit');
    const role = c.role(opts.systemPrompt ?? '');
    return {
      async send(prompt) {
        c.record('cursor', { opts, prompt });
        const cwd = opts.local.cwd; let status = 'running'; const text = c.answer(role, 'cursor', prompt);
        return {
          async *stream() {
            yield { type: 'system', subtype: 'init', agent_id: 'a1', run_id: 'r1', model: opts.model };
            // cursor_limit: out of quota before doing anything; cursor_limit_midway: edits first, then hits the limit.
            if (c.flag('cursor_limit')) { status = 'error'; return; }
            await c.sleep(300);
            yield { type: 'tool_call', agent_id: 'a1', run_id: 'r1', call_id: 'c1', name: 'read', status: 'running', args: { path: 'src/math.ts' } };
            await c.sleep(300);
            yield { type: 'tool_call', agent_id: 'a1', run_id: 'r1', call_id: 'c1', name: 'read', status: 'completed', result: 'export function add…' };
            if (!readOnly && role === 'builder') {
              yield { type: 'tool_call', agent_id: 'a1', run_id: 'r1', call_id: 'c2', name: 'edit', status: 'running', args: { path: 'src/rateLimit.ts' } };
              fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
              fs.writeFileSync(path.join(cwd, 'src/rateLimit.ts'), '// sliding window rate limiter (cursor)\nexport const rateLimit = (max = 60) => (ip: string) => true;\n');
              await c.sleep(300);
              yield { type: 'tool_call', agent_id: 'a1', run_id: 'r1', call_id: 'c2', name: 'edit', status: 'completed', result: 'wrote src/rateLimit.ts' };
            }
            if (c.flag('cursor_limit_midway')) {
              yield { type: 'assistant', agent_id: 'a1', run_id: 'r1', message: { role: 'assistant', content: [{ type: 'text', text: 'Created src/rateLimit.ts. Next: wire it into src/server.ts.' }] } };
              status = 'error'; return;
            }
            yield { type: 'assistant', agent_id: 'a1', run_id: 'r1', message: { role: 'assistant', content: [{ type: 'text', text }] } };
            yield { type: 'usage', agent_id: 'a1', run_id: 'r1', usage: { inputTokens: 4200, outputTokens: 380 } };
            status = 'finished';
          },
          async wait() { return status === 'error' ? { id: 'r1', status: 'error', error: { message: 'Rate limit exceeded for your plan. Try again in 30 minutes.', code: 'resource_exhausted' } } : { id: 'r1', status: 'finished', result: text, model: opts.model, usage: { inputTokens: 4200, outputTokens: 380 } }; },
          async cancel() { status = 'cancelled'; },
        };
      },
      close() {},
    };
  },
};
