import type { ToolCall, ToolName, ToolSchema } from '@localdex/shared';
import { readOnlyPreset } from './fs.js';
import { getSettings } from '../config.js';
import { edit_file, glob, list_dir, read_file, write_file } from './fs.js';
import { grep } from './search.js';
import { shell_run } from './shell.js';
import { TERMINAL_TOOLS, ptyAvailable, terminal_close, terminal_open, terminal_read, terminal_send } from './terminal.js';
import { ask_user, delegate_to_worker, update_plan } from './agentTools.js';
import { load_skill } from './skillTool.js';
import { ask_member, council } from './councilTools.js';
import { block_goal, complete_goal, get_goal, update_goal } from './goalTools.js';
import { job_kill, job_list, job_output } from './jobTools.js';
import { web_fetch, web_search } from './web.js';
import { enabledSkills } from '../skills/store.js';
import { PermissionError } from './permissions.js';
import { isMcpTool, mcpToolSchemas, runMcpTool } from '../mcp/client.js';
import type { ToolContext, ToolDef, ToolRegistry, ToolResult } from './types.js';
import { parseLenientJson } from '../jsonRepair.js';
import { isPlanTool } from '../agent/planMode.js';

export const registry: ToolRegistry = {
  read_file,
  write_file,
  edit_file,
  list_dir,
  glob,
  grep,
  shell_run,
  terminal_open,
  terminal_send,
  terminal_read,
  terminal_close,
  ask_user,
  delegate_to_worker,
  update_plan,
  load_skill,
  ask_member,
  council,
  get_goal,
  update_goal,
  complete_goal,
  block_goal,
  job_output,
  job_list,
  job_kill,
  web_fetch,
  web_search,
};
/** Offered once the session has started a background job (shell_run with background: true). */
export const JOB_TOOLS = new Set<ToolName>(['job_output', 'job_list', 'job_kill']);

const COUNCIL_TOOLS = new Set<ToolName>(['ask_member', 'council']);
/** Only offered while a local-led goal runs (ToolContext.goal is set), so idle sessions pay nothing for them. */
export const GOAL_TOOLS = new Set<ToolName>(['get_goal', 'update_goal', 'complete_goal', 'block_goal']);

export interface ToolSetOptions {
  planMode?: boolean;
  /** A local-led goal is active: the goal tools are shown. */
  goal?: boolean;
  /** The session has background jobs: the job tools are shown. */
  jobs?: boolean;
}

/**
 * Tool schemas enabled for a given agent kind, honouring the user's capability toggles.
 * In plan mode only the read-only tools (and update_plan / ask_user / load_skill) are offered; MCP tools are hidden too.
 */
export function enabledTools(kind: 'main' | 'worker', opts: ToolSetOptions = {}): ToolSchema[] {
  const caps = getSettings().capabilities;
  const councilOn = getSettings().council.enabled;
  const builtin = (Object.keys(registry) as ToolName[])
    .filter((name) => caps[name] !== false)
    .filter((name) => kind === 'main' || !registry[name].mainOnly)
    // No point showing a small model a tool it can't use.
    .filter((name) => name !== 'load_skill' || enabledSkills().length > 0)
    .filter((name) => councilOn || !COUNCIL_TOOLS.has(name))
    .filter((name) => (opts.goal && kind === 'main') || !GOAL_TOOLS.has(name))
    .filter((name) => opts.jobs || !JOB_TOOLS.has(name))
    // No search server configured: the tool would only ever fail, so it is not shown.
    .filter((name) => name !== 'web_search' || !!getSettings().webSearchUrl?.trim())
    // Without node-pty (optional on Linux) the terminal tools can't work, so the model isn't shown them.
    .filter((name) => !TERMINAL_TOOLS.has(name) || ptyAvailable().ok)
    .filter((name) => !opts.planMode || isPlanTool(name))
    // Read only preset (S3): the write tools are off.
    .filter((name) => !(readOnlyPreset() && (name === 'write_file' || name === 'edit_file')))
    .map((name) => registry[name].schema);
  return opts.planMode ? builtin : [...builtin, ...mcpToolSchemas(kind)];
}

/** Built-in tools that cannot work on this install, with the reason, for Settings → Capabilities. */
export function unavailableTools(): Partial<Record<ToolName, string>> {
  const pty = ptyAvailable();
  if (pty.ok) return {};
  const why = `node-pty is not installed (${pty.error ?? 'module not found'}).`;
  return Object.fromEntries([...TERMINAL_TOOLS].map((t) => [t, why])) as Partial<Record<ToolName, string>>;
}

export function parseArgs(call: ToolCall): Record<string, unknown> {
  const raw = call.function.arguments?.trim() || '{}';
  // Lenient: raw newlines inside strings, Gemma string tokens, trailing commas, smart quotes.
  const v = parseLenientJson(raw);
  if (v === undefined) throw new Error(`Tool arguments were not valid JSON: ${raw.slice(0, 200)}`);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export const PLAN_TOOL_REFUSAL = 'Plan mode: this tool is not available until the user approves the plan. Describe the step in the plan (update_plan) instead; only read_file, list_dir, glob, grep and read-only shell_run work now.';

export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  // Plan mode is enforced here too: a model that calls a hidden tool anyway gets a refusal, not a side effect.
  if (ctx.planMode && !isPlanTool(call.function.name)) return { ok: false, content: PLAN_TOOL_REFUSAL };
  if (isMcpTool(call.function.name)) {
    try {
      return await runMcpTool(call.function.name, parseArgs(call), ctx);
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') return { ok: false, content: 'Cancelled by user.' };
      return { ok: false, content: `${call.function.name} failed: ${err.message}` };
    }
  }
  const name = call.function.name as ToolName;
  const def: ToolDef | undefined = registry[name];
  if (!def && name.startsWith('mcp_')) {
    return { ok: false, content: `MCP tool "${name}" is no longer available: its server stopped, crashed or was disabled. Tell the user, and continue without it if you can.` };
  }
  if (!def) return { ok: false, content: `Unknown tool "${name}". Available: ${Object.keys(registry).join(', ')}` };
  if (getSettings().capabilities[name] === false) {
    return { ok: false, content: `Tool "${name}" is disabled in Settings → Capabilities.` };
  }
  if (COUNCIL_TOOLS.has(name) && !getSettings().council.enabled) {
    return { ok: false, content: 'The model council is turned off (Settings → Council).' };
  }
  if (def.mainOnly && ctx.agent !== 'main') {
    return { ok: false, content: `Tool "${name}" is not available to workers.` };
  }
  let args: Record<string, unknown>;
  try {
    args = parseArgs(call);
  } catch (e) {
    return { ok: false, content: (e as Error).message };
  }
  try {
    return await def.run(args, ctx);
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') return { ok: false, content: 'Cancelled by user.' };
    if (err instanceof PermissionError) return { ok: false, content: `Permission denied: ${err.message}` };
    return { ok: false, content: `${name} failed: ${err.message}` };
  }
}
