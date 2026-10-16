import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import type { ChatMessage, ModelInfo, ToolCall, ToolSchema } from '@localdex/shared';
import { DATA_DIR, getSettings } from './config.js';
import { bus } from './agent/bus.js';
import { parseLenientJson } from './jsonRepair.js';

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number } | null;
  finishReason: string | null;
  /** true when tool calls were recovered from plain text rather than native tool_calls */
  parsedFromText: boolean;
  /** The model kept thinking past the runaway limit without answering or calling a tool; LocalDex cut the reply off. */
  runaway?: boolean;
  /** LM Studio's native tool-call parser failed on this model, so LocalDex switched it to the text protocol and retried. */
  switchedToText?: boolean;
}

export interface StreamOptions {
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  temperature?: number;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onReasoning?: (text: string) => void;
  /** Called when LocalDex throws away a partial reply and asks again (native → text fallback): clear live output. */
  onRestart?: () => void;
  /** Override the Reasoning setting for this call ('off' for summaries and checkpoints when the setting is 'auto'). */
  reasoning?: 'off' | 'setting';
}

function client(): OpenAI {
  return new OpenAI({ baseURL: getSettings().baseUrl, apiKey: 'lm-studio' });
}

/** Convert our stored message shape to the OpenAI wire format (strip UI-only fields). */
function toWire(messages: ChatMessage[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content };
      case 'user':
        return { role: 'user', content: m.content };
      case 'assistant': {
        const out: OpenAI.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: m.content ?? '',
        };
        if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
        return out;
      }
      case 'tool':
        return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    }
  });
}

// ---------- Text tool mode (for models whose chat template lacks native tool support) ----------

export function textToolProtocol(tools: ToolSchema[]): string {
  const list = tools
    .map((t) => {
      const params = t.function.parameters as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
      const props = Object.entries(params.properties ?? {})
        .map(([k, v]) => `${k}${params.required?.includes(k) ? '' : '?'}: ${v.type ?? 'any'}${v.description ? ` — ${v.description}` : ''}`)
        .join('; ');
      return `- ${t.function.name}(${props})\n    ${t.function.description}`;
    })
    .join('\n');
  return `# Tools
You can call these tools:
${list}

# How to call a tool
Write each call on its own line in exactly this format, with a JSON object inside the tags:
<tool_call>{"name": "read_file", "arguments": {"path": "src/index.ts"}}</tool_call>
Rules:
- You may put several <tool_call> blocks in one reply when the calls are independent.
- After writing tool calls, STOP and wait. The results arrive in the next user message inside <tool_result> tags.
- Never invent results. Never show calls as code examples; a <tool_call> block is always executed.
- Arguments must be valid JSON (escape newlines in strings as \\n).${tools.some((t) => t.function.name === 'update_plan') ? `
- update_plan takes the whole list every time, e.g. {"steps": [{"title": "Write the file", "status": "done"}, {"title": "Run the tests", "status": "in_progress"}]}. Statuses: pending, in_progress, done, skipped.` : ''}
- When the task is finished, reply in plain prose without any <tool_call> block.`;
}

/**
 * Render the conversation for a model without native tool support:
 * tool calls become <tool_call> text in assistant turns, tool results become <tool_result> text in
 * user turns, consecutive same-role turns are merged (Gemma-style templates require strict alternation).
 */
function toWireText(messages: ChatMessage[], tools: ToolSchema[]): OpenAI.ChatCompletionMessageParam[] {
  const out: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  const push = (role: 'system' | 'user' | 'assistant', content: string) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else out.push({ role, content });
  };
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        push('system', tools.length ? `${m.content}\n\n${textToolProtocol(tools)}` : m.content);
        break;
      case 'user':
        push('user', m.content);
        break;
      case 'assistant': {
        let text = m.content ?? '';
        for (const tc of m.tool_calls ?? []) {
          text += `\n<tool_call>${JSON.stringify({ name: tc.function.name, arguments: safeParse(tc.function.arguments) })}</tool_call>`;
        }
        push('assistant', text.trim() || '(no output)');
        break;
      }
      case 'tool':
        push('user', `<tool_result name="${m.name ?? 'tool'}"${m.ok === false ? ' status="error"' : ''}>\n${m.content}\n</tool_result>`);
        break;
    }
  }
  // Gemma-style templates also require the conversation to end on a user turn.
  if (out[out.length - 1]?.role === 'assistant') push('user', 'Continue.');
  return out;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

