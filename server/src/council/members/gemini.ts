import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSettings } from '../../config.js';
import { memberEnv, resolveBinary, runJsonl, runQuick } from '../proc.js';
import { detectLimit, parseResetAt, stringify, type MemberAdapter, type MemberResult, type MemberRunOptions } from '../types.js';
import type { MemberBilling } from '@localdex/shared';

/** Gemini CLI's model aliases (`-m auto|pro|flash|flash-lite`). It has no non-interactive model listing. */
const GEMINI_ALIASES = ['auto', 'pro', 'flash', 'flash-lite'];

function bin(): string | null {
  return resolveBinary('gemini', getSettings().council.members.gemini.command);
}

function geminiHome(): string {
  return process.env.GEMINI_CLI_HOME ? path.join(process.env.GEMINI_CLI_HOME, '.gemini') : path.join(os.homedir(), '.gemini');
}

/** Gemini CLI has no status command, so read its settings and credential files (never their contents beyond the auth type). */
function readAuth(): { selected?: string; hasOauth: boolean; account?: string } {
  const dir = geminiHome();
  let selected: string | undefined;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')) as {
      security?: { auth?: { selectedType?: string } };
      selectedAuthType?: string;
    };
    selected = s.security?.auth?.selectedType ?? s.selectedAuthType;
  } catch {
    /* no settings yet */
  }
  const hasOauth = fs.existsSync(path.join(dir, 'oauth_creds.json'));
  let account: string | undefined;
  try {
    const a = JSON.parse(fs.readFileSync(path.join(dir, 'google_accounts.json'), 'utf8')) as { active?: string };
    account = a.active || undefined;
  } catch {
    /* optional */
  }
  return { selected, hasOauth, account };
}

/**
 * Google Gemini CLI: `gemini -p … -o stream-json`. Uses "Login with Google" (oauth-personal),
 * which is how Google AI Pro/Ultra plans are used. API-key and Vertex logins are reported as API billing.
 */
export const geminiMember: MemberAdapter = {
  id: 'gemini',
  label: 'Gemini',

  async status() {
    const b = bin();
    const base = { id: 'gemini' as const, label: 'Gemini', loginCommand: 'gemini   (then choose "Login with Google")', canLoginInApp: false };
    if (!b) return { ...base, installed: false, signedIn: false, billing: 'unknown' as MemberBilling };
    const v = runQuick(b, ['--version']);
    const version = (v.stdout || v.stderr).trim().split('\n')[0]?.slice(0, 60);
    const a = readAuth();
    const sel = a.selected ?? (a.hasOauth ? 'oauth-personal' : undefined);
    const signedIn = sel === 'oauth-personal' ? a.hasOauth : !!sel;
    const billing: MemberBilling = !signedIn ? 'unknown' : sel === 'oauth-personal' ? 'plan' : sel === 'gemini-api-key' || sel === 'vertex-ai' ? 'api' : 'unknown';
    return { ...base, installed: true, version, path: b, signedIn, billing, account: a.account };
  },

  async listModels() {
    return { models: GEMINI_ALIASES, source: 'suggested' };
  },

  async run(o: MemberRunOptions): Promise<MemberResult> {
    const b = bin();
    if (!b) return { ok: false, text: '', error: 'Gemini CLI not found. Install it (npm i -g @google/gemini-cli), run `gemini` once and pick "Login with Google".', billing: 'unknown' };

    const prompt = `${o.instructions}\n\n---\n\n${o.prompt}`;
    // read: 'plan' is Gemini's read-only mode. write: auto-approve edits; shell still needs approval, which headless mode denies.
    const args = ['-p', prompt, '-o', 'stream-json', '--approval-mode', o.access === 'write' ? 'auto_edit' : 'plan', '--skip-trust'];
    if (o.model) args.push('-m', o.model);
    if (o.extraDirs.length) args.push('--include-directories', o.extraDirs.join(','));

    let model: string | undefined;
    let segment = '';
    let full = '';
    let status = '';
    let resultError = '';
    const errors: string[] = [];
    let usage: MemberResult['usage'];

    const run = await runJsonl(b, args, { cwd: o.cwd, env: memberEnv(), signal: o.signal, timeoutMs: o.timeoutMs }, (ev) => {
      switch (ev.type) {
        case 'init':
          model = typeof ev.model === 'string' ? ev.model : undefined;
          return;
        case 'message':
          if (ev.role === 'assistant' && typeof ev.content === 'string') {
            segment += ev.content;
            full += ev.content;
            o.onEvent({ kind: 'text', delta: ev.content });
          }
          return;
        case 'tool_use':
          segment = '';
          o.onEvent({ kind: 'tool_start', id: String(ev.tool_id), name: String(ev.tool_name), args: ev.parameters });
          return;
        case 'tool_result': {
          const err = ev.error as { message?: string } | undefined;
          o.onEvent({ kind: 'tool_end', id: String(ev.tool_id), ok: ev.status === 'success', result: stringify(ev.output ?? err?.message ?? '') });
          return;
        }
        case 'error':
          if (typeof ev.message === 'string') errors.push(ev.message);
          return;
        case 'result': {
          status = String(ev.status ?? '');
          const err = ev.error as { message?: string } | undefined;
          if (err?.message) resultError = err.message;
          const st = ev.stats as { input_tokens?: number; output_tokens?: number } | undefined;
          if (st) usage = { inputTokens: st.input_tokens ?? 0, outputTokens: st.output_tokens ?? 0 };
          return;
        }
      }
    });

    const text = (segment.trim() ? segment : full).trim();
    const billing: MemberBilling = 'unknown';
    if (run.aborted) return { ok: false, text, error: 'Cancelled.', cancelled: true, billing, model, usage };
    if (run.timedOut) return { ok: false, text, error: `Timed out after ${Math.round(o.timeoutMs / 60000)} min.`, billing, model, usage };
    const errText = resultError || (status === 'error' ? errors.join('\n') : '') || (run.code !== 0 ? errors.join('\n') || run.stderrTail || run.plainTail || `exit code ${run.code}` : '');
    if (errText) {
      const limited = detectLimit(errText) || detectLimit(run.stderrTail);
      const notSignedIn = !limited && /auth|login|credential|sign in/i.test(errText);
      return {
        ok: false,
        text,
        error: notSignedIn ? `Gemini is not signed in. Run \`gemini\` in Terminal and choose "Login with Google". (${errText.slice(0, 300)})` : errText.slice(0, 1500),
        limited,
        limitResetsAt: limited ? parseResetAt(errText) : undefined,
        billing,
        model,
        usage,
      };
    }
    return { ok: true, text, billing, model, usage };
  },
};
