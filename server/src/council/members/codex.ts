import { getSettings } from '../../config.js';
import { memberEnv, resolveBinary, runJsonl, runQuick } from '../proc.js';
import { detectLimit, parseResetAt, stringify, type MemberAdapter, type MemberResult, type MemberRunOptions } from '../types.js';
import type { MemberBilling } from '@localdex/shared';

function bin(): string | null {
  return resolveBinary('codex', getSettings().council.members.codex.command);
}

type Item = {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: Array<{ path?: string; kind?: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string } | null;
  query?: string;
  items?: Array<{ text?: string; completed?: boolean }>;
};

/**
 * OpenAI Codex CLI: `codex exec --json`. Uses the ChatGPT login from `codex login`.
 * Read-only roles run in Codex's own `read-only` sandbox; the builder gets `workspace-write` (edits limited to the folder).
 */
export const codexMember: MemberAdapter = {
  id: 'codex',
  label: 'Codex',

  async status() {
    const b = bin();
    const base = { id: 'codex' as const, label: 'Codex', loginCommand: 'codex login', canLoginInApp: false };
    if (!b) return { ...base, installed: false, signedIn: false, billing: 'unknown' as MemberBilling };
    const v = runQuick(b, ['--version']);
    const version = (v.stdout || v.stderr).trim().split('\n').find((l) => /codex/i.test(l))?.slice(0, 60);
    const s = runQuick(b, ['login', 'status']);
    const out = `${s.stdout}\n${s.stderr}`;
    const signedIn = /logged in/i.test(out) && !/not logged in/i.test(out);
    const billing: MemberBilling = !signedIn ? 'unknown' : /api key/i.test(out) ? 'api' : /chatgpt/i.test(out) ? 'plan' : 'unknown';
    return { ...base, installed: true, version, path: b, signedIn, billing };
  },

  async run(o: MemberRunOptions): Promise<MemberResult> {
    const b = bin();
    if (!b) return { ok: false, text: '', error: 'Codex CLI not found. Install it (npm i -g @openai/codex) and run `codex login`.', billing: 'unknown' };

    const args = ['exec', '--json', '--skip-git-repo-check', '-C', o.cwd, '-s', o.access === 'write' ? 'workspace-write' : 'read-only', '-c', 'approval_policy="never"'];
    if (o.model) args.push('-m', o.model);
    if (o.access === 'write') for (const d of o.extraDirs) args.push('--add-dir', d);
    args.push('-'); // prompt from stdin

    let lastMessage = '';
    let error = '';
    let usage: MemberResult['usage'];
    const started = new Set<string>();
    const toolName = (it: Item): string =>
      it.type === 'command_execution' ? 'shell' : it.type === 'file_change' ? 'edit' : it.type === 'mcp_tool_call' ? `${it.server ?? 'mcp'}.${it.tool ?? 'tool'}` : it.type === 'web_search' ? 'web_search' : it.type === 'todo_list' ? 'plan' : String(it.type);
    const toolArgs = (it: Item): unknown =>
      it.type === 'command_execution' ? { command: it.command } : it.type === 'file_change' ? { changes: it.changes } : it.type === 'mcp_tool_call' ? it.arguments : it.type === 'web_search' ? { query: it.query } : it.type === 'todo_list' ? { steps: it.items } : {};
    const isTool = (t?: string) => t === 'command_execution' || t === 'file_change' || t === 'mcp_tool_call' || t === 'web_search' || t === 'todo_list';

    const run = await runJsonl(b, args, { cwd: o.cwd, env: memberEnv(), signal: o.signal, timeoutMs: o.timeoutMs, stdin: `${o.instructions}\n\n---\n\n${o.prompt}` }, (ev) => {
      const type = String(ev.type ?? '');
      const it = (ev.item ?? {}) as Item;
      const id = it.id ?? Math.random().toString(36).slice(2);
      if (type === 'item.started' && isTool(it.type)) {
        started.add(id);
        o.onEvent({ kind: 'tool_start', id, name: toolName(it), args: toolArgs(it) });
        return;
      }
      if (type === 'item.completed') {
        if (it.type === 'agent_message' && it.text) {
          const prefix = lastMessage ? '\n\n' : '';
          lastMessage = it.text;
          o.onEvent({ kind: 'text', delta: prefix + it.text });
          return;
        }
        if (it.type === 'reasoning' && it.text) {
          o.onEvent({ kind: 'thinking', delta: `${it.text}\n` });
          return;
        }
        if (isTool(it.type)) {
          if (!started.has(id)) o.onEvent({ kind: 'tool_start', id, name: toolName(it), args: toolArgs(it) });
          const ok = it.type === 'command_execution' ? it.exit_code === 0 : it.status !== 'failed' && !it.error;
          const result =
            it.type === 'command_execution'
              ? `${it.aggregated_output ?? ''}${typeof it.exit_code === 'number' ? `\n[exit ${it.exit_code}]` : ''}`
              : it.type === 'file_change'
                ? (it.changes ?? []).map((c) => `${c.kind ?? 'update'} ${c.path ?? ''}`).join('\n')
                : it.error?.message ?? stringify(it.result);
          o.onEvent({ kind: 'tool_end', id, ok, result: stringify(result) });
          return;
        }
        if (it.type === 'error' && it.text) error = it.text;
        return;
      }
      if (type === 'turn.completed') {
        const u = ev.usage as { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } | undefined;
        if (u) usage = { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 };
        return;
      }
      if (type === 'turn.failed') {
        error = String((ev.error as { message?: string } | undefined)?.message ?? 'turn failed');
        return;
      }
      if (type === 'error') {
        error = String(ev.message ?? 'error');
      }
    });

    // Codex reports billing only through `codex login status`; the orchestrator checks that before the run.
    const billing: MemberBilling = 'unknown';
    if (run.aborted) return { ok: false, text: lastMessage, error: 'Cancelled.', cancelled: true, billing, usage };
    if (run.timedOut) return { ok: false, text: lastMessage, error: `Timed out after ${Math.round(o.timeoutMs / 60000)} min.`, billing, usage };
    const errText = error || (run.code !== 0 ? run.stderrTail || run.plainTail || `exit code ${run.code}` : '');
    if (errText) {
      const limited = detectLimit(errText);
      const notSignedIn = !limited && /not logged in|login|unauthori[sz]ed|401/i.test(errText);
      return {
        ok: false,
        text: lastMessage,
        error: notSignedIn ? `Codex is not signed in. Run \`codex login\` in Terminal. (${errText.slice(0, 300)})` : errText.slice(0, 1500),
        limited,
        limitResetsAt: limited ? parseResetAt(errText) : undefined,
        billing,
        usage,
      };
    }
    return { ok: true, text: lastMessage, billing, usage };
  },
};