const nativeSupport = new Map<string, boolean>();

/**
 * Models LocalDex moved to the text protocol because their native tool calls broke at runtime. Kept on disk: the
 * probe passes again after every restart (one clean call), so without this the same breakage repeats each session.
 */
const TEXT_MODELS_FILE = path.join(DATA_DIR, 'text-tool-models.json');
const textModels = new Set<string>(
  (() => {
    try {
      const v = JSON.parse(fs.readFileSync(TEXT_MODELS_FILE, 'utf8')) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  })(),
);
for (const m of textModels) nativeSupport.set(m, false);

function rememberTextModel(model: string): void {
  nativeSupport.set(model, false);
  if (textModels.has(model)) return;
  textModels.add(model);
  try {
    fs.writeFileSync(TEXT_MODELS_FILE, JSON.stringify([...textModels], null, 2));
  } catch (e) {
    bus.log('warn', `Could not save the text tool mode for ${model}: ${(e as Error).message}`);
  }
}

/** Resolve the effective tool mode for a model, probing once when the setting is 'auto'. */
export async function resolveToolMode(model: string): Promise<'native' | 'text'> {
  const mode = getSettings().toolMode;
  if (mode !== 'auto') return mode;
  const cached = nativeSupport.get(model);
  if (cached !== undefined) return cached ? 'native' : 'text';
  const ok = await probeNativeTools(model);
  nativeSupport.set(model, ok);
  return ok ? 'native' : 'text';
}

export function toolModeCache(): Record<string, 'native' | 'text'> {
  const o: Record<string, 'native' | 'text'> = {};
  for (const [k, v] of nativeSupport) o[k] = v ? 'native' : 'text';
  return o;
}

async function probeNativeTools(model: string): Promise<boolean> {
  try {
    const res = await client().chat.completions.create(
      {
        model,
        messages: [{ role: 'user', content: 'Call the ping tool now with value "ok". Do not reply with text.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'ping',
              description: 'Health check. Call it with the given value.',
              parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
            },
          },
        ],
        temperature: 0,
        max_tokens: 400,
        ...reasoningParams(model, true),
      } as OpenAI.ChatCompletionCreateParamsNonStreaming,
      { timeout: 120_000 },
    );
    const calls = res.choices[0]?.message?.tool_calls ?? [];
    const ok = calls.some((c) => c.function?.name === 'ping');
    bus.log('info', `Tool mode for ${model}: ${ok ? 'native tool calls' : 'text protocol (model did not emit native tool_calls)'}`);
    return ok;
  } catch (e) {
    bus.log('warn', `Tool-mode probe failed for ${model}: ${(e as Error).message}; using text protocol`);
    return false;
  }
}

const modelCache = new Map<string, ModelInfo>();

export async function listModels(): Promise<ModelInfo[]> {
  const base = getSettings().baseUrl.replace(/\/+$/, '');
  const root = base.replace(/\/v1$/, '');
  let models: ModelInfo[] | null = null;
  // LM Studio's native REST API exposes load state and context length.
  try {
    const res = await fetch(`${root}/api/v0/models`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = (await res.json()) as {
        data: Array<{
          id: string;
          type: string;
          state?: string;
          max_context_length?: number;
          loaded_context_length?: number;
        }>;
      };
      models = data.data
        .filter((m) => m.type === 'llm' || m.type === 'vlm')
        .map((m) => ({
          id: m.id,
          loaded: m.state === 'loaded',
          contextLength: m.loaded_context_length ?? m.max_context_length,
        }));
    }
  } catch {
    /* fall through */
  }
  if (!models) {
    const list = await client().models.list();
    models = list.data.map((m) => ({ id: m.id }));
  }
  // LM Studio 0.4+ REST API v1: per-instance load config (the real context window) and the reasoning switch.
  try {
    const res = await fetch(`${root}/api/v1/models`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = (await res.json()) as {
        models?: Array<{
          key: string;
          type?: string;
          max_context_length?: number;
          loaded_instances?: Array<{ id: string; config?: { context_length?: number } }>;
          capabilities?: { reasoning?: { allowed_options?: string[] } };
        }>;
      };
      for (const v of data.models ?? []) {
        const m = models.find((x) => x.id === v.key);
        if (!m) continue;
        const inst = v.loaded_instances?.[0];
        if (inst) {
          m.loaded = true;
          if (inst.config?.context_length) m.contextLength = inst.config.context_length;
        }
        if (v.max_context_length) m.maxContextLength = v.max_context_length;
        const opts = v.capabilities?.reasoning?.allowed_options;
        m.reasoningSwitch = Array.isArray(opts) ? opts.includes('off') : false;
      }
    }
  } catch {
    /* older LM Studio: no v1 API */
  }
  for (const m of models) modelCache.set(m.id, m);
  return models;
}

