import type { AgentId, ChatMessage, PlanStep, ToolCall, ToolSchema } from '@localdex/shared';
import { streamChat } from '../lmstudio.js';
import { executeTool } from '../tools/index.js';
import type { ToolContext } from '../tools/types.js';
import { bus } from './bus.js';

export type StopReason = 'done' | 'max_steps' | 'aborted' | 'error';

export interface LoopParams {
  sessionId: string;
  agent: AgentId;
  model: string;
  /** Mutated in place: assistant and tool messages are appended. */
  messages: ChatMessage[];
  tools: ToolSchema[];
  signal: AbortSignal;
  maxSteps: number;
  temperature?: number;
  delegate?: (name: string, task: string) => Promise<string>;
  updatePlan?: (steps: PlanStep[]) => void;
  /** Called before each model call; returns user messages to inject (mid-run corrections). */
  pullCorrections?: () => string[];
  /** Called before each model call; may compact `messages` in place. */
  beforeStep?: () => Promise<void>;
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
  onPersist?: () => void;
}

export interface LoopResult {
  text: string;
  steps: number;
  reason: StopReason;
  error?: string;
}

const MAX_CONSECUTIVE_FAILURES = 4;
const MAX_NUDGES = 2;

/** Heuristic: does a reply with no parsed tool calls look like a botched attempt at one? */
function looksLikeToolAttempt(content: string, toolNames: string[]): boolean {
  if (!content) return false;
  if (/<tool_call/i.test(content)) return true;
  const fenced = content.match(/```(?:json|tool_call|tool)?\s*([\s\S]*?)```/g) ?? [];
  for (const block of fenced) {
    if (/"(name|action|tool|function|tool_name)"\s*:/.test(block) && /"(arguments|params|parameters|args|input)"\s*:/.test(block)) return true;
    if (toolNames.some((n) => new RegExp(`"${n}"\\s*:`).test(block))) return true;
  }
  return false;
}

export async function runLoop(p: LoopParams): Promise<LoopResult> {
  const { sessionId, agent } = p;
  let lastText = '';
  let consecutiveFailures = 0;
  let nudges = 0;

  for (let step = 0; step < p.maxSteps; step++) {
    if (p.signal.aborted) return { text: lastText, steps: step, reason: 'aborted' };

    for (const c of p.pullCorrections?.() ?? []) {
      p.messages.push({ role: 'user', content: c, ts: Date.now() });
      bus.log('info', `[${agent}] correction injected: ${c.slice(0, 80)}`);
    }
    await p.beforeStep?.();
    p.onPersist?.();

    bus.emit({ type: 'turn_start', sessionId, agent });
    bus.emit({ type: 'agent_status', sessionId, agent, status: 'thinking' });

    let result;
    try {
      result = await streamChat({
        model: p.model,
        messages: p.messages,
        tools: p.tools,
        temperature: p.temperature,
        signal: p.signal,
        onDelta: (delta) => bus.emit({ type: 'assistant_delta', sessionId, agent, delta }),
        onReasoning: (delta) => bus.emit({ type: 'reasoning_delta', sessionId, agent, delta }),
      });
    } catch (e) {
      const err = e as Error;
      bus.emit({ type: 'turn_end', sessionId, agent });
      if (p.signal.aborted || err.name === 'AbortError' || /abort/i.test(err.message)) {
        return { text: lastText, steps: step, reason: 'aborted' };
      }
      const msg = describeError(err);
      bus.emit({ type: 'agent_status', sessionId, agent, status: 'error', detail: msg });
      bus.emit({ type: 'error', sessionId, message: msg });
      return { text: lastText, steps: step, reason: 'error', error: msg };
    }

    if (result.usage) p.onUsage?.(result.usage);

    const assistant: ChatMessage = {
      role: 'assistant',
      content: result.content || null,
      ts: Date.now(),
    };
    if (result.reasoning) assistant.reasoning = result.reasoning;
    if (result.toolCalls.length) assistant.tool_calls = result.toolCalls;
    p.messages.push(assistant);
    bus.emit({ type: 'turn_end', sessionId, agent });
    if (result.content) lastText = result.content;
    if (result.parsedFromText) bus.log('warn', `[${agent}] recovered tool call(s) from plain text output`);

    if (result.toolCalls.length === 0) {
      if (result.finishReason === 'length') {
        bus.log('warn', `[${agent}] response was cut off (finish_reason=length)`);
      }
      // The model tried to call a tool in a shape we could not parse: nudge it once instead of ending the run.
      if (nudges < MAX_NUDGES && looksLikeToolAttempt(result.content, p.tools.map((t) => t.function.name))) {
        nudges++;
        bus.log('warn', `[${agent}] reply looked like a malformed tool call; asking the model to retry (${nudges}/${MAX_NUDGES})`);
        p.messages.push({
          role: 'user',
          content:
            '[system] That looked like a tool call but it was not in a valid format, so nothing was executed. Call the tool again using exactly this form on its own line:\n<tool_call>{"name": "<tool_name>", "arguments": { ... }}</tool_call>',
          ts: Date.now(),
        });
        continue;
      }
      p.onPersist?.();
      return { text: lastText, steps: step + 1, reason: 'done' };
    }
    nudges = 0;

    bus.emit({ type: 'agent_status', sessionId, agent, status: 'tool' });
    const ctx: ToolContext = {
      sessionId,
      agent,
      signal: p.signal,
      requestApproval: (cmd, cwd) => bus.requestApproval(sessionId, agent, cmd, cwd, p.signal),
      askUser: (q) => bus.askUser(sessionId, agent, q, p.signal),
      delegate: p.delegate,
      updatePlan: p.updatePlan,
    };

    const outcomes = await executeCalls(result.toolCalls, ctx);
    let allFailed = true;
    for (const { call, ok, content } of outcomes) {
      if (ok) allFailed = false;
      p.messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content,
        ok,
        ts: Date.now(),
      });
    }
    p.onPersist?.();
    if (p.signal.aborted) return { text: lastText, steps: step + 1, reason: 'aborted' };

    consecutiveFailures = allFailed ? consecutiveFailures + 1 : 0;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      p.messages.push({
        role: 'user',
        content: `[system] ${consecutiveFailures} tool calls in a row failed. Stop retrying the same thing: explain the problem to the user and ask how to proceed, or try a clearly different approach.`,
        ts: Date.now(),
      });
      consecutiveFailures = 0;
    }
  }

  bus.log('warn', `[${agent}] reached max steps (${p.maxSteps})`);
  return { text: lastText, steps: p.maxSteps, reason: 'max_steps' };
}

