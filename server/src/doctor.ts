// E4: Model doctor. Scripted tool-calling probes against the loaded local model (native protocol and text protocol),
// a speed test, a score card, and suggested settings (tool mode, reasoning, context size for this machine's RAM).
// Probes are single requests with canned history: nothing touches the user's files or runs a command.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DoctorProbe, DoctorReport, ToolCall, ToolSchema } from '@localdex/shared';
import { DATA_DIR, getSettings } from './config.js';
import { listModels, streamChat } from './lmstudio.js';
import { edit_file, read_file, write_file } from './tools/fs.js';
import { shell_run } from './tools/shell.js';
import { parseArgs } from './tools/index.js';
import { bus } from './agent/bus.js';

const DOCTOR_DIR = path.join(DATA_DIR, 'doctor');
const TOOLS: ToolSchema[] = [read_file.schema, write_file.schema, edit_file.schema, shell_run.schema];
const SYSTEM = 'You are a coding agent with tools. Use a tool whenever the task needs one. Never claim results you did not see in a tool result.';

interface ProbeSpec {
  id: string;
  title: string;
  /** Messages after the system prompt. */
  messages: Array<Record<string, unknown>>;
  check(r: { content: string; calls: ToolCall[] }): { pass: boolean; detail: string };
}

const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const argsOf = (c?: ToolCall): Record<string, unknown> => (c ? parseArgs(c) : {});
const FILE = 'def greet(name):\n    return "Hello, " + name\n';

const PROBES: ProbeSpec[] = [
  {
    id: 'single_call',
    title: 'Calls a tool',
    messages: [{ role: 'user', content: 'Read the file notes.txt.' }],
    check: ({ calls }) => {
      const a = argsOf(calls[0]);
      return { pass: calls[0]?.function.name === 'read_file' && /notes\.txt$/.test(String(a.path ?? '')), detail: calls[0] ? `${calls[0].function.name} ${calls[0].function.arguments.slice(0, 80)}` : 'no tool call' };
    },
  },
  {
    id: 'right_tool',
    title: 'Picks the right tool',
    messages: [{ role: 'user', content: 'Run the test suite with `npm test`.' }],
    check: ({ calls }) => {
      const a = argsOf(calls[0]);
      return { pass: calls[0]?.function.name === 'shell_run' && /npm (run )?test/.test(String(a.command ?? '')), detail: calls[0] ? `${calls[0].function.name} ${String(a.command ?? '').slice(0, 60)}` : 'no tool call' };
    },
  },
  {
    id: 'json_newlines',
    title: 'Multi-line content survives',
    messages: [{ role: 'user', content: "Create the file hello.py containing exactly these two lines:\nprint('a')\nprint('b')" }],
    check: ({ calls }) => {
      const a = argsOf(calls[0]);
      const content = String(a.content ?? '').replace(/\r\n/g, '\n').trim();
      return { pass: calls[0]?.function.name === 'write_file' && /hello\.py$/.test(String(a.path ?? '')) && content === "print('a')\nprint('b')", detail: calls[0] ? `${calls[0].function.name} content=${JSON.stringify(content).slice(0, 60)}` : 'no tool call' };
    },
  },
  {
    id: 'edit_lands',
    title: 'Edit lands (uses text it read)',
    messages: [
      { role: 'user', content: 'In greet.py, change the greeting from "Hello" to "Hi".' },
      { role: 'assistant', content: null, tool_calls: [call('r1', 'read_file', { path: 'greet.py' })] },
      { role: 'tool', tool_call_id: 'r1', name: 'read_file', content: `greet.py (2 lines)\n1| def greet(name):\n2|     return "Hello, " + name` },
    ],
    check: ({ calls }) => {
      const c = calls[0];
      const a = argsOf(c);
      let landed = false;
      if (c?.function.name === 'edit_file') {
        const old = String(a.old_string ?? '');
        landed = !!old && FILE.includes(old) && FILE.split(old).length === 2 && FILE.replace(old, String(a.new_string ?? '')).includes('"Hi, "');
      } else if (c?.function.name === 'write_file') {
        landed = /"Hi, "/.test(String(a.content ?? '')) && /def greet/.test(String(a.content ?? ''));
      }
      return { pass: landed, detail: c ? `${c.function.name} ${c.function.arguments.slice(0, 90)}` : 'no tool call' };
    },
  },
  {
    id: 'honest_failure',
    title: 'Honest when a tool fails',
    messages: [
      { role: 'user', content: 'What port does config.yaml set?' },
      { role: 'assistant', content: null, tool_calls: [call('r2', 'read_file', { path: 'config.yaml' })] },
      { role: 'tool', tool_call_id: 'r2', name: 'read_file', content: 'Error: ENOENT: no such file or directory, open config.yaml' },
    ],
    check: ({ content, calls }) => {
      const admits = /not (found|exist)|doesn'?t exist|does not exist|missing|couldn'?t|could not|cannot|can'?t|no such|unable/i.test(content);
      const invents = /\bport\b[^.\n]{0,30}\b\d{2,5}\b/i.test(content) && !/\bif\b|\bdefault\b|\btypically\b|\busually\b/i.test(content);
      const retries = calls.length > 0; // looking elsewhere (glob, shell_run ls) is honest too
      return { pass: (admits || retries) && !invents, detail: content ? content.slice(0, 90).replace(/\s+/g, ' ') : calls[0] ? `called ${calls[0].function.name}` : 'empty reply' };
    },
  },
  {
    id: 'stops_when_done',
    title: 'Stops when the task is done',
    messages: [
      { role: 'user', content: 'Show me what is in todo.txt.' },
      { role: 'assistant', content: null, tool_calls: [call('r3', 'read_file', { path: 'todo.txt' })] },
      { role: 'tool', tool_call_id: 'r3', name: 'read_file', content: 'todo.txt (2 lines)\n1| buy milk\n2| fix bike' },
    ],
    check: ({ content, calls }) => ({ pass: calls.length === 0 && /milk/i.test(content) && /bike/i.test(content), detail: calls.length ? `called ${calls[0].function.name} again` : content.slice(0, 90).replace(/\s+/g, ' ') }),
  },
];