/**
 * Unload a model and load it again with a bigger (or smaller) context window, through LM Studio's REST API v1.
 * Returns the context LM Studio actually loaded.
 */
export async function reloadModel(model: string, contextLength: number): Promise<number> {
  const root = getSettings().baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const post = async (p: string, body: unknown, timeoutMs: number) => {
    const res = await fetch(`${root}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${p} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };
  await listModels().catch(() => []);
  if (modelCache.get(model)?.loaded) {
    await post('/api/v1/models/unload', { instance_id: model }, 60_000).catch((e) => {
      // Not loaded under that instance id: loading below still works.
      bus.log('warn', `unload ${model}: ${(e as Error).message}`);
    });
  }
  const loaded = await post('/api/v1/models/load', { model, context_length: contextLength, echo_load_config: true }, 600_000);
  const ctx = Number((loaded.load_config as { context_length?: number } | undefined)?.context_length ?? contextLength);
  await listModels().catch(() => []);
  bus.log('info', `Reloaded ${model} in LM Studio with a ${ctx}-token context window.`);
  return ctx;
}

/** Models where LM Studio rejected reasoning_effort: never send it again. */
const reasoningUnsupported = new Set<string>();

/** Whether this call should ask LM Studio to switch the model's reasoning off. */
export function wantsReasoningOff(model: string, hasTools: boolean, override?: 'off' | 'setting'): boolean {
  if (reasoningUnsupported.has(model)) return false;
  const info = modelCache.get(model);
  // Only send the switch to models that LM Studio says have one; others may reject the parameter.
  if (!info?.reasoningSwitch) return false;
  const mode = getSettings().reasoning ?? 'auto';
  if (mode === 'on') return false;
  if (mode === 'off') return true;
  return hasTools || override === 'off';
}

function reasoningParams(model: string, hasTools: boolean, override?: 'off' | 'setting'): Record<string, unknown> {
  return wantsReasoningOff(model, hasTools, override) ? { reasoning_effort: 'none' } : {};
}

/** A thinking model that writes this much reasoning, with tools available and no answer yet, is cut off and nudged. */
export const RUNAWAY_REASONING_CHARS = 6000;
const RUNAWAY_REASONING_CHARS_ON = 16000;

/** Chat-template control tokens (Gemma <|"|>, <channel|>, <|tool_call>, ChatML <|im_end|> …) inside an argument mean the call is broken. */
const CONTROL_TOKEN = /<\|[^|<>\s]{0,24}\|?>|<[a-z_]{2,24}\|>/i;

/** A tool call whose arguments are not a JSON object, or carry chat-template control tokens. */
export function isCorruptCall(call: ToolCall): boolean {
  const raw = call.function.arguments ?? '';
  if (CONTROL_TOKEN.test(raw)) return true;
  if (!raw.trim()) return false;
  const v = parseLenientJson(raw);
  if (v === undefined || v === null || typeof v !== 'object' || Array.isArray(v)) return true;
  return hasLeak(v, '');
}

/**
 * JSON structure spilled into a string value ("Create notes2 folder**},{status:") or prose in a path: the model's
 * call format broke mid-argument. Valid JSON, so only this catches it.
 */
const STRUCTURE_LEAK = /\*\*\s*[}\]]|[}\]]\s*,\s*[{\[]\s*"?[a-z_]{2,20}"?\s*:/i;
/** Short identifier-like fields. File contents, edits and commands can legitimately contain JSON, so they are not checked. */
const SHORT_KEYS = new Set(['path', 'file', 'file_path', 'cwd', 'dir', 'directory', 'pattern', 'name', 'title', 'status', 'step', 'label']);
const PATH_KEYS = new Set(['path', 'file', 'file_path', 'cwd', 'dir', 'directory']);
function hasLeak(v: unknown, key: string, depth = 0): boolean {
  if (depth > 6) return false;
  if (typeof v === 'string') return SHORT_KEYS.has(key) && (STRUCTURE_LEAK.test(v) || (PATH_KEYS.has(key) && v.includes('\n')));
  if (Array.isArray(v)) return v.some((x) => hasLeak(x, key, depth + 1));
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // Plan steps with a non-string status ("status": 1395674847) are garbage too.
    if (key === 'steps' && 'status' in o && typeof o.status !== 'string' && typeof o.status !== 'boolean') return true;
    return Object.entries(o).some(([k, x]) => hasLeak(x, k, depth + 1));
  }
  return false;
}

/** LM Studio's own tool-call parser blew up on the model's output (e.g. Gemma: "Invalid diff: now finding less tool calls"). */
export function isEngineToolParseError(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e);
  return /invalid diff|tool call|tool_call|function call|parse.*tool|tool.*parse|predict stream returned an error/i.test(m);
}

/** Best-known context window for a model: user override, then LM Studio metadata, else 0 (unknown). */
export function contextLengthFor(model: string | null): number {
  const override = getSettings().contextLength;
  if (override > 0) return override;
  if (!model) return 0;
  return modelCache.get(model)?.contextLength ?? 0;
}

/** Rough token estimate when the server didn't report usage. */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (typeof m.content === 'string' ? m.content.length : 0) + 20;
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) chars += tc.function.name.length + tc.function.arguments.length + 20;
    }
  }
  return Math.ceil(chars / 3.5);
}

export async function streamChat(opts: StreamOptions): Promise<StreamResult> {
  const mode = opts.tools.length ? await resolveToolMode(opts.model) : 'native';
  try {
    const r = await streamOnce(opts, mode === 'text');
    // The native call "worked" but its arguments are garbage: the model's own tool-call format broke down mid-call
    // (seen with Gemma 4 fine-tunes after a few turns: control tokens and the final answer leak into a string argument).
    // Never execute such a call. In auto mode, move the model to the text protocol for good and ask again.
    if (mode === 'native' && !r.parsedFromText && r.toolCalls.some(isCorruptCall)) {
      const bad = r.toolCalls.find(isCorruptCall)!;
      if (getSettings().toolMode === 'auto') {
        rememberTextModel(opts.model);
        bus.log('warn', `${opts.model} produced a corrupted native tool call (${bad.function.name}: ${bad.function.arguments.slice(0, 120)}…). Switched this model to the text tool protocol and retried.`);
        opts.onRestart?.();
        const t = await streamOnce(opts, true);
        return { ...t, switchedToText: true };
      }
    }
    return r;
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    // A model can claim native tool support (the probe passed) and still produce tool-call output that LM Studio's
    // parser chokes on mid-stream. In auto mode, switch that model to the text protocol for good and ask again.
    if (mode === 'native' && opts.tools.length && getSettings().toolMode === 'auto' && isEngineToolParseError(e)) {
      rememberTextModel(opts.model);
      bus.log('warn', `LM Studio could not parse ${opts.model}'s native tool calls (${String((e as Error).message).slice(0, 160)}). Switched this model to the text tool protocol and retried.`);
      opts.onRestart?.();
      const r = await streamOnce(opts, true);
      return { ...r, switchedToText: true };
    }
    // The model rejected reasoning_effort: remember and retry without it.
    if (/reasoning/i.test(String((e as Error).message)) && wantsReasoningOff(opts.model, opts.tools.length > 0, opts.reasoning)) {
      reasoningUnsupported.add(opts.model);
      bus.log('warn', `${opts.model} rejected the reasoning switch; sending requests without it.`);
      opts.onRestart?.();
      return streamOnce(opts, mode === 'text');
    }
    throw e;
  }
}

