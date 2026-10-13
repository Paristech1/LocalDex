import { getSettings } from '../../config.js';
import { memberEnv, resolveBinary, runCapture, runJsonl, runQuick } from '../proc.js';
import { detectLimit, parseResetAt, stringify, type MemberAdapter, type MemberResult, type MemberRunOptions } from '../types.js';
import type { MemberBilling } from '@localdex/shared';

/** Claude Code's documented model aliases. It has no command that lists models, so these are suggestions. */
const CLAUDE_ALIASES = ['sonnet', 'opus', 'haiku'];

/** Aliases quoted in the `--model` help text (e.g. "an alias for the latest model (e.g. 'opus' or 'sonnet')"). */
export function aliasesFromHelp(help: string): string[] {
  const i = help.indexOf('--model <model>');
  if (i < 0) return [];
  const block = help.slice(i, i + 600).split(/\n\s*-/)[0];
  return [...block.matchAll(/'([a-z][a-z0-9.-]{1,30})'/g)].map((m) => m[1]);
}

/** Tools that change files. Blocked for read-only council roles. */
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/**
 * Print mode skips the workspace-trust prompt, so a cloned repo's .claude/settings.json (hooks, permissions)
 * and .mcp.json would load unasked. By default load only the user's own settings and no MCP servers at all
 * (--strict-mcp-config with no --mcp-config). Both flags take a single value / none, so nothing variadic
 * follows them here; the prompt goes in on stdin.
 */
export function projectConfigArgs(trustProject: boolean): string[] {
  return trustProject ? ['--setting-sources', 'user,project,local'] : ['--setting-sources', 'user', '--strict-mcp-config'];
}

function bin(): string | null {
  return resolveBinary('claude', getSettings().council.members.claude.command);
}

/**
 * Claude Code in print mode: `claude -p --output-format stream-json --verbose --include-partial-messages`.
 * Runs on whatever the user is signed into with `claude auth login` (Pro/Max), never an API key:
 * ANTHROPIC_API_KEY and friends are stripped from the environment.
 */