/** Rough parameter count from the model id ("gemma-4-12b-it" → 12). Null when the id doesn't say. */
export function paramsFromId(id: string): number | null {
  const m = id.toLowerCase().match(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?:[^a-z0-9]|$)/);
  const mixture = id.toLowerCase().match(/(\d+)x(\d+(?:\.\d+)?)b/);
  if (mixture) return Number(mixture[1]) * Number(mixture[2]);
  return m ? Number(m[1]) : null;
}

/**
 * Context size that fits next to the model in RAM. Rule of thumb (4-bit quantization): weights ≈ 0.55 GB per billion
 * parameters, KV cache ≈ 0.0055 GB per billion parameters per 1k tokens, ~2 GB for the OS and LM Studio, using at
 * most 75% of RAM. Rounded down to a power of two between 8k and 128k. A guide, not a guarantee.
 */
export function suggestContext(totalRamGb: number, paramsB: number | null, maxContext?: number): { tokens: number | null; why: string } {
  if (!paramsB) return { tokens: null, why: "couldn't tell the model's size from its name" };
  const weights = paramsB * 0.55;
  const budget = totalRamGb * 0.75 - weights - 2;
  if (budget <= 0) return { tokens: 4096, why: `a ${paramsB}B model is about ${weights.toFixed(1)} GB at 4-bit, which barely fits in ${Math.round(totalRamGb)} GB; expect swapping` };
  const kTokens = budget / (paramsB * 0.0055);
  let tokens = 8192;
  while (tokens * 2 <= kTokens * 1024 && tokens < 131072) tokens *= 2;
  if (kTokens * 1024 < 8192) tokens = Math.max(4096, Math.floor(kTokens) * 1024);
  if (maxContext && tokens > maxContext) tokens = maxContext;
  return { tokens, why: `${Math.round(totalRamGb)} GB RAM, ${paramsB}B model ≈ ${weights.toFixed(1)} GB at 4-bit, leaving ≈ ${budget.toFixed(1)} GB for context` };
}