async function streamOnce(opts: StreamOptions, textMode: boolean): Promise<StreamResult> {
  const settings = getSettings();
  // Our own controller, so a runaway think can be cut off without looking like the user pressed Stop.
  const ac = new AbortController();
  const onOuterAbort = () => ac.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
  if (opts.signal?.aborted) ac.abort();
  let runaway = false;
  const runawayLimit = (settings.reasoning ?? 'auto') === 'on' ? RUNAWAY_REASONING_CHARS_ON : RUNAWAY_REASONING_CHARS;

  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;
  let usage: StreamResult['usage'] = null;
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();

  try {
    const stream = await client().chat.completions.create(
      {
        model: opts.model,
        messages: textMode ? toWireText(opts.messages, opts.tools) : toWire(opts.messages),
        tools: !textMode && opts.tools.length ? (opts.tools as OpenAI.ChatCompletionTool[]) : undefined,
        temperature: opts.temperature ?? settings.temperature,
        stream: true,
        stream_options: { include_usage: true },
        ...reasoningParams(opts.model, opts.tools.length > 0, opts.reasoning),
      } as OpenAI.ChatCompletionCreateParamsStreaming,
      { signal: ac.signal },
    );

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta as OpenAI.ChatCompletionChunk.Choice.Delta & {
        reasoning_content?: string;
        reasoning?: string;
      };
      if (!delta) continue;

      const r = delta.reasoning_content ?? delta.reasoning;
      if (r) {
        reasoning += r;
        opts.onReasoning?.(r);
        // Thinking forever without acting: cut it off; the loop nudges the model to act or answer.
        if (opts.tools.length && !content.trim() && toolAcc.size === 0 && reasoning.length > runawayLimit) {
          runaway = true;
          ac.abort();
          break;
        }
      }
      if (delta.content) {
        const before = content;
        content += delta.content;
        // In text mode, hide the <tool_call> markup from the live stream; the parsed calls are shown as cards.
        if (!textMode || !before.includes('<tool_call')) {
          const cut = textMode ? delta.content.indexOf('<tool_call') : -1;
          const visible = cut >= 0 ? delta.content.slice(0, cut) : delta.content;
          if (visible) opts.onDelta?.(visible);
        }
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const cur = toolAcc.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolAcc.set(idx, cur);
        }
      }
    }
  } catch (e) {
    if (!runaway) throw e;
  } finally {
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }

  if (runaway) {
    bus.log('warn', `${opts.model} thought for ${reasoning.length} characters without acting; cut it off.`);
    return { content: '', reasoning, toolCalls: [], usage, finishReason: 'runaway', parsedFromText: false, runaway: true };
  }

  let toolCalls: ToolCall[] = Array.from(toolAcc.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([i, t]) => ({
      id: t.id || `call_${Date.now()}_${i}`,
      type: 'function' as const,
      function: { name: t.name, arguments: t.args || '{}' },
    }));

  let parsedFromText = false;
  if (toolCalls.length === 0 && opts.tools.length) {
    const recovered = parseTextToolCalls(content, opts.tools);
    if (recovered.calls.length) {
      toolCalls = recovered.calls;
      content = recovered.remainingText;
      parsedFromText = !textMode;
    }
  }

  return { content, reasoning, toolCalls, usage, finishReason, parsedFromText };
}

