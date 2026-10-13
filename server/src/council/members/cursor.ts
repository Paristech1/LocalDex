import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { getSettings } from '../../config.js';
import { detectLimit, parseResetAt, stringify, type MemberAdapter, type MemberResult, type MemberRunOptions } from '../types.js';
import type { MemberBilling } from '@localdex/shared';

/* Minimal structural types for the parts of @cursor/sdk we use (keeps the server compiling if the package is absent). */
interface SdkMessage {
  type: string;
  message?: { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> };
  call_id?: string;
  name?: string;
  status?: string;
  args?: unknown;
  result?: unknown;
  text?: string;
  usage?: { inputTokens?: number; outputTokens?: number; input_tokens?: number; output_tokens?: number };
}
interface SdkRun {
  stream(): AsyncGenerator<SdkMessage, void>;
  wait(): Promise<{ status: string; result?: string; error?: { message: string; code?: string }; usage?: SdkMessage['usage']; model?: { id: string } }>;
  cancel(): Promise<void>;
}
interface SdkAgent {
  send(message: string): Promise<SdkRun>;
  close(): void;
}
interface CursorSdk {
  Agent: { create(options: Record<string, unknown>): Promise<SdkAgent> };
  Cursor: {
    auth: {
      status(): Promise<{ status: 'logged-in' | 'logged-out'; email?: string }>;
      login(options: { openBrowser?: boolean | ((url: string) => void); onLoginUrl?: (url: string) => void; signal?: AbortSignal; apiKeyName?: string }): Promise<{ apiKey: string; email?: string }>;
    };
  };
}

let sdkPromise: Promise<CursorSdk | null> | null = null;
let sdkPath: string | undefined;

/** Load @cursor/sdk lazily. LOCALDEX_CURSOR_SDK can point at another module (used by tests). */
function loadSdk(): Promise<CursorSdk | null> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      try {
        const override = process.env.LOCALDEX_CURSOR_SDK;
        if (override) {
          sdkPath = override;
          return (await import(pathToFileURL(override).href)) as CursorSdk;
        }
        const require = createRequire(import.meta.url);
        sdkPath = require.resolve('@cursor/sdk');
        return (await import('@cursor/sdk' as string)) as CursorSdk;
      } catch {
        return null;
      }
    })();
  }
  return sdkPromise;
}

/** Read-only roles: block every Cursor tool that changes files or runs commands. */
const MUTATING_TOOLS = ['shell', 'edit', 'delete', 'applyAgentDiff', 'generateImage'];

/**
 * Cursor via its official SDK (@cursor/sdk), running a *local* agent in the approved folder.
 * Sign-in is Cursor's own browser login (Cursor.auth.login), which mints a key tied to your Cursor plan;
 * the SDK stores it in ~/.cursor/sdk/auth.json and LocalDex never sees it.
 */