function safeName(model: string): string {
  return model.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

async function probeOnce(model: string, mode: 'native' | 'text', p: ProbeSpec, signal: AbortSignal): Promise<DoctorProbe> {
  const t0 = Date.now();
  try {
    const r = await streamChat({ model, toolMode: mode, reasoning: 'off', temperature: 0, signal, tools: TOOLS, messages: [{ role: 'system', content: SYSTEM }, ...(p.messages as never[])] });
    const v = p.check({ content: r.content ?? '', calls: r.toolCalls });
    return { id: p.id, title: p.title, mode, pass: v.pass, detail: v.detail, ms: Date.now() - t0 };
  } catch (e) {
    return { id: p.id, title: p.title, mode, pass: false, detail: `error: ${String((e as Error).message).split('\n')[0].slice(0, 120)}`, ms: Date.now() - t0 };
  }
}

let running: AbortController | null = null;

export function doctorRunning(): boolean {
  return running !== null;
}

export function stopDoctor(): void {
  running?.abort();
}

/** Run every probe in both protocols, then a speed test; save and return the report. */
export async function runDoctor(modelArg?: string): Promise<DoctorReport> {
  if (running) throw new Error('The model doctor is already running.');
  const model = modelArg || getSettings().model;
  if (!model) throw new Error('Pick a model first (top bar).');
  const ac = new AbortController();
  running = ac;
  const total = PROBES.length * 2 + 1;
  let done = 0;
  const progress = (label: string) => bus.emit({ type: 'doctor_progress', model, done, total, label });
  try {
    const info = (await listModels().catch(() => [])).find((m) => m.id === model);
    const probes: DoctorProbe[] = [];
    for (const mode of ['native', 'text'] as const) {
      for (const p of PROBES) {
        progress(`${mode}: ${p.title}`);
        probes.push(await probeOnce(model, mode, p, ac.signal));
        done++;
        if (ac.signal.aborted) throw new Error('Stopped.');
      }
    }
    progress('speed test');
    const speed = await speedTest(model, ac.signal);
    done++;
    const score = (mode: 'native' | 'text') => probes.filter((p) => p.mode === mode && p.pass).length;
    const nativeScore = score('native');
    const textScore = score('text');
    const ram = os.totalmem() / 1024 ** 3;
    const params = paramsFromId(model);
    const ctx = suggestContext(ram, params, info?.maxContextLength);
    // Native is cheaper (no protocol text in the prompt), so it wins ties.
    const toolMode: 'native' | 'text' = nativeScore >= textScore ? 'native' : 'text';
    const best = Math.max(nativeScore, textScore);
    const edits = probes.filter((p) => p.mode === toolMode && (p.id === 'edit_lands' || p.id === 'json_newlines'));
    const report: DoctorReport = {
      model,
      ranAt: Date.now(),
      probes,
      score: { native: nativeScore, text: textScore, of: PROBES.length },
      editsLanded: edits.filter((p) => p.pass).length,
      editsTried: edits.length,
      speed,
      machine: { ramGb: Math.round(ram), paramsB: params, loadedContext: info?.contextLength ?? null },
      suggest: {
        toolMode,
        toolModeWhy: `native ${nativeScore}/${PROBES.length}, text ${textScore}/${PROBES.length}`,
        reasoning: 'auto',
        reasoningWhy: info?.reasoningSwitch ? 'this model has a reasoning switch: Auto turns thinking off while tools are available, which keeps tool calls clean and steps fast' : 'no reasoning switch reported: Auto leaves the model as it is',
        contextLength: ctx.tokens,
        contextWhy: ctx.why,
      },
      verdict: best >= PROBES.length - 1 ? 'good' : best >= PROBES.length - 3 ? 'usable' : 'poor',
    };
    fs.mkdirSync(DOCTOR_DIR, { recursive: true });
    fs.writeFileSync(path.join(DOCTOR_DIR, `${safeName(model)}.json`), JSON.stringify(report, null, 2));
    bus.emit({ type: 'doctor_result', report });
    return report;
  } finally {
    running = null;
  }
}

async function speedTest(model: string, signal: AbortSignal): Promise<DoctorReport['speed']> {
  try {
    const r = await streamChat({ model, tools: [], reasoning: 'off', temperature: 0.2, signal, messages: [{ role: 'user', content: 'Write about 120 words on how rivers shape valleys. Plain prose, no lists.' }] });
    const t = r.timing;
    const ttft = t?.firstTokenAt ? t.firstTokenAt - t.startedAt : null;
    const genMs = t?.firstTokenAt ? t.endedAt - t.firstTokenAt : null;
    const tokens = r.usage?.completionTokens ?? Math.round((r.content?.length ?? 0) / 4);
    return { ttftMs: ttft, tokensPerSecond: genMs && genMs > 0 ? Math.round((tokens / (genMs / 1000)) * 10) / 10 : null, completionTokens: tokens };
  } catch {
    return { ttftMs: null, tokensPerSecond: null, completionTokens: 0 };
  }
}

/** Saved reports, newest first, so models can be compared. */
export function doctorReports(): DoctorReport[] {
  try {
    return fs
      .readdirSync(DOCTOR_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(DOCTOR_DIR, f), 'utf8')) as DoctorReport)
      .sort((a, b) => b.ranAt - a.ranAt);
  } catch {
    return [];
  }
}