// ---------- Fallback: recover tool calls that a local model emitted as text ----------

// Closing tag optional: small models often forget it.
const TAGGED_BLOCK = /<(tool_call|function_call|tool)>\s*([\s\S]*?)\s*(?:<\/\1>|(?=<tool_call>)|$)/g;
const FENCED_JSON = /```(?:json|tool_call|tool)?\s*([\s\S]*?)```/g;

export function parseTextToolCalls(
  text: string,
  tools: ToolSchema[],
): { calls: ToolCall[]; remainingText: string } {
  const allowed = new Set(tools.map((t) => t.function.name as string));
  const paramOrder = new Map<string, string[]>();
  for (const t of tools) {
    const p = t.function.parameters as { properties?: Record<string, unknown>; required?: string[] };
    const req = p.required ?? [];
    const rest = Object.keys(p.properties ?? {}).filter((k) => !req.includes(k));
    paramOrder.set(t.function.name, [...req, ...rest]);
  }
  const calls: ToolCall[] = [];
  let remaining = text;
  const candidates: Array<{ raw: string; whole: string }> = [];

  for (const m of text.matchAll(TAGGED_BLOCK)) candidates.push({ raw: m[2], whole: m[0] });
  for (const m of text.matchAll(FENCED_JSON)) candidates.push({ raw: m[1], whole: m[0] });
  if (candidates.length === 0) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) candidates.push({ raw: trimmed, whole: trimmed });
  }

  for (const c of candidates) {
    const obj = tryParseJson(c.raw);
    if (!obj) continue;
    const list = Array.isArray(obj) ? obj : [obj];
    let matched = false;
    for (const item of list) {
      const call = normalizeCall(item, allowed);
      if (call) {
        calls.push(call);
        matched = true;
      }
    }
    if (matched) remaining = remaining.replace(c.whole, '');
  }

  // Python-style calls: write_file(path="a.txt", content="hi")
  if (calls.length === 0) {
    const py = parsePythonCalls(text, allowed, paramOrder);
    for (const c of py) {
      calls.push(c.call);
      remaining = remaining.replace(c.whole, '');
    }
  }
  return { calls, remainingText: remaining.trim() };
}

