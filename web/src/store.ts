import { useSyncExternalStore } from 'react';
import type {
  AgentId,
  AgentStatus,
  ClientEvent,
  McpServerStatus,
  MemberId,
  MemberStatus,
  ModelInfo,
  ServerEvent,
  SkillInfo,
  Session,
  SessionSummary,
  Settings,
} from '@localdex/shared';

export interface LiveTool {
  callId: string;
  name: string;
  args: unknown;
  result?: string;
  ok?: boolean;
  startedAt: number;
}

export interface LiveAgent {
  content: string;
  reasoning: string;
  /** Streamed turn finished; clear on next session sync. */
  done: boolean;
  tools: LiveTool[];
}

export type Prompt =
  | { kind: 'approval'; id: string; agent: AgentId; command: string; cwd: string }
  | { kind: 'ask'; id: string; agent: AgentId; question: string };

export interface LogEntry {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  ts: number;
}

export interface State {
  connected: boolean;
  settings: Settings | null;
  sessions: SessionSummary[];
  session: Session | null;
  models: ModelInfo[];
  modelsError: string | null;
  live: Record<string, LiveAgent>;
  status: Record<string, { status: AgentStatus; detail?: string }>;
  prompts: Prompt[];
  logs: LogEntry[];
  mcp: McpServerStatus[];
  skills: SkillInfo[];
  council: MemberStatus[];
  councilLogin: { member: MemberId; url?: string; done?: boolean; error?: string } | null;
  error: string | null;
}

let state: State = {
  connected: false,
  settings: null,
  sessions: [],
  session: null,
  models: [],
  modelsError: null,
  live: {},
  status: {},
  prompts: [],
  logs: [],
  mcp: [],
  skills: [],
  council: [],
  councilLogin: null,
  error: null,
};

const listeners = new Set<() => void>();
let logId = 0;

function set(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => selector(state),
    () => selector(state),
  );
}

export function getState(): State {
  return state;
}

// ---------- WebSocket ----------

let ws: WebSocket | null = null;
let retry = 0;

export function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 0;
    set({ connected: true, error: null });
  };
  ws.onclose = () => {
    set({ connected: false });
    const delay = Math.min(10_000, 500 * 2 ** retry++);
    setTimeout(connect, delay);
  };
  ws.onmessage = (e) => {
    try {
      handle(JSON.parse(e.data) as ServerEvent);
    } catch (err) {
      console.error(err);
    }
  };
}

export function send(ev: ClientEvent): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
  else set({ error: 'Not connected to the LocalDex server.' });
}

/** Session id we asked the server to switch to ('*' = whatever new session it creates). */
let wantedSession: string | null = null;

export function loadSession(id: string): void {
  wantedSession = id;
  send({ type: 'load_session', id });
}

export function newSession(): void {
  wantedSession = '*';
  send({ type: 'new_session' });
}

function liveFor(live: Record<string, LiveAgent>, agent: string): LiveAgent {
  return live[agent] ?? { content: '', reasoning: '', done: false, tools: [] };
}

