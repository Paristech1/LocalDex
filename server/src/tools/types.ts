import type { AgentId, CouncilAccess, CouncilMemberRef, CouncilPattern, CouncilRole, PlanStep, ToolName, ToolSchema } from '@localdex/shared';

export interface CouncilRequest {
  pattern: CouncilPattern;
  role: CouncilRole;
  member?: CouncilMemberRef;
  task: string;
  access?: CouncilAccess;
}

export interface ToolContext {
  sessionId: string;
  agent: AgentId;
  signal: AbortSignal;
  /** The model that will read the result (sizes inline output to its context window). */
  model?: string | null;
  /** This tool call's id (names the file when the output is saved to disk). */
  callId?: string;
  /** Plan mode: shell_run refuses anything that is not a read-only command. */
  planMode?: boolean;
  /**
   * Ask the user to approve something. Resolves true/false. kind 'shell' = a risky shell command the agent wants to
   * run (the only kind auto-review may approve); anything else always goes to the user.
   */
  requestApproval(command: string, cwd: string, kind?: 'shell' | 'other'): Promise<boolean>;
  /** Ask the user a free-form question. */
  askUser(question: string): Promise<string>;
  /** Delegate work to a named worker. Only available to the main agent. */
  delegate?(name: string, task: string): Promise<string>;
  /** Replace the session's task plan. */
  updatePlan?(steps: PlanStep[]): void;
  /** Run a model-council request. Only available to the main agent when the council is on. Resolves to a report. */
  council?(req: CouncilRequest): Promise<string>;
  /** The active goal, for get_goal / update_goal / complete_goal / block_goal. Only the main agent, only while a goal runs. */
  goal?: GoalControl;
  /** True when the user sent a message during this run: long waits (job_output) end early so the model sees it. */
  hasCorrections?: () => boolean;
}

/** What the goal tools can see and do; the runner owns the state and the revision counter. */
export interface GoalControl {
  view(): string;
  update(revision: number, patch: { remaining?: string[]; note?: string }): ToolResult;
  complete(revision: number, summary: string): ToolResult;
  block(revision: number, reason: string): ToolResult;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  /** A7: images (attachment ids) to show the model right after this call (read_image). */
  images?: string[];
}

export interface ToolDef {
  schema: ToolSchema;
  /** Tools that only the main (non-worker) agent may call. */
  mainOnly?: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export type ToolRegistry = Record<ToolName, ToolDef>;

export function ok(content: string): ToolResult {
  return { ok: true, content };
}
export function fail(content: string): ToolResult {
  return { ok: false, content };
}

export function str(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new Error(`"${name}" must be a string`);
  return v;
}
export function optStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
export function optNum(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}
export function optBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/**
 * Safety cap on what a tool hands back at all. Output over the model's inline budget is then saved to a file and
 * shown as head + tail + path by the agent loop (see spill.ts), so this only guards memory, not the context window.
 */
export const MAX_OUTPUT = 1_000_000;
export function truncate(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.7));
  const tail = s.slice(-Math.floor(max * 0.25));
  return `${head}\n\n... [truncated ${s.length - max} chars] ...\n\n${tail}`;
}

/** What the model is told after the user presses Deny. Small models retry a bare "declined", so be explicit. */
export const DECLINED_COMMAND =
  'The user declined to run this command, so it did not run. Do not run it again: LocalDex will refuse the same command for the rest of this request. Continue without it, use a different approach the user is likely to accept, or explain to the user why it is needed and ask.';