// ---------- Python-style call parser ----------

/** Names small models commonly invent, mapped to the real tool. */
const TOOL_ALIASES: Record<string, string> = {
  create_file: 'write_file',
  save_file: 'write_file',
  write: 'write_file',
  write_to_file: 'write_file',
  read: 'read_file',
  open_file: 'read_file',
  cat: 'read_file',
  view_file: 'read_file',
  replace_in_file: 'edit_file',
  modify_file: 'edit_file',
  str_replace: 'edit_file',
  list_files: 'list_dir',
  list_directory: 'list_dir',
  ls: 'list_dir',
  find_files: 'glob',
  search_files: 'grep',
  search: 'grep',
  rg: 'grep',
  run_command: 'shell_run',
  run_shell: 'shell_run',
  run_shell_command: 'shell_run',
  execute_command: 'shell_run',
  execute: 'shell_run',
  bash: 'shell_run',
  shell: 'shell_run',
  run: 'shell_run',
  terminal: 'shell_run',
  ask: 'ask_user',
  ask_question: 'ask_user',
  delegate: 'delegate_to_worker',
  spawn_worker: 'delegate_to_worker',
  set_plan: 'update_plan',
  plan: 'update_plan',
};
/** Unknown names that still look like tool calls get passed through so the model receives an "unknown tool" error. */
const TOOLISH = /^(create|write|read|edit|list|run|execute|open|search|find|delete|remove|append|update|spawn|delegate|terminal|shell)_\w+$/;

