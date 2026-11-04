// U5: the slash-command palette. Some commands act directly (no model message: /compact, /export, /undo, …),
// the rest are inserted and sent as a normal message (/plan, and the council's /ask, /build, …).
// Pattern from DeepSeek Harness packages/interaction/commands (commands that run against the agent directly).
import type { Session } from '@localdex/shared';
import { newSession, send } from './store';

export type SlashMode = 'solo' | 'council' | 'both';

export interface SlashCommand {
  name: string;
  /** Argument hint shown after the name. */
  args?: string;
  description: string;
  mode: SlashMode;
  /** Runs here instead of being sent. Return an error string to show, or nothing. */
  run?: (ctx: SlashContext, arg: string) => string | void;
}

export interface SlashContext {
  session: Session;
  /** Ask the browser to download a URL. */
  download: (url: string) => void;
}

const lastUndoableTurn = (s: Session) => [...(s.turns ?? [])].reverse().find((t) => !t.undone && t.files.length > 0);

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'plan', args: '<task>', description: 'Explore read-only and write a plan; you approve before anything changes', mode: 'solo' },
  {
    name: 'goal',
    args: '<what done looks like>',
    description: 'Keep working until the goal is met (finish checkpoints, iteration cap)',
    mode: 'both',
    run: ({ session }, arg) => {
      if (!arg) return 'Usage: /goal <what done looks like>';
      send({ type: 'set_goal', sessionId: session.id, goal: { mode: 'goal', brief: arg, doneCriteria: '', maxIterations: 10 } });
    },
  },
  {
    name: 'loop',
    args: '<brief>',
    description: 'Keep working within a brief until you press Stop',
    mode: 'both',
    run: ({ session }, arg) => {
      if (!arg) return 'Usage: /loop <brief>';
      send({ type: 'set_goal', sessionId: session.id, goal: { mode: 'loop', brief: arg, doneCriteria: '', maxIterations: 50 } });
    },
  },
  { name: 'compact', description: 'Summarize the conversation and continue from the summary (Compact & Resume)', mode: 'both', run: ({ session }) => void send({ type: 'compact', sessionId: session.id }) },
  {
    name: 'undo',
    description: 'Undo the last Solo turn that changed files',
    mode: 'solo',
    run: ({ session }) => {
      const t = lastUndoableTurn(session);
      if (!t) return 'Nothing to undo: no recent turn changed files.';
      send({ type: 'undo_turn', sessionId: session.id, turnId: t.id });
    },
  },
  { name: 'export', args: '[md|json]', description: 'Download this session as Markdown (or JSON)', mode: 'both', run: ({ session, download }, arg) => download(`/api/sessions/${encodeURIComponent(session.id)}/export?format=${arg === 'json' ? 'json' : 'md'}`) },
  { name: 'new', description: 'Start a new session', mode: 'both', run: () => void newSession() },
  {
    name: 'fork',
    description: 'Copy this whole conversation into a new session and continue there',
    mode: 'both',
    run: ({ session }) => {
      if (!session.messages.length) return 'Nothing to fork yet.';
      send({ type: 'fork_session', sessionId: session.id, messageIndex: session.messages.length - 1 });
    },
  },
  { name: 'council', description: 'Switch this session to Council mode (cloud members)', mode: 'solo', run: ({ session }) => void send({ type: 'set_mode', sessionId: session.id, mode: 'council' }) },
  { name: 'solo', description: 'Switch this session back to Solo mode (local model leads)', mode: 'council', run: ({ session }) => void send({ type: 'set_mode', sessionId: session.id, mode: 'solo' }) },
  // Council commands: sent as the message; the server routes them.
  { name: 'ask', args: '[claude|codex|gemini|cursor] <question>', description: 'Ask one member (or let the router pick)', mode: 'council' },
  { name: 'build', args: '<change>', description: 'Plan → build → review', mode: 'council' },
  { name: 'second', args: '<change>', description: 'Build, then get a second opinion', mode: 'council' },
  { name: 'review', args: '<what>', description: 'Send it to the reviewer only', mode: 'council' },
  { name: 'vote', args: '<question>', description: 'Independent answers, blind peer ranking, then a judge', mode: 'council' },
  { name: 'frontend', args: '<change>', description: 'UI change to the frontend builder', mode: 'council' },
  { name: 'backend', args: '<change>', description: 'API/database change to the backend builder', mode: 'council' },
  { name: 'vision', args: '<image file> <question>', description: 'A vision-capable member looks at a screenshot or mockup', mode: 'council' },
  { name: 'arena', args: '[member member] <task>', description: 'Two builders race in separate copies; keep one', mode: 'council' },
  { name: 'plan', args: '<task>', description: 'The council planner designs it (no edits)', mode: 'council' },
];

export function commandsFor(council: boolean): SlashCommand[] {
  return SLASH_COMMANDS.filter((c) => c.mode === 'both' || c.mode === (council ? 'council' : 'solo'));
}

/** Commands whose name starts with what is typed after "/" (only while the name is being typed). */
export function matchCommands(text: string, council: boolean): SlashCommand[] {
  const m = text.match(/^\/(\w*)$/);
  if (!m) return [];
  const q = m[1].toLowerCase();
  return commandsFor(council).filter((c) => c.name.startsWith(q));
}

/** If `text` is a direct command, run it and return true (with an optional error message). */
export function runIfDirect(text: string, council: boolean, ctx: SlashContext): { handled: boolean; error?: string } {
  const m = text.trim().match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
  if (!m) return { handled: false };
  const cmd = commandsFor(council).find((c) => c.name === m[1].toLowerCase() && c.run);
  if (!cmd?.run) return { handled: false };
  const err = cmd.run(ctx, (m[2] ?? '').trim());
  return { handled: true, ...(err ? { error: err } : {}) };
}
