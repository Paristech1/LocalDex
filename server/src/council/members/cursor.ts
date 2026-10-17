import { execFile } from 'node:child_process';
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
  readonly agentId?: string;
  send(message: string): Promise<SdkRun>;
  close(): void;
}
interface CursorSdk {
  Agent: {
    create(options: Record<string, unknown>): Promise<SdkAgent>;
    /** Local agents persist in the SDK's own store (~/.cursor), so they can be resumed from a later process. */
    resume?(agentId: string, options?: Record<string, unknown>): Promise<SdkAgent>;
  };
  Cursor: {
    /** Models available to the signed-in account (cloud catalog call made by the SDK itself). */
    models?: { list(): Promise<Array<{ id: string; displayName?: string; aliases?: string[] }>> };
    auth: {
      status(): Promise<{ status: 'logged-in' | 'logged-out'; email?: string }>;
      login(options: { openBrowser?: boolean | ((url: string) => void); onLoginUrl?: (url: string) => void; signal?: AbortSignal; apiKeyName?: string }): Promise<{ apiKey: string; email?: string }>;
    };
  };
}

let sdkPromise: Promise<CursorSdk | null> | null = null;
let sdkPath: string | undefined;
let sdkLoadError: string | undefined;

/**
 * Load @cursor/sdk lazily. LOCALDEX_CURSOR_SDK can point at another module (used by tests).
 * Only a successful load is cached: if the package is installed while LocalDex is running (or the first
 * import fails), the next status check / sign-in tries again instead of reporting "not installed" until a restart.
 */
function loadSdk(): Promise<CursorSdk | null> {
  if (!sdkPromise) {
    const attempt = (async () => {
      try {
        const override = process.env.LOCALDEX_CURSOR_SDK;
        let mod: unknown;
        if (override) {
          sdkPath = override;
          mod = await import(pathToFileURL(override).href);
        } else {
          const require = createRequire(import.meta.url);
          sdkPath = require.resolve('@cursor/sdk');
          mod = await import('@cursor/sdk' as string);
        }
        // Some module shapes put the API under `default` (CJS interop).
        const m = mod as Partial<CursorSdk> & { default?: Partial<CursorSdk> };
        const api = (m.Cursor ? m : m.default?.Cursor ? m.default : null) as CursorSdk | null;
        if (!api) throw new Error('@cursor/sdk loaded but does not export Cursor/Agent (unexpected version?)');
        sdkLoadError = undefined;
        return api;
      } catch (e) {
        sdkLoadError = (e as Error).message;
        return null;
      }
    })();
    sdkPromise = attempt;
    void attempt.then((r) => {
      if (!r && sdkPromise === attempt) sdkPromise = null;
    });
  }
  return sdkPromise;
}

/**
 * Open a sign-in page in a specific macOS app (`open -a`). No shell is involved (args are passed as an array), only
 * https URLs are opened, and if the app can't be launched the system default browser is used instead.
 */
export function openInApp(app: string, url: string): void {
  if (!/^https:\/\//i.test(url)) return;
  const fallback = (): void => void execFile('open', [url], () => undefined);
  if (process.platform !== 'darwin' || !/^[\w .+-]{1,60}$/.test(app)) return fallback();
  execFile('open', ['-a', app, url], (err) => {
    if (err) fallback();
  });
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
    if (!sdk) return { ...base, installed: false, signedIn: false, billing: 'unknown' as MemberBilling, lastError: sdkLoadError };
    try {
      const s = await sdk.Cursor.auth.status();
      const signedIn = s.status === 'logged-in' || !!process.env.CURSOR_API_KEY;
      return { ...base, installed: true, path: sdkPath, version: '@cursor/sdk', signedIn, billing: (signedIn ? 'plan' : 'unknown') as MemberBilling, account: s.email };
    } catch (e) {
      return { ...base, installed: true, path: sdkPath, signedIn: false, billing: 'unknown' as MemberBilling, lastError: (e as Error).message };
    }
  },

  async listModels(st) {
    const sdk = await loadSdk();
    if (!sdk?.Cursor.models || !st.signedIn) return { models: ['auto'], source: 'suggested' };
    const list = await sdk.Cursor.models.list();
    return { models: list.map((m) => m.id).filter(Boolean), source: 'account' };
  },

  async login(onUrl, signal) {
    const sdk = await loadSdk();
    if (!sdk) return { ok: false, error: `@cursor/sdk could not be loaded${sdkLoadError ? `: ${sdkLoadError}` : ' (run npm install in the LocalDex folder)'}` };
    try {
      const app = getSettings().council.loginBrowser?.trim();
      // With a chosen browser we open the page ourselves; otherwise the SDK uses the system default.
      const openBrowser = app ? (url: string) => openInApp(app, url) : true;
      const r = await sdk.Cursor.auth.login({ openBrowser, onLoginUrl: onUrl, signal, apiKeyName: 'LocalDex council' });
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

    // systemPrompt and disallowedTools are not persisted on the agent, so a resume passes them again.
    const options = {
      name: 'LocalDex council',
      model: { id: model },
      systemPrompt: o.instructions,
      // Only the user's own Cursor settings unless the user opted in to project config (see trustProjectConfig).
      local: { cwd: o.cwd, dirs: o.extraDirs, settingSources: getSettings().council.trustProjectConfig ? ['user', 'project'] : ['user'] },
      ...(o.access === 'read' ? { disallowedTools: MUTATING_TOOLS } : { disallowedTools: ['delete'] }),
    };
    const sessionId = (): string | undefined => agent?.agentId || undefined;

    try {
      if (o.resumeSessionId) {
        try {
          if (!sdk.Agent.resume) throw new Error('this @cursor/sdk version cannot resume agents');
          agent = await sdk.Agent.resume(o.resumeSessionId, options);
        } catch (e) {
          return { ok: false, text: '', error: `Could not resume the Cursor agent: ${(e as Error).message}`.slice(0, 1500), billing, model, resumeFailed: true };
        }
      }
      agent ??= await sdk.Agent.create(options);
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
        return { ok: false, text: final, error: o.signal.aborted ? 'Cancelled.' : `Timed out after ${Math.round(o.timeoutMs / 60000)} min.`, cancelled: o.signal.aborted, billing, usage, model, sessionId: sessionId() };
      }
      if (res.status === 'error') {
        const msg = res.error?.message ?? 'Cursor run failed';
        const limited = detectLimit(msg) || res.error?.code === 'resource_exhausted';
        return { ok: false, text: final, error: msg, limited, limitResetsAt: limited ? parseResetAt(msg) : undefined, billing, usage, model, sessionId: sessionId() };
      }
      return { ok: true, text: final, billing, usage, model: res.model?.id ?? model, sessionId: sessionId() };
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
        sessionId: sessionId(),
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
