import OpenAI from 'openai';
import type { ChatMessage, ModelInfo, ToolCall, ToolSchema } from '@localdex/shared';
import { getSettings } from './config.js';
import { bus } from './agent/bus.js';

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number } | null;
  finishReason: string | null;
  /** true when tool calls were recovered from plain text rather than native tool_calls */
  parsedFromText: boolean;
}

export interface StreamOptions {
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  temperature?: number;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onReasoning?: (text: string) => void;
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
- Arguments must be valid JSON (escape newlines in strings as \\n).
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
      },
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
  const { models } = await probeModels(getSettings().baseUrl);
  for (const m of models) modelCache.set(m.id, m);
  return models;
}

/** What kind of local server answered: LM Studio's native API, Ollama's, or a plain OpenAI-compatible one. */
export type LocalServerKind = 'lmstudio' | 'ollama' | 'openai';

/**
 * List the chat models an OpenAI-compatible server offers, without touching settings.
 * LM Studio's native API adds load state and context length; Ollama's /api/ps says which models are in memory.
 * Throws when nothing answers.
 */
export async function probeModels(baseUrl: string, timeoutMs = 4000): Promise<{ kind: LocalServerKind; models: ModelInfo[] }> {
  const base = baseUrl.replace(/\/+$/, '');
  const root = base.replace(/\/v1$/, '');
  // LM Studio's native REST API exposes load state and context length.
  try {
    const res = await fetch(`${root}/api/v0/models`, { signal: AbortSignal.timeout(timeoutMs) });
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
      if (Array.isArray(data?.data)) {
        const models = data.data
          .filter((m) => m.type === 'llm' || m.type === 'vlm')
          .map((m) => ({
            id: m.id,
            loaded: m.state === 'loaded',
            contextLength: m.loaded_context_length ?? m.max_context_length,
          }));
        return { kind: 'lmstudio', models };
      }
    }
  } catch {
    /* not LM Studio, or not running */
  }
  const res = await fetch(`${base}/models`, { headers: { authorization: 'Bearer lm-studio' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${base}/models answered ${res.status}`);
  const list = (await res.json()) as { data?: Array<{ id?: string }> };
  if (!Array.isArray(list?.data)) throw new Error(`${base}/models is not an OpenAI-compatible model list`);
  const models: ModelInfo[] = list.data.filter((m) => typeof m.id === 'string' && m.id).map((m) => ({ id: m.id! }));
  // Ollama: /api/ps lists the models currently loaded in memory.
  try {
    const ps = await fetch(`${root}/api/ps`, { signal: AbortSignal.timeout(Math.min(timeoutMs, 2000)) });
    if (ps.ok) {
      const j = (await ps.json()) as { models?: Array<{ name?: string; model?: string; context_length?: number }> };
      if (Array.isArray(j?.models)) {
        const loaded = new Map(j.models.map((m) => [m.name ?? m.model ?? '', m.context_length]));
        return { kind: 'ollama', models: models.map((m) => ({ ...m, loaded: loaded.has(m.id), contextLength: loaded.get(m.id) || undefined })) };
      }
    }
  } catch {
    /* plain OpenAI-compatible server */
  }
  return { kind: 'openai', models };
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
  const settings = getSettings();
  const mode = opts.tools.length ? await resolveToolMode(opts.model) : 'native';
  const textMode = mode === 'text';
  const stream = await client().chat.completions.create(
    {
      model: opts.model,
      messages: textMode ? toWireText(opts.messages, opts.tools) : toWire(opts.messages),
      tools: !textMode && opts.tools.length ? (opts.tools as OpenAI.ChatCompletionTool[]) : undefined,
      temperature: opts.temperature ?? settings.temperature,
      stream: true,
      stream_options: { include_usage: true },
    },
    { signal: opts.signal },
  );

  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;
  let usage: StreamResult['usage'] = null;
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();

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
  try {
    return JSON.parse(raw);
  } catch {
    // Attempt to repair common mistakes: trailing commas, single quotes.
    try {
      return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
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