function parsePythonCalls(
  text: string,
  allowed: Set<string>,
  paramOrder: Map<string, string[]>,
): Array<{ call: ToolCall; whole: string }> {
  const out: Array<{ call: ToolCall; whole: string }> = [];
  const re = /(?<![\w.])([a-zA-Z_][\w]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let name = m[1];
    if (!allowed.has(name)) {
      const alias = TOOL_ALIASES[name];
      if (alias && allowed.has(alias)) name = alias;
      else if (!TOOLISH.test(name)) continue;
    }
    const start = m.index + m[0].length;
    const end = findClosingParen(text, start);
    if (end < 0) continue;
    const inner = text.slice(start, end);
    const args = parsePythonArgs(inner, paramOrder.get(name) ?? []);
    if (!args) continue;
    if (!allowed.has(name) && Object.keys(args).length === 0) continue;
    const whole = text.slice(m.index, end + 1);
    out.push({
      call: {
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
      whole,
    });
    re.lastIndex = end + 1;
  }
  return out;
}

/** Index of the ')' matching an already-consumed '(' at `start`, honouring quoted strings. -1 if none. */
function findClosingParen(s: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const triple = s.startsWith(ch.repeat(3), i);
      const q = triple ? ch.repeat(3) : ch;
      i += q.length;
      while (i < s.length && !s.startsWith(q, i)) {
        if (s[i] === '\\') i++;
        i++;
      }
      i += q.length;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Parse a Python-style argument list: positional and/or `key=value` pairs with literal values.
 * Positional arguments are mapped onto `order` (required params first). Returns null if the shape is wrong.
 */
function parsePythonArgs(inner: string, order: string[]): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  let i = 0;
  let positional = 0;
  const skipWs = () => {
    while (i < inner.length && /\s/.test(inner[i])) i++;
  };
  skipWs();
  if (i >= inner.length) return args;
  while (i < inner.length) {
    skipWs();
    const km = /^([a-zA-Z_]\w*)\s*=(?!=)/.exec(inner.slice(i));
    let key: string;
    if (km) {
      key = km[1];
      i += km[0].length;
      skipWs();
    } else {
      if (positional >= order.length) return null;
      key = order[positional++];
    }
    const v = parsePythonValue(inner, i);
    if (!v) return null;
    args[key] = v.value;
    i = v.end;
    skipWs();
    if (inner[i] === ',') {
      i++;
      skipWs();
      if (i >= inner.length) break; // trailing comma
      continue;
    }
    if (i >= inner.length) break;
    return null;
  }
  return args;
}

function parsePythonValue(s: string, i: number): { value: unknown; end: number } | null {
  const ch = s[i];
  if (ch === '"' || ch === "'") {
    const triple = s.startsWith(ch.repeat(3), i);
    const q = triple ? ch.repeat(3) : ch;
    let j = i + q.length;
    let out = '';
    while (j < s.length && !s.startsWith(q, j)) {
      if (s[j] === '\\' && j + 1 < s.length) {
        const n = s[j + 1];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === '\\' ? '\\' : n === '"' ? '"' : n === "'" ? "'" : n;
        j += 2;
        continue;
      }
      out += s[j++];
    }
    if (j >= s.length) return null;
    return { value: out, end: j + q.length };
  }
  if (ch === '[' || ch === '{') {
    const end = findClosingParen(s, i + 1);
    if (end < 0) return null;
    const raw = s.slice(i, end + 1);
    const json = tryParseJson(raw.replace(/'/g, '"').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null'));
    return { value: json ?? raw, end: end + 1 };
  }
  const lit = /^(True|False|None|-?\d+(?:\.\d+)?)/.exec(s.slice(i));
  if (lit) {
    const t = lit[1];
    const value = t === 'True' ? true : t === 'False' ? false : t === 'None' ? null : Number(t);
    return { value, end: i + t.length };
  }
  return null;
}

function tryParseJson(raw: string): unknown {
  const v = parseLenientJson(raw);
  return v === undefined ? null : v;
}

function normalizeCall(item: unknown, allowed: Set<string>): ToolCall | null {
  if (!item || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  const fn = (o.function as Record<string, unknown> | undefined) ?? o;
  let name = (fn.name ?? o.tool ?? o.tool_name ?? o.action ?? o.function_name ?? o.command_name) as string | undefined;
  // Shape: {"write_file": {"path": ...}} — tool name used as the only key.
  if (!name) {
    const keys = Object.keys(o);
    if (keys.length === 1 && (allowed.has(keys[0]) || TOOL_ALIASES[keys[0]]) && typeof o[keys[0]] === 'object') {
      return normalizeCall({ name: keys[0], arguments: o[keys[0]] }, allowed);
    }
    return null;
  }
  if (!allowed.has(name)) {
    const alias = TOOL_ALIASES[name];
    if (alias && allowed.has(alias)) name = alias;
    else if (!TOOLISH.test(name)) return null;
  }
  const args = fn.arguments ?? fn.parameters ?? o.arguments ?? o.parameters ?? o.params ?? o.args ?? o.input ?? {};
  const argStr = typeof args === 'string' ? args : JSON.stringify(args);
  return {
    id: `call_${Math.random().toString(36).slice(2, 10)}`,
    type: 'function',
    function: { name, arguments: argStr },
  };
}
