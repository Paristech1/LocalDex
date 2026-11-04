// S5 (experimental): run the user's existing Claude Code hooks during LocalDex runs.
// Sources: ~/.localdex/hooks.json or the user's ~/.claude/settings.json (never project files: a cloned repo must not
// be able to run commands). Events: PreToolUse (can block a tool call), PostToolUse (can add feedback), UserPromptSubmit
// (can block a message or add context), Stop (can ask for one more turn). A hook can never approve anything that
// would otherwise ask; a crashing or slow hook is skipped and logged, never blocks the run.
// Pattern from DeepSeek Harness experimental/hooks-claude-code + hook-protocol, reimplemented.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, getSettings } from './config.js';
import { approvedFolders } from './tools/permissions.js';
import { bus } from './agent/bus.js';

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop';

interface HookCommand {
  type?: string;
  command: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}
type HookConfig = Partial<Record<HookEvent, HookGroup[]>>;

/** LocalDex tool names as Claude Code knows them, so existing matchers like "Bash" or "Edit|Write" work. */
const CC_NAME: Record<string, string> = { shell_run: 'Bash', read_file: 'Read', write_file: 'Write', edit_file: 'Edit', glob: 'Glob', grep: 'Grep', list_dir: 'LS', web_fetch: 'WebFetch', web_search: 'WebSearch', update_plan: 'TodoWrite' };

export function ccToolName(name: string): string {
  return CC_NAME[name] ?? name;
}

/** Tool arguments in Claude Code's field names (file_path instead of path). */
export function ccToolInput(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if ('path' in out && ['read_file', 'write_file', 'edit_file'].includes(name)) {
    out.file_path = out.path;
    delete out.path;
  }
  return out;
}

export function hooksFile(): string | null {
  const src = getSettings().hooksSource ?? 'off';
  if (src === 'localdex') return path.join(DATA_DIR, 'hooks.json');
  if (src === 'claude-code') return path.join(os.homedir(), '.claude', 'settings.json');
  return null;
}

let cache: { file: string; mtime: number; cfg: HookConfig } | null = null;

export function loadHooks(): HookConfig {
  const file = hooksFile();
  if (!file) return {};
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (cache && cache.file === file && cache.mtime === mtime) return cache.cfg;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks?: HookConfig };
    const cfg: HookConfig = {};
    for (const ev of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'] as HookEvent[]) {
      const groups = raw.hooks?.[ev];
      if (Array.isArray(groups)) cfg[ev] = groups.filter((g) => g && Array.isArray(g.hooks)).map((g) => ({ matcher: typeof g.matcher === 'string' ? g.matcher : undefined, hooks: g.hooks.filter((h) => typeof h?.command === 'string' && (h.type ?? 'command') === 'command') }));
    }
    cache = { file, mtime, cfg };
    return cfg;
  } catch {
    return {};
  }
}

function matches(matcher: string | undefined, tool: string): boolean {
  if (!matcher || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return matcher === tool;
  }
}

export interface HookOutcome {
  /** A hook asked to block (PreToolUse: don't run the tool; UserPromptSubmit: don't send; Stop: keep going). */
  block: boolean;
  reason?: string;
  /** Extra context for the model (PostToolUse feedback, UserPromptSubmit context). */
  context: string[];
}

function runOne(h: HookCommand, input: Record<string, unknown>, cwd: string): Promise<{ code: number | null; out: string; err: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const p = spawn(process.env.SHELL || '/bin/sh', ['-c', h.command], { cwd, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, LOCALDEX_HOOK: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, Math.min(Math.max(1, h.timeout ?? 60), 600) * 1000);
    p.stdout.on('data', (d) => (out = (out + d).slice(-20_000)));
    p.stderr.on('data', (d) => (err = (err + d).slice(-20_000)));
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: e.message, timedOut });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    });
    p.stdin.on('error', () => undefined);
    p.stdin.end(JSON.stringify(input));
  });
}

/** Run every hook for an event (and tool). Decisions: exit 2 or {"decision":"block"} / permissionDecision "deny" block; "allow" is ignored. */
export async function runHooks(event: HookEvent, input: Record<string, unknown>, tool?: string): Promise<HookOutcome> {
  const groups = (loadHooks()[event] ?? []).filter((g) => (event === 'PreToolUse' || event === 'PostToolUse' ? matches(g.matcher, tool ?? '') : true));
  const res: HookOutcome = { block: false, context: [] };
  if (!groups.length) return res;
  const cwd = approvedFolders()[0] ?? process.cwd();
  const payload = { session_id: input.session_id ?? 'localdex', cwd, hook_event_name: event, ...input };
  for (const g of groups) {
    for (const h of g.hooks) {
      const r = await runOne(h, payload, cwd);
      const label = h.command.slice(0, 80);
      if (r.timedOut || r.code === null || r.code === -1) {
        bus.log('warn', `[hook ${event}] skipped (${r.timedOut ? 'timed out' : r.err.split('\n')[0] || 'failed to start'}): ${label}`);
        continue;
      }
      if (r.code === 2) {
        res.block = true;
        res.reason = (r.err.trim() || 'blocked by a hook').slice(0, 2000);
        bus.log('info', `[hook ${event}] blocked: ${res.reason.split('\n')[0].slice(0, 160)}`);
        continue;
      }
      if (r.code !== 0) {
        bus.log('warn', `[hook ${event}] exited ${r.code} (ignored): ${label}${r.err ? ` — ${r.err.split('\n')[0].slice(0, 120)}` : ''}`);
        continue;
      }
      const text = r.out.trim();
      if (!text.startsWith('{')) {
        // Plain stdout: Claude Code adds it as context for UserPromptSubmit; elsewhere it is only shown in the log.
        if (text && event === 'UserPromptSubmit') res.context.push(text.slice(0, 4000));
        continue;
      }
      try {
        const j = JSON.parse(text) as { decision?: string; reason?: string; continue?: boolean; stopReason?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } };
        const deny = j.decision === 'block' || j.hookSpecificOutput?.permissionDecision === 'deny' || j.continue === false;
        if (deny) {
          res.block = true;
          res.reason = String(j.reason ?? j.hookSpecificOutput?.permissionDecisionReason ?? j.stopReason ?? 'blocked by a hook').slice(0, 2000);
          bus.log('info', `[hook ${event}] blocked: ${res.reason.split('\n')[0].slice(0, 160)}`);
        }
        if (j.hookSpecificOutput?.permissionDecision === 'allow') bus.log('info', `[hook ${event}] "allow" ignored: hooks can block, never approve`);
        if (j.hookSpecificOutput?.additionalContext) res.context.push(String(j.hookSpecificOutput.additionalContext).slice(0, 4000));
      } catch {
        bus.log('warn', `[hook ${event}] unreadable JSON output (ignored): ${label}`);
      }
    }
  }
  return res;
}

export function hooksActive(): boolean {
  return (getSettings().hooksSource ?? 'off') !== 'off';
}
