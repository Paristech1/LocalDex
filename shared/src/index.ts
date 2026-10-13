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
      /** Set when the text came from cloud council members rather than the local model, e.g. "claude → codex → gemini". */
      via?: string;
    }
  | { role: 'tool'; tool_call_id: string; name?: string; content: string; ok?: boolean; ts?: number };

// ---------- Skills ----------

export interface SkillInfo {
  /** Folder name under ~/.localdex/skills; also the name the model passes to load_skill. */
  name: string;
  description: string;
  enabled: boolean;
  /** Where it came from: 'upload', or the GitHub URL it was imported from. */
  source: string;
  /** Extra files shipped with the skill (relative paths, capped). */
  files: string[];
  /** True when the skill bundles executable scripts (.py/.sh/.js/...). Shown as a badge in the UI. */
  hasScripts: boolean;
  bytes: number;
  installedAt: number;
}

export interface SkillImportResult {
  ok: boolean;
  added: string[];
  updated: string[];
  skipped: { name: string; reason: string }[];
  error?: string;
}

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
  | 'update_plan'
  | 'load_skill'
  | 'ask_member'
  | 'council';

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
  'load_skill',
  'ask_member',
  'council',
];

export interface ToolSchema {
  type: 'function';
  function: {
    /** Built-in tools use a ToolName; MCP tools are named at runtime (mcp_<server>_<tool>). */
    name: string;
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
  /** 'solo' = the local model leads (default). 'council' = each message is routed to cloud council members. */
  mode?: SessionMode;
  /** Council runs in this session, oldest first (capped). */
  councilRuns?: CouncilRun[];
}

export type SessionMode = 'solo' | 'council';

// ---------- Model council ----------

/** Cloud members. Each runs through the vendor's own CLI/SDK on your subscription login. */
export type MemberId = 'claude' | 'codex' | 'gemini' | 'cursor';
export const MEMBER_IDS: MemberId[] = ['claude', 'codex', 'gemini', 'cursor'];
/** 'local' is LocalDex's own LM Studio model (runs as a worker with LocalDex's permissions). */
export type CouncilMemberRef = MemberId | 'local';

export type CouncilRole = 'planner' | 'builder' | 'reviewer' | 'researcher' | 'quick';
export const COUNCIL_ROLES: CouncilRole[] = ['planner', 'builder', 'reviewer', 'researcher', 'quick'];

export type CouncilPattern = 'single' | 'plan_build_review' | 'second_opinion' | 'vote';
export type CouncilAccess = 'read' | 'write';

export interface CouncilMemberSettings {
  enabled: boolean;
  /** Executable to run. Empty = find it on PATH and the usual install folders. (Not used for cursor, which is an SDK.) */
  command?: string;
  /** Model passed to the member. Empty = the member's own default. */
  model?: string;
  /** Stronger model used for 'heavy' work (planner/reviewer). Empty = same as model. */
  heavyModel?: string;
}

export interface CouncilSettings {
  /** Master switch. Off = no council tools, no Council mode. */
  enabled: boolean;
  members: Record<MemberId, CouncilMemberSettings>;
  /** For each role, members to try in order. The first one that is enabled, signed in and not rate-limited wins. */
  roles: Record<CouncilRole, CouncilMemberRef[]>;
  /** 'rules' = keyword routing (instant, free). 'local' = ask the local model to classify, falling back to rules. */
  routing: 'rules' | 'local';
  /** Pattern for plain messages in Council mode. 'auto' lets the router pick. */
  defaultPattern: CouncilPattern | 'auto';
  /** Members asked in parallel for 'vote'. */
  voteMembers: MemberId[];
  /** Who combines vote answers. */
  judge: CouncilMemberRef;
  /** Allow the builder role to edit files in the approved folders. Off (default) = every member is read-only. */
  allowWrite: boolean;
  /** Ask the user (approval prompt) before each member run that can edit files. Default on. */
  confirmWrites: boolean;
  /** Review → fix rounds in plan_build_review before giving up. */
  maxFixRounds: number;
  /** Per member-run timeout. */
  timeoutMinutes: number;
  /** Subscription-only guard: refuse to run a member that is signed in with an API key. */
  requirePlanBilling: boolean;
  /**
   * Let members load agent config from the project folder (Claude project/local settings and .mcp.json,
   * Cursor project settings) and run Gemini with --skip-trust. Off (default) = only the user's own config,
   * so a cloned repo cannot add hooks, MCP servers or instructions to a member run.
   */
  trustProjectConfig: boolean;
  /** Replace API keys, tokens, passwords and private keys with [REDACTED:<kind>] before anything goes to a cloud member. Default on. */
  redactSecrets: boolean;
  /** Solo mode: suggest asking a council member when the local model is stuck (repeated failures). Default on. */
  consultNudges: boolean;
}

export type MemberBilling = 'plan' | 'api' | 'unknown';

export interface MemberStatus {
  id: MemberId;
  label: string;
  installed: boolean;
  version?: string;
  /** Resolved executable path (CLIs) or package (SDK). */
  path?: string;
  signedIn: boolean;
  billing: MemberBilling;
  account?: string;
  /** Command to run in Terminal to sign in. */
  loginCommand: string;
  /** True when LocalDex can open the vendor's sign-in page itself (Cursor SDK). */
  canLoginInApp: boolean;
  /** Set while the member is cooling down after a usage-limit error (epoch ms). */
  limitedUntil?: number;
  lastError?: string;
  checkedAt: number;
}

export type CouncilStepStatus = 'queued' | 'running' | 'done' | 'error' | 'limited' | 'skipped' | 'cancelled';

export interface CouncilTranscriptItem {
  kind: 'text' | 'tool' | 'thinking' | 'note';
  text?: string;
  id?: string;
  name?: string;
  args?: unknown;
  ok?: boolean;
  result?: string;
}

export interface CouncilStep {
  id: string;
  role: CouncilRole | 'judge' | 'voter';
  member: CouncilMemberRef;
  model?: string;
  access: CouncilAccess;
  status: CouncilStepStatus;
  startedAt?: number;
  endedAt?: number;
  /** Final answer/report from the member (capped). */
  output?: string;
  error?: string;
  billing?: MemberBilling;
  usage?: { inputTokens: number; outputTokens: number };
  transcript: CouncilTranscriptItem[];
  /** Why this member was picked (router note or fallback reason). */
  note?: string;
  /** Secrets removed from the prompt before it was sent to this member. */
  redactions?: number;
}

export interface CouncilRun {
  id: string;
  pattern: CouncilPattern;
  task: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  startedAt: number;
  endedAt?: number;
  /** How the router decided, shown in the panel. */
  routeNote?: string;
  steps: CouncilStep[];
  /** Combined result returned to the user / lead agent. */
  result?: string;
}

/** Counters for one member (overall, or in one role). `runs` counts started steps; declined edits are `skipped` and not runs. */
export interface CouncilStepCounts {
  runs: number;
  done: number;
  errors: number;
  limited: number;
  cancelled: number;
  skipped: number;
  /** Sum of step wall time (includes any wait for edit approval). */
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CouncilMemberStats extends CouncilStepCounts {
  byRole: Partial<Record<CouncilStep['role'], CouncilStepCounts>>;
  /** Plan → build → review outcomes for builds this member made. */
  builder: { approvedFirst: number; approvedAfterFixes: number; changesRequested: number };
  /** Verdicts this member gave as a reviewer ('none' = no VERDICT line). */
  reviewer: { approve: number; changes: number; none: number };
  /** Vote participation: answers given and their total length in characters. */
  voter: { answers: number; answerChars: number };
  /** Blind peer ranking (filled by a later feature): sum of ranks and of field sizes; average rank = rankSum / count. */
  peerRanking: { count: number; rankSum: number; ofSum: number };
}

export interface CouncilStats {
  /** When counting started (first record after a reset). */
  since: number;
  updatedAt: number;
  members: Partial<Record<CouncilMemberRef, CouncilMemberStats>>;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

// ---------- MCP (Model Context Protocol) servers ----------

/** 'always' asks before every call, 'once' asks on the first call to a server, 'never' never asks. */
export type McpApprovalMode = 'always' | 'once' | 'never';

export interface McpServerConfig {
  /** Executable that starts the server over stdio, e.g. "npx". */
  command: string;
  args?: string[];
  /** Extra environment variables (merged over a minimal safe default environment). */
  env?: Record<string, string>;
  /**
   * Names of environment variables to copy from LocalDex's own environment into the server process.
   * Servers start with a minimal environment (PATH, HOME, ...) so your secrets are not leaked to them;
   * list things like HTTPS_PROXY or NODE_EXTRA_CA_CERTS here if you need them.
   */
  inheritEnv?: string[];
  /** Working directory for the server process. Default: ~/.localdex/mcp/<name>. */
  cwd?: string;
  enabled: boolean;
  /** Expose only these tools (the server's own tool names). Omit or leave empty to expose all. Keep it short for small models. */
  allowTools?: string[];
  /** Never expose these tools. Applied after allowTools. */
  denyTools?: string[];
  /** Default 'once'. */
  approval?: McpApprovalMode;
  /** Per-call timeout. Default 60. */
  timeoutSeconds?: number;
  /** Cap on characters of tool output sent back to the model. Default 12000. */
  maxOutputChars?: number;
  /** Let worker agents use this server's tools. Default false (main agent only). */
  allowWorkers?: boolean;
  /** One or two sentences added to the system prompt telling the model how to use this server. */
  hint?: string;
}

export type McpServerState = 'disabled' | 'connecting' | 'ready' | 'error';

export interface McpServerStatus {
  name: string;
  state: McpServerState;
  /** Tools the model can see (after allow/deny filtering), as the server names them. */
  exposedTools: string[];
  /** Every tool the server reported. */
  availableTools: string[];
  error?: string;
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
  /** MCP servers keyed by a short name. Edit ~/.localdex/config.json to add servers; the UI can only toggle them. */
  mcpServers: Record<string, McpServerConfig>;
  /** Names of installed skills the user has switched off (they stay on disk but are hidden from the model). */
  disabledSkills: string[];
  council: CouncilSettings;
}

export const DEFAULT_COUNCIL: CouncilSettings = {
  enabled: false,
  members: {
    claude: { enabled: true, model: 'sonnet', heavyModel: 'opus' },
    codex: { enabled: true },
    gemini: { enabled: true },
    cursor: { enabled: true, model: 'auto' },
  },
  roles: {
    planner: ['claude', 'gemini', 'codex'],
    builder: ['cursor', 'codex', 'claude'],
    reviewer: ['codex', 'gemini', 'claude'],
    researcher: ['gemini', 'claude', 'codex'],
    quick: ['local', 'gemini'],
  },
  routing: 'rules',
  defaultPattern: 'auto',
  voteMembers: ['claude', 'codex', 'gemini'],
  judge: 'claude',
  allowWrite: false,
  confirmWrites: true,
  maxFixRounds: 1,
  timeoutMinutes: 20,
  requirePlanBilling: true,
  trustProjectConfig: false,
  redactSecrets: true,
  consultNudges: true,
};

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
  load_skill: true,
  ask_member: true,
  council: true,
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
  disabledSkills: [],
  council: DEFAULT_COUNCIL,
  mcpServers: {
    playwright: {
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest', '--headless', '--isolated'],
      enabled: false,
      allowTools: [
        'browser_navigate',
        'browser_navigate_back',
        'browser_snapshot',
        'browser_click',
        'browser_type',
        'browser_fill_form',
        'browser_select_option',
        'browser_hover',
        'browser_tabs',
      ],
      approval: 'once',
      timeoutSeconds: 60,
      maxOutputChars: 12000,
      hint: 'Browser: open pages with browser_navigate, then read them with browser_snapshot (a text outline of the page; no screenshots). Click or type using the element refs from the latest snapshot, then snapshot again to confirm.',
    },
  },
};

export interface ModelInfo {
  id: string;
  loaded?: boolean;
  contextLength?: number;
}

// ---------- WebSocket protocol ----------

/** 'member:<stepId>' streams a council member's live output. */
export type AgentId = 'main' | `worker:${string}` | `member:${string}`;

export type ServerEvent =
  | { type: 'hello'; settings: Settings; sessions: SessionSummary[]; session: Session | null; models: ModelInfo[] }
  | { type: 'session'; session: Session }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'settings'; settings: Settings }
  | { type: 'models'; models: ModelInfo[]; error?: string }
  | { type: 'mcp_status'; servers: McpServerStatus[] }
  | { type: 'skills'; skills: SkillInfo[] }
  | { type: 'council_status'; members: MemberStatus[] }
  | { type: 'council_login'; member: MemberId; url?: string; done?: boolean; error?: string }
  | { type: 'council_stats'; stats: CouncilStats }
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
  | { type: 'set_mode'; sessionId: string; mode: SessionMode }
  | { type: 'council_refresh' }
  | { type: 'council_login'; member: MemberId }
  | { type: 'council_stats_reset' }
  | { type: 'reset_worker'; sessionId: string; name: string }
  | { type: 'delete_worker'; sessionId: string; name: string };