export const claudeMember: MemberAdapter = {
  id: 'claude',
  label: 'Claude',

  async status() {
    const b = bin();
    const base = { id: 'claude' as const, label: 'Claude', loginCommand: 'claude auth login', canLoginInApp: false };
    if (!b) return { ...base, installed: false, signedIn: false, billing: 'unknown' as MemberBilling };
    const v = runQuick(b, ['--version']);
    const version = (v.stdout || v.stderr).trim().split('\n')[0]?.slice(0, 60);
    const s = runQuick(b, ['auth', 'status', '--json']);
    let signedIn = false;
    let billing: MemberBilling = 'unknown';
    let account: string | undefined;
    try {
      const j = JSON.parse(s.stdout) as { loggedIn?: boolean; authMethod?: string; email?: string; account?: { email?: string } };
      signedIn = !!j.loggedIn;
      const m = (j.authMethod ?? '').toLowerCase();
      billing = !signedIn ? 'unknown' : /api[_ -]?key/.test(m) ? 'api' : /oauth|claude|subscription|token/.test(m) ? 'plan' : 'unknown';
      account = j.email ?? j.account?.email;
    } catch {
      signedIn = /logged in|signed in/i.test(s.stdout) && !/not logged in/i.test(s.stdout);
    }
    return { ...base, installed: true, version, path: b, signedIn, billing, account };
  },

  async listModels(st) {
    const b = st.path ?? bin();
    const fromHelp = b ? aliasesFromHelp((await runCapture(b, ['--help'], 10_000, 200_000)).stdout) : [];
    return { models: Array.from(new Set([...fromHelp, ...CLAUDE_ALIASES])), source: 'suggested' };
  },

  async run(o: MemberRunOptions): Promise<MemberResult> {
    const b = bin();
    if (!b) return { ok: false, text: '', error: 'Claude Code CLI not found. Install it (npm i -g @anthropic-ai/claude-code) and run `claude auth login`.', billing: 'unknown' };

    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      ...projectConfigArgs(getSettings().council.trustProjectConfig),
      '--append-system-prompt', o.instructions,
    ];
    if (o.model) args.push('--model', o.model);
    if (o.access === 'write') {
      args.push('--permission-mode', 'acceptEdits');
    } else {
      // Print mode auto-denies anything that would need approval (shell, edits); block edits explicitly too.
      args.push('--permission-mode', 'default', '--disallowedTools', ...WRITE_TOOLS);
    }
    if (o.extraDirs.length) args.push('--add-dir', ...o.extraDirs);

    let billing: MemberBilling = 'unknown';
    let model: string | undefined;
    let sawPartialText = false;
    let finalText = '';
    let resultText = '';
    let isError = false;
    let usage: MemberResult['usage'];
    const textByTurn: string[] = [];

    const run = await runJsonl(b, args, { cwd: o.cwd, env: memberEnv(), signal: o.signal, timeoutMs: o.timeoutMs, stdin: o.prompt }, (ev) => {
      switch (ev.type) {
        case 'system': {
          if (ev.subtype === 'init') {
            model = typeof ev.model === 'string' ? ev.model : undefined;
            const src = typeof ev.apiKeySource === 'string' ? ev.apiKeySource : undefined;
            billing = !src || src === 'none' ? 'plan' : 'api';
            o.onEvent({ kind: 'billing', billing, detail: src ? `apiKeySource=${src}` : undefined });
          }
          return;
        }
        case 'stream_event': {
          const e = ev.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } } | undefined;
          if (e?.type === 'content_block_delta') {
            if (e.delta?.type === 'text_delta' && e.delta.text) {
              sawPartialText = true;
              o.onEvent({ kind: 'text', delta: e.delta.text });
            } else if (e.delta?.type === 'thinking_delta' && e.delta.thinking) {
              o.onEvent({ kind: 'thinking', delta: e.delta.thinking });
            }
          }
          return;
        }
        case 'assistant': {
          const msg = ev.message as { content?: Array<Record<string, unknown>> } | undefined;
          let turnText = '';
          for (const block of msg?.content ?? []) {
            if (block.type === 'text' && typeof block.text === 'string') {
              turnText += block.text;
              if (!sawPartialText) o.onEvent({ kind: 'text', delta: block.text });
            } else if (block.type === 'tool_use') {
              o.onEvent({ kind: 'tool_start', id: String(block.id), name: String(block.name), args: block.input });
            }
          }
          if (turnText) textByTurn.push(turnText);
          return;
        }
        case 'user': {
          const msg = ev.message as { content?: Array<Record<string, unknown>> } | undefined;
          for (const block of msg?.content ?? []) {
            if (block.type === 'tool_result') {
              o.onEvent({ kind: 'tool_end', id: String(block.tool_use_id), ok: block.is_error !== true, result: stringify(block.content) });
            }
          }
          return;
        }
        case 'result': {
          isError = ev.is_error === true || (typeof ev.subtype === 'string' && ev.subtype !== 'success');
          resultText = typeof ev.result === 'string' ? ev.result : '';
          const u = ev.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
          if (u) {
            usage = {
              inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
              outputTokens: u.output_tokens ?? 0,
            };
          }
          return;
        }
      }
    });

    finalText = resultText || textByTurn.at(-1) || '';
    if (run.aborted) return { ok: false, text: finalText, error: 'Cancelled.', cancelled: true, billing, model, usage };
    if (run.timedOut) return { ok: false, text: finalText, error: `Timed out after ${Math.round(o.timeoutMs / 60000)} min.`, billing, model, usage };
    const errText = isError ? resultText || run.stderrTail : run.code !== 0 ? run.stderrTail || run.plainTail || `exit code ${run.code}` : '';
    if (errText || isError || run.code !== 0) {
      const limited = detectLimit(errText) || detectLimit(run.stderrTail);
      const notSignedIn = /not logged in|login|authenticat|invalid api key|401/i.test(errText) && !limited;
      return {
        ok: false,
        text: isError ? '' : finalText,
        error: notSignedIn ? `Claude is not signed in. Run \`claude auth login\` in Terminal. (${errText.slice(0, 300)})` : errText.slice(0, 1500) || 'Claude exited with an error.',
        limited,
        limitResetsAt: limited ? parseResetAt(errText) : undefined,
        billing,
        model,
        usage,
      };
    }
    return { ok: true, text: finalText, billing, model, usage };
  },
};
