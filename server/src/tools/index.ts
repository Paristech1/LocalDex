import type { ToolCall, ToolName, ToolSchema } from '@localdex/shared';
import { getSettings } from '../config.js';
import { edit_file, glob, list_dir, read_file, write_file } from './fs.js';
import { grep } from './search.js';
import { shell_run } from './shell.js';
import { terminal_close, terminal_open, terminal_read, terminal_send } from './terminal.js';
import { ask_user, delegate_to_worker, update_plan } from './agentTools.js';
import { load_skill } from './skillTool.js';
import { ask_member, council } from './councilTools.js';
import { enabledSkills } from '../skills/store.js';
import { PermissionError } from './permissions.js';
import { isMcpTool, mcpToolSchemas, runMcpTool } from '../mcp/client.js';
import type { ToolContext, ToolDef, ToolRegistry, ToolResult } from './types.js';

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
};

const COUNCIL_TOOLS = new Set<ToolName>(['ask_member', 'council']);

/** Tool schemas enabled for a given agent kind, honouring the user's capability toggles. */
export function enabledTools(kind: 'main' | 'worker'): ToolSchema[] {
  const caps = getSettings().capabilities;
  const councilOn = getSettings().council.enabled;
  const builtin = (Object.keys(registry) as ToolName[])
    .filter((name) => caps[name] !== false)
    .filter((name) => kind === 'main' || !registry[name].mainOnly)
    // No point showing a small model a tool it can't use.
    .filter((name) => name !== 'load_skill' || enabledSkills().length > 0)
    .filter((name) => councilOn || !COUNCIL_TOOLS.has(name))
    .map((name) => registry[name].schema);
  return [...builtin, ...mcpToolSchemas(kind)];
}

export function parseArgs(call: ToolCall): Record<string, unknown> {
  const raw = call.function.arguments?.trim() || '{}';
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    // Common local-model failure: trailing garbage or unescaped newlines. Try a light repair.
    try {
      const v = JSON.parse(raw.replace(/,\s*([}\]])/g, '$1').replace(/\n/g, '\\n'));
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } catch {
      throw new Error(`Tool arguments were not valid JSON: ${raw.slice(0, 200)}`);
    }
  }
}

export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
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
