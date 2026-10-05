// Shared types between the LocalDex server and web UI.

// ---------- Chat messages (OpenAI-compatible wire format) ----------

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; ts?: number }
  | {
      role: 'assistant';
      content: string | null;
      reasoning?: string;
      tool_calls?: ToolCall[];
      ts?: number;
    }
  | { role: 'tool'; tool_call_id: string; name?: string; content: string; ok?: boolean; ts?: number };

// ---------- Tools ----------

export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'list_dir'
  | 'glob'
  | 'grep'
  | 'shell_run'
  | 'terminal_open'
  | 'terminal_send'
  | 'terminal_read'
  | 'terminal_close'
  | 'ask_user'
  | 'delegate_to_worker'
  | 'update_plan';

export const ALL_TOOL_NAMES: ToolName[] = [
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'glob',
  'grep',
  'shell_run',
  'terminal_open',
  'terminal_send',
  'terminal_read',
  'terminal_close',
  'ask_user',
  'delegate_to_worker',
  'update_plan',
];

export interface ToolSchema {
  type: 'function';
  function: {
    name: ToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ---------- Session ----------

export type PlanStatus = 'pending' | 'in_progress' | 'done' | 'skipped';
export interface PlanStep {
  id: string;
  title: string;
  status: PlanStatus;
}

export type GoalMode = 'goal' | 'loop';
export interface GoalState {
  mode: GoalMode;
  brief: string;
  doneCriteria: string;
  maxIterations: number;
  iteration: number;
  active: boolean;
  remaining: string[];
  lastAssessment?: string;
}

export type AgentStatus = 'idle' | 'thinking' | 'tool' | 'waiting' | 'error' | 'queued' | 'running';

export interface WorkerState {
  name: string;
  model: string | null;
  messages: ChatMessage[];
  archive: ChatMessage[][];
  status: AgentStatus;
  lastTask: string | null;
  lastResult: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  lastPromptTokens: number;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string | null;
  messages: ChatMessage[];
  archive: ChatMessage[][];
  workers: Record<string, WorkerState>;
  plan: PlanStep[];
  goal: GoalState | null;
  usage: TokenUsage;
  compactions: number;
  compactSummary: string | null;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

// ---------- Settings ----------

export type ShellApprovalMode = 'always' | 'dangerous' | 'never';

/**
 * How tool calls are exchanged with the model.
 * native: OpenAI `tools` / `tool_calls` (needs a chat template with tool support)
 * text:   tools are described in the system prompt and the model writes <tool_call>JSON</tool_call>
 * auto:   probe the model once and pick
 */
export type ToolMode = 'auto' | 'native' | 'text';

export interface Settings {
  baseUrl: string;
  model: string | null;
  workerModel: string | null;
  toolMode: ToolMode;
  temperature: number;
  maxSteps: number;
  contextLength: number; // 0 = unknown/auto
  autoCompactThreshold: number; // fraction of contextLength (0 disables)
  approvedFolders: string[];
  capabilities: Record<ToolName, boolean>;
  shellApproval: ShellApprovalMode;
  workerConcurrency: number;
  systemPrompt: string;
}

export const DEFAULT_CAPABILITIES: Record<ToolName, boolean> = {
  read_file: true,
  write_file: true,
  edit_file: true,
  list_dir: true,
  glob: true,
  grep: true,
  shell_run: true,
  terminal_open: true,
  terminal_send: true,
  terminal_read: true,
  terminal_close: true,
  ask_user: true,
  delegate_to_worker: true,
  update_plan: true,
};

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'http://localhost:1234/v1',
  model: null,
  workerModel: null,
  toolMode: 'auto',
  temperature: 0.2,
  maxSteps: 40,
  contextLength: 0,
  autoCompactThreshold: 0.8,
  approvedFolders: [],
  capabilities: DEFAULT_CAPABILITIES,
  shellApproval: 'dangerous',
  workerConcurrency: 2,
  systemPrompt: '',
};

export interface ModelInfo {
  id: string;
  loaded?: boolean;
  contextLength?: number;
}

// ---------- WebSocket protocol ----------

export type AgentId = 'main' | `worker:${string}`;

export type ServerEvent =
  | { type: 'hello'; settings: Settings; sessions: SessionSummary[]; session: Session | null; models: ModelInfo[] }
  | { type: 'session'; session: Session }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'settings'; settings: Settings }
  | { type: 'models'; models: ModelInfo[]; error?: string }
  | { type: 'agent_status'; sessionId: string; agent: AgentId; status: AgentStatus; detail?: string }
  | { type: 'assistant_delta'; sessionId: string; agent: AgentId; delta: string }
  | { type: 'reasoning_delta'; sessionId: string; agent: AgentId; delta: string }
  | { type: 'turn_start'; sessionId: string; agent: AgentId }
  | { type: 'turn_end'; sessionId: string; agent: AgentId }
  | { type: 'tool_start'; sessionId: string; agent: AgentId; callId: string; name: string; args: unknown }
  | { type: 'tool_end'; sessionId: string; agent: AgentId; callId: string; name: string; ok: boolean; result: string }
  | { type: 'approval_request'; sessionId: string; agent: AgentId; id: string; command: string; cwd: string }
  | { type: 'ask_user'; sessionId: string; agent: AgentId; id: string; question: string }
  | { type: 'prompt_resolved'; id: string }
  | { type: 'error'; sessionId?: string; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export type ClientEvent =
  | { type: 'send_message'; sessionId: string; content: string }
  | { type: 'new_session' }
  | { type: 'load_session'; id: string }
  | { type: 'delete_session'; id: string }
  | { type: 'rename_session'; id: string; title: string }
  | { type: 'stop'; sessionId: string }
  | { type: 'set_settings'; patch: Partial<Settings> }
  | { type: 'list_models' }
  | { type: 'set_model'; sessionId: string; model: string }
  | { type: 'approval_response'; id: string; approved: boolean }
  | { type: 'ask_user_response'; id: string; answer: string }
  | { type: 'set_goal'; sessionId: string; goal: { mode: GoalMode; brief: string; doneCriteria: string; maxIterations: number } }
  | { type: 'clear_goal'; sessionId: string }
  | { type: 'compact'; sessionId: string }
  | { type: 'reset_worker'; sessionId: string; name: string }
  | { type: 'delete_worker'; sessionId: string; name: string };
