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
  /** Ask the user to approve a shell command. Resolves true/false. */
  requestApproval(command: string, cwd: string): Promise<boolean>;
  /** Ask the user a free-form question. */
  askUser(question: string): Promise<string>;
  /** Delegate work to a named worker. Only available to the main agent. */
  delegate?(name: string, task: string): Promise<string>;
  /** Replace the session's task plan. */
  updatePlan?(steps: PlanStep[]): void;
  /** Run a model-council request. Only available to the main agent when the council is on. Resolves to a report. */
  council?(req: CouncilRequest): Promise<string>;
}

export interface ToolResult {
  ok: boolean;
  content: string;
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

export const MAX_OUTPUT = 30_000;
export function truncate(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.7));
  const tail = s.slice(-Math.floor(max * 0.25));
  return `${head}\n\n... [truncated ${s.length - max} chars] ...\n\n${tail}`;
}
