import type { PlanStep, ToolName } from '@localdex/shared';

/**
 * Plan mode (A4). Pattern from DeepSeek Harness `plan/plan-mode`, reimplemented: `/plan <task>` explores and designs,
 * the finished plan goes to the user, who approves, revises or cancels. Unlike the Harness (guidance only) it is
 * enforced: the write tools are not offered and shell_run only runs read-only commands.
 */

/** Tools a planning agent keeps. Everything else (writes, terminals, workers, council builds, MCP) is hidden. */
export const PLAN_TOOLS = new Set<ToolName>(['read_file', 'list_dir', 'glob', 'grep', 'shell_run', 'update_plan', 'ask_user', 'load_skill', 'lsp', 'read_image']);

export function isPlanTool(name: string): boolean {
  return PLAN_TOOLS.has(name as ToolName);
}

export function parsePlanCommand(text: string): string | null {
  const m = text.trim().match(/^\/plan(?:\s+([\s\S]+))?$/i);
  if (!m) return null;
  return (m[1] ?? '').trim();
}

/** Programs that only read: file listing and searching, viewing, version checks. Each pipeline segment must start with one. */
const READ_ONLY_PROGRAMS = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'fd', 'fdfind', 'tree', 'file', 'stat', 'du', 'df',
  'pwd', 'echo', 'printf', 'which', 'whereis', 'type', 'command', 'env', 'printenv', 'uname', 'whoami', 'id', 'date', 'uptime', 'hostname',
  'sort', 'uniq', 'cut', 'tr', 'awk', 'jq', 'yq', 'diff', 'cmp', 'comm', 'column', 'nl', 'tac', 'rev', 'basename', 'dirname', 'realpath', 'readlink',
  'md5', 'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'strings', 'xxd', 'od', 'hexdump', 'true', 'false', 'test', '[', 'sleep', 'seq', 'expr', 'bc',
  'node', 'python', 'python3', 'ruby', 'go', 'cargo', 'rustc', 'java', 'javac', 'php', 'perl', 'swift', 'dotnet', 'deno', 'bun', 'tsc', 'npm', 'npx', 'pnpm', 'yarn', 'pip', 'pip3', 'git', 'sed',
]);
/** Interpreters and package managers are allowed only for version / listing flags, never to run code. */
const VERSION_ONLY = new Set(['node', 'python', 'python3', 'ruby', 'go', 'cargo', 'rustc', 'java', 'javac', 'php', 'perl', 'swift', 'dotnet', 'deno', 'bun', 'tsc']);
const PKG_READ_SUBCOMMANDS = new Set(['ls', 'list', 'view', 'info', 'show', 'outdated', 'why', 'explain', 'audit', 'help', 'config', '--version', '-v', 'version', 'root', 'prefix', 'bin']);
const GIT_READ_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show', 'blame', 'branch', 'tag', 'remote', 'ls-files', 'ls-tree', 'grep', 'rev-parse', 'describe', 'shortlog', 'cat-file', 'reflog', 'stash', 'config', 'rev-list', 'name-rev', 'merge-base', 'help', 'version', 'check-ignore', 'worktree', 'count-objects', 'for-each-ref', 'symbolic-ref']);
/** Read subcommands that have writing flags. */
const GIT_WRITE_FLAGS = /(^|\s)(-d|-D|-m|-M|--delete|--move|--copy|-c|--set-upstream|--unset|--add|--remove|--replace-all|--edit|-e|push|pop|drop|apply|clear|add|prune|remove|lock|unlock)(\s|$)/;

/**
 * True when every segment of the command is a known read-only program used read-only: no redirections, no `rm`,
 * `mv`, `cp`, `touch`, `mkdir`, installs or builds, no `sed -i`, no `find -delete/-exec`, no git subcommand that writes.
 * Conservative on purpose: anything not recognised is refused and the model is told to put it in the plan.
 */