interface Outcome {
  call: ToolCall;
  ok: boolean;
  content: string;
}

/**
 * Delegations run in parallel with each other; everything else runs sequentially in call order,
 * and any non-delegation call waits for in-flight delegations first (the model usually wants
 * to read what the workers produced).
 */
async function executeCalls(calls: ToolCall[], ctx: ToolContext): Promise<Outcome[]> {
  const results: Outcome[] = new Array(calls.length);
  let parallel: Promise<void>[] = [];

  const runOne = async (i: number) => {
    const call = calls[i];
    let args: unknown = call.function.arguments;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      /* show raw */
    }
    bus.emit({ type: 'tool_start', sessionId: ctx.sessionId, agent: ctx.agent, callId: call.id, name: call.function.name, args });
    const r = await executeTool(call, ctx);
    bus.emit({
      type: 'tool_end',
      sessionId: ctx.sessionId,
      agent: ctx.agent,
      callId: call.id,
      name: call.function.name,
      ok: r.ok,
      result: r.content,
    });
    results[i] = { call, ok: r.ok, content: r.content };
  };

  for (let i = 0; i < calls.length; i++) {
    if (calls[i].function.name === 'delegate_to_worker') {
      parallel.push(runOne(i));
      continue;
    }
    if (parallel.length) {
      await Promise.all(parallel);
      parallel = [];
    }
    if (ctx.signal.aborted) {
      results[i] = { call: calls[i], ok: false, content: 'Cancelled by user.' };
      continue;
    }
    await runOne(i);
  }
  await Promise.all(parallel);
  return results;
}

function describeError(err: Error & { status?: number; code?: string }): string {
  const m = err.message || String(err);
  if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(m)) {
    return `Cannot reach LM Studio. Start the server (LM Studio → Developer → Start, or "lms server start") and check the base URL in Settings. (${m})`;
  }
  if (err.status === 404 || /model.*not found|No models loaded/i.test(m)) {
    return `Model not available in LM Studio. Load it or pick another in the model menu. (${m})`;
  }
  if (/context length|too many tokens|exceeds/i.test(m)) {
    return `The conversation exceeded the model's context window. Use Compact & Resume or raise the context length in LM Studio. (${m})`;
  }
  return m;
}