export const cursorMember: MemberAdapter = {
  id: 'cursor',
  label: 'Cursor',

  async status() {
    const base = { id: 'cursor' as const, label: 'Cursor', loginCommand: 'Use "Sign in" here (opens Cursor in your browser)', canLoginInApp: true };
    const sdk = await loadSdk();
    if (!sdk) return { ...base, installed: false, signedIn: false, billing: 'unknown' as MemberBilling };
    try {
      const s = await sdk.Cursor.auth.status();
      const signedIn = s.status === 'logged-in' || !!process.env.CURSOR_API_KEY;
      return { ...base, installed: true, path: sdkPath, version: '@cursor/sdk', signedIn, billing: (signedIn ? 'plan' : 'unknown') as MemberBilling, account: s.email };
    } catch (e) {
      return { ...base, installed: true, path: sdkPath, signedIn: false, billing: 'unknown' as MemberBilling, lastError: (e as Error).message };
    }
  },

  async login(onUrl, signal) {
    const sdk = await loadSdk();
    if (!sdk) return { ok: false, error: '@cursor/sdk is not installed (run npm install in the LocalDex folder).' };
    try {
      const r = await sdk.Cursor.auth.login({ openBrowser: true, onLoginUrl: onUrl, signal, apiKeyName: 'LocalDex council' });
      return { ok: true, account: r.email };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  async run(o: MemberRunOptions): Promise<MemberResult> {
    const sdk = await loadSdk();
    const billing: MemberBilling = 'plan';
    if (!sdk) return { ok: false, text: '', error: '@cursor/sdk is not installed. Run `npm install` in the LocalDex folder.', billing: 'unknown' };

    const model = o.model || getSettings().council.members.cursor.model || 'auto';
    let agent: SdkAgent | null = null;
    let run: SdkRun | null = null;
    let text = '';
    let usage: MemberResult['usage'];
    const onAbort = () => void run?.cancel().catch(() => undefined);
    const timer = setTimeout(onAbort, o.timeoutMs);
    o.signal.addEventListener('abort', onAbort, { once: true });

    try {
      agent = await sdk.Agent.create({
        name: 'LocalDex council',
        model: { id: model },
        systemPrompt: o.instructions,
        local: { cwd: o.cwd, dirs: o.extraDirs },
        ...(o.access === 'read' ? { disallowedTools: MUTATING_TOOLS } : { disallowedTools: ['delete'] }),
      });
      run = await agent.send(o.prompt);
      if (o.signal.aborted) onAbort();
      for await (const m of run.stream()) {
        if (m.type === 'assistant') {
          for (const block of m.message?.content ?? []) {
            if (block.type === 'text' && block.text) {
              text += block.text;
              o.onEvent({ kind: 'text', delta: block.text });
            } else if (block.type === 'tool_use' && block.id) {
              o.onEvent({ kind: 'tool_start', id: block.id, name: String(block.name), args: block.input });
            }
          }
        } else if (m.type === 'tool_call' && m.call_id) {
          if (m.status === 'running') o.onEvent({ kind: 'tool_start', id: m.call_id, name: String(m.name), args: m.args });
          else o.onEvent({ kind: 'tool_end', id: m.call_id, ok: m.status === 'completed', result: stringify(m.result) });
        } else if (m.type === 'thinking' && m.text) {
          o.onEvent({ kind: 'thinking', delta: m.text });
        } else if (m.type === 'usage' && m.usage) {
          usage = { inputTokens: m.usage.inputTokens ?? m.usage.input_tokens ?? 0, outputTokens: m.usage.outputTokens ?? m.usage.output_tokens ?? 0 };
        }
      }
      const res = await run.wait();
      const final = res.result?.trim() || text.trim();
      if (res.usage) usage = { inputTokens: res.usage.inputTokens ?? res.usage.input_tokens ?? 0, outputTokens: res.usage.outputTokens ?? res.usage.output_tokens ?? 0 };
      if (res.status === 'cancelled') {
        return { ok: false, text: final, error: o.signal.aborted ? 'Cancelled.' : `Timed out after ${Math.round(o.timeoutMs / 60000)} min.`, cancelled: o.signal.aborted, billing, usage, model };
      }
      if (res.status === 'error') {
        const msg = res.error?.message ?? 'Cursor run failed';
        const limited = detectLimit(msg) || res.error?.code === 'resource_exhausted';
        return { ok: false, text: final, error: msg, limited, limitResetsAt: limited ? parseResetAt(msg) : undefined, billing, usage, model };
      }
      return { ok: true, text: final, billing, usage, model: res.model?.id ?? model };
    } catch (e) {
      const err = e as Error & { name?: string; code?: string };
      const msg = err.message || String(e);
      const limited = err.name === 'RateLimitError' || detectLimit(msg);
      const notSignedIn = err.name === 'AuthenticationError' || /api key is required|unauthenticated/i.test(msg);
      return {
        ok: false,
        text,
        error: notSignedIn ? 'Cursor is not signed in. Use Settings → Council → Cursor → Sign in.' : msg.slice(0, 1500),
        limited,
        limitResetsAt: limited ? parseResetAt(msg) : undefined,
        cancelled: o.signal.aborted,
        billing,
        usage,
        model,
      };
    } finally {
      clearTimeout(timer);
      o.signal.removeEventListener('abort', onAbort);
      try {
        agent?.close();
      } catch {
        /* ignore */
      }
    }
  },
};