export function isReadOnlyCommand(cmd: string): boolean {
  const c = cmd.trim();
  if (!c) return false;
  // Redirections write files (but `2>&1` and `2>/dev/null` only route output).
  const noSafeRedirects = c.replace(/\d?>\s*&\d/g, '').replace(/\d?>\s*\/dev\/null/g, '').replace(/<<<?\s*\S+/g, '');
  if (/[<>]/.test(noSafeRedirects)) return false;
  // Command substitution and process substitution can hide anything.
  if (/\$\(|`|<\(|>\(/.test(c)) return false;
  // Pipelines and lists: every stage must be read-only. Quotes are not parsed; a | inside quotes just makes the check stricter.
  const segments = c.split(/\|\||&&|;|\||&/).map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return false;
  return segments.every(segmentIsReadOnly);
}

function segmentIsReadOnly(seg: string): boolean {
  // Leading VAR=value assignments and `env`/`time` prefixes.
  const words = seg.split(/\s+/);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  while (words.length && (words[0] === 'time' || words[0] === 'command' || words[0] === 'env')) words.shift();
  if (!words.length) return false;
  const prog = words[0].replace(/^.*\//, '');
  if (!READ_ONLY_PROGRAMS.has(prog)) return false;
  const args = words.slice(1);
  switch (prog) {
    case 'sed':
      return !args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a));
    case 'find':
    case 'fd':
    case 'fdfind':
      return !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls|X|x)$/.test(a) || a === '--exec' || a === '-x' || a === '--exec-batch');
    case 'git': {
      const sub = args.find((a) => !a.startsWith('-'));
      if (!sub || !GIT_READ_SUBCOMMANDS.has(sub)) return false;
      if (['branch', 'tag', 'remote', 'stash', 'config', 'worktree', 'symbolic-ref'].includes(sub) && GIT_WRITE_FLAGS.test(args.join(' '))) return false;
      return true;
    }
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'pip':
    case 'pip3':
    case 'npx': {
      const sub = args.find((a) => !a.startsWith('-') || a === '--version' || a === '-v');
      return !!sub && PKG_READ_SUBCOMMANDS.has(sub) && !args.some((a) => /^(set|delete|edit)$/.test(a));
    }
    case 'awk':
      return !/\b(system|print\s*>|printf\s*>|>>)/.test(args.join(' '));
    case 'tee':
      return false;
    default:
      if (VERSION_ONLY.has(prog)) return args.length > 0 && args.every((a) => /^(-v|-V|--version|version|--help|-h|help)$/.test(a));
      return true;
  }
}

export const PLAN_SHELL_REFUSAL =
  'Plan mode: shell_run only runs read-only commands here (ls, cat, head, grep/rg, find, wc, git status/log/diff/show, npm ls …). This command could change something, so it was not run. Put it in the plan as a step instead.';

/** The `/plan` message the model actually sees. */
export function planModePrompt(task: string): string {
  return [
    `[Plan mode] Task: ${task}`,
    '',
    'You are in plan mode: investigate and design, change nothing. Only read-only tools are available (read_file, list_dir, glob, grep, and shell_run for read-only commands such as ls, cat, rg, git log/diff). Do not try to edit files or run builds; those come after approval.',
    '1. Explore the relevant files until you know what exists and what must change.',
    '2. Call update_plan with the concrete steps you would take, every step "pending": name the files and what changes in each, and the checks to run at the end.',
    '3. Then reply with a short summary for the user: what you found, the approach, risks and open questions. Stop there; the user will approve, revise or cancel the plan.',
  ].join('\n');
}

export function planRevisePrompt(feedback: string): string {
  return `[Plan feedback] ${feedback}\n\nStill plan mode (read-only). Revise: investigate what the feedback needs, call update_plan with the full updated list of steps (all "pending"), then reply with a short updated summary. Change nothing yet.`;
}

export function planApprovedPrompt(task: string, steps: PlanStep[]): string {
  const list = steps.length ? `\nPlan:\n${steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}` : '';
  return `[Plan approved] Carry out the plan now. Task: ${task}${list}\nAll tools are available again. Work through the steps in order, mark each one with update_plan as you go, verify at the end, then summarize what changed.`;
}

/** Nudge when the planning run ended without an update_plan call. */
export const PLAN_MISSING_NUDGE =
  '[system] Plan mode: you have not called update_plan yet. Call it now with the concrete steps you would take (all "pending"), then give the user your summary.';