function handle(ev: ServerEvent): void {
  switch (ev.type) {
    case 'hello':
      set({ settings: ev.settings, sessions: ev.sessions, session: ev.session, models: ev.models, live: {}, status: {}, prompts: [] });
      if (!ev.session) newSession();
      return;
    case 'session': {
      set((s) => {
        const sessions = s.sessions.some((x) => x.id === ev.session.id)
          ? s.sessions.map((x) =>
              x.id === ev.session.id
                ? { ...x, title: ev.session.title, updatedAt: ev.session.updatedAt, messageCount: ev.session.messages.length }
                : x,
            )
          : [{ id: ev.session.id, title: ev.session.title, updatedAt: ev.session.updatedAt, messageCount: ev.session.messages.length }, ...s.sessions];
        const switching = !!s.session && s.session.id !== ev.session.id;
        if (switching && wantedSession !== '*' && wantedSession !== ev.session.id) {
          // Another session was updated in the background (a run we are not viewing): refresh the list only.
          return { sessions };
        }
        if (wantedSession === '*' || wantedSession === ev.session.id) wantedSession = null;
        if (switching) return { session: ev.session, sessions, live: {}, status: {}, prompts: [], error: null };
        // Finished turns are now in session.messages; keep only in-flight text and tool cards
        // (tool cards are deduped against the session at render time).
        const live: Record<string, LiveAgent> = {};
        for (const [k, v] of Object.entries(s.live)) {
          live[k] = v.done ? { ...v, content: '', reasoning: '' } : v;
        }
        return { session: ev.session, live, sessions, error: null };
      });
      return;
    }
    case 'sessions':
      set({ sessions: ev.sessions });
      return;
    case 'settings':
      set({ settings: ev.settings });
      return;
    case 'models':
      set({ models: ev.models, modelsError: ev.error ?? null });
      return;
    case 'mcp_status':
      set({ mcp: ev.servers });
      return;
    case 'skills':
      set({ skills: ev.skills });
      return;
    case 'council_status':
      set({ council: ev.members });
      return;
    case 'council_login':
      set({ councilLogin: { member: ev.member, url: ev.url, done: ev.done, error: ev.error } });
      return;
    case 'agent_status':
      if (ev.sessionId !== state.session?.id) return;
      set((s) => {
        const patch: Partial<State> = { status: { ...s.status, [ev.agent]: { status: ev.status, detail: ev.detail } } };
        if (ev.status === 'idle' || ev.status === 'error') {
          // Run finished: drop the agent's live buffer entirely.
          const live = { ...s.live };
          delete live[ev.agent];
          patch.live = live;
        }
        return patch;
      });
      return;
    case 'turn_start':
      if (ev.sessionId !== state.session?.id) return;
      set((s) => ({ live: { ...s.live, [ev.agent]: { content: '', reasoning: '', done: false, tools: liveFor(s.live, ev.agent).tools.filter((t) => t.result === undefined) } } }));
      return;
    case 'assistant_delta':
      if (ev.sessionId !== state.session?.id) return;
      set((s) => {
        const cur = liveFor(s.live, ev.agent);
        return { live: { ...s.live, [ev.agent]: { ...cur, content: cur.content + ev.delta, done: false } } };
      });
      return;
    case 'reasoning_delta':
      if (ev.sessionId !== state.session?.id) return;
      set((s) => {
        const cur = liveFor(s.live, ev.agent);
        return { live: { ...s.live, [ev.agent]: { ...cur, reasoning: cur.reasoning + ev.delta, done: false } } };
      });
      return;
    case 'turn_end':
      if (ev.sessionId !== state.session?.id) return;
      set((s) => ({ live: { ...s.live, [ev.agent]: { ...liveFor(s.live, ev.agent), done: true } } }));
      return;
    case 'tool_start':
      if (ev.sessionId !== state.session?.id) return;
      set((s) => {
        const cur = liveFor(s.live, ev.agent);
        return {
          live: {
            ...s.live,
            [ev.agent]: { ...cur, tools: [...cur.tools, { callId: ev.callId, name: ev.name, args: ev.args, startedAt: Date.now() }] },
          },
        };
      });
      return;
    case 'tool_end':
      if (ev.sessionId !== state.session?.id) return;
      set((s) => {
        const cur = liveFor(s.live, ev.agent);
        return {
          live: {
            ...s.live,
            [ev.agent]: { ...cur, tools: cur.tools.map((t) => (t.callId === ev.callId ? { ...t, result: ev.result, ok: ev.ok } : t)) },
          },
        };
      });
      return;
    case 'approval_request':
      set((s) => ({ prompts: [...s.prompts, { kind: 'approval', id: ev.id, agent: ev.agent, command: ev.command, cwd: ev.cwd }] }));
      return;
    case 'ask_user':
      set((s) => ({ prompts: [...s.prompts, { kind: 'ask', id: ev.id, agent: ev.agent, question: ev.question }] }));
      return;
    case 'prompt_resolved':
      set((s) => ({ prompts: s.prompts.filter((p) => p.id !== ev.id) }));
      return;
    case 'error':
      set((s) => ({
        error: ev.message,
        logs: [...s.logs.slice(-199), { id: ++logId, level: 'error', message: ev.message, ts: Date.now() }],
      }));
      return;
    case 'log':
      set((s) => ({ logs: [...s.logs.slice(-199), { id: ++logId, level: ev.level, message: ev.message, ts: Date.now() }] }));
      return;
  }
}

export function dismissError(): void {
  set({ error: null });
}

export function clearLiveTools(agent: string): void {
  set((s) => {
    const cur = s.live[agent];
    if (!cur) return {};
    return { live: { ...s.live, [agent]: { ...cur, tools: cur.tools.filter((t) => t.result === undefined) } } };
  });
}
