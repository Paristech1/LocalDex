import os from 'node:os';
import { projectInstructions } from './instructions.js';
import { getSettings } from '../config.js';
import { editStyleFor, enabledTools, type ToolSetOptions } from '../tools/index.js';
import { approvedFolders } from '../tools/permissions.js';
import { mcpPromptNotes } from '../mcp/client.js';
import { skillsPromptNotes } from '../skills/store.js';

function environment(): string {
  const folders = approvedFolders();
  return [
    `OS: ${process.platform} (${os.release()}), shell: ${process.env.SHELL ?? 'sh'}`,
    folders.length
      ? `Approved folders (you may only read/write inside these): ${folders.join(', ')}\nDefault working directory: ${folders[0]}`
      : 'No folders are approved yet. Ask the user to add one in Settings → Workspace before using file or shell tools.',
    ...presetNote(),
  ].join('\n');
}

/** Permission preset (S3). Changes the prompt only when the user switches presets. */
function presetNote(): string[] {
  const preset = getSettings().permissionPreset ?? 'full';
  if (preset === 'workspace') return ['Shell commands run in a sandbox: they may only write inside the approved folders, temp and tool caches. If a command is blocked, the user is asked once whether to allow it.'];
  if (preset === 'read-only') return ['Read only mode: you cannot change files. Shell commands run in a sandbox that blocks writes, and write_file/edit_file are off. Inspect, then tell the user what you would change.'];
  return [];
}

/**
 * The date and time go into an appended context line, never into the system prompt: a prompt whose prefix changes
 * every step throws LM Studio's KV cache away (pattern from DeepSeek Harness `time-context`, reimplemented).
 */
export const CLOCK_EVERY_MS = 10 * 60_000;
export function clockLine(now = new Date()): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `[context] Date and time: ${now.toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} (${tz})`;
}
export const CLOCK_PREFIX = '[context] Date and time: ';

function toolList(kind: 'main' | 'worker', opts: ToolSetOptions = {}): string {
  const names = enabledTools(kind, opts).map((t) => t.function.name);
  return `Tools available to you (use exactly these names, no others): ${names.join(', ')}.`;
}

const SHARED_RULES = `Working rules:
- Use tools to inspect before you change anything. Read a file before editing it: edit_file and write_file refuse files you have not read (or that changed since), and the refusal tells you what to do.
- Every action on files or the shell must be a real tool call; never just describe or print code that "would" do it. Never claim a result you did not observe in a tool result.
EDIT_RULE
- Run commands with shell_run; use terminal_* only for long-lived processes.
- Keep going until the task is actually finished and verified (run tests/builds when relevant). Do not stop to ask whether to proceed on routine steps.
- Use ask_user only when a decision genuinely requires the user.
- When done, reply with a concise summary of what changed and anything the user must do next.
- Paths outside the approved folders are blocked; do not try to work around that.`;

/** A8: the edit rule matches the edit tools the model actually has. */
function rules(model?: string | null): string {
  const style = editStyleFor(model);
  const line =
    style === 'apply_patch'
      ? '- Change files with apply_patch (Update File for edits, Add File for new files); copy context lines exactly from what you read.'
      : style === 'str_replace_editor'
        ? '- Change files with str_replace_editor: view, then str_replace (unique old_str) for edits, create for new files, insert to add lines.'
        : '- Prefer edit_file for small changes and write_file for new files or rewrites.';
  return SHARED_RULES.replace('EDIT_RULE', line);
}

export function mainSystemPrompt(opts: ToolSetOptions = {}): string {
  const custom = getSettings().systemPrompt.trim();
  return [
    `You are LocalDex, a local coding agent running on the user's machine with access to their files and terminal through tools.`,
    environment(),
    toolList('main', opts),
    rules(opts.model),
    mcpPromptNotes('main'),
    skillsPromptNotes(),
    `Planning: for multi-step work, call update_plan first with the steps, then keep it current as you progress.`,
    `Delegation: for independent sub-tasks (e.g. "write tests" while you implement), call delegate_to_worker, giving each worker complete, self-contained instructions. Several delegate calls in one turn run in parallel. Reuse a worker's name to continue its context. Review workers' reports and integrate them.`,
    councilNote(),
    projectInstructions(),
    custom ? `User instructions:\n${custom}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function councilNote(): string {
  const names = enabledTools('main').map((t) => t.function.name);
  if (!names.includes('ask_member') && !names.includes('council')) return '';
  return `Model council: stronger cloud models (Claude, Codex, Gemini, Cursor) run on the user's subscriptions and work directly in the project folder. Tools: ask_member (one member; several calls in one turn run in parallel; access "write" for big changes) and council ("plan_build_review" for multi-part changes, "second_opinion" to check work, "vote" for decisions).
Ask a member when:
- Two attempts to fix the same failure did not work.
- Before a hard-to-reverse decision: data model, migration, auth, deleting data, public API.
- A plan or diff should be reviewed before you call the work done.
- You are unsure and being wrong is costly.
- The task needs reading much more code than fits in your context.
How to ask:
- For reviews, prefer a member from a different vendor than the one that wrote the code.
- Write a self-contained question: goal, file paths, what you tried, exact errors. The member can read the repo but not this chat.
- Check the advice against the code before acting on it.
Do small, simple steps yourself; members use the user's plan limits.`;
}

export function workerSystemPrompt(name: string): string {
  const custom = getSettings().systemPrompt.trim();
  return [
    `You are "${name}", a worker agent delegated a task by the lead LocalDex agent. You have the same file and shell tools. Complete the task fully, then reply with a report: what you did, files touched, verification results, and any problems. Do not ask the lead agent questions; make reasonable decisions and state them in the report.`,
    environment(),
    toolList('worker'),
    rules(),
    mcpPromptNotes('worker'),
    skillsPromptNotes(),
    projectInstructions(),
    custom ? `User instructions:\n${custom}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** One line on the goal tools, appended to the goal messages (the tools are only offered while a goal runs). */
export const GOAL_TOOLS_HINT =
  'Goal tools: get_goal shows the goal and its revision id; update_goal trims the remaining items; complete_goal ends the goal once the done criteria are verified by tool results; block_goal reports what stops you (3 blocked rounds in a row stop the goal).';

export function goalContinuePrompt(brief: string, remaining: string[], mode: 'goal' | 'loop', blocker?: { reason: string; round: number; max: number }): string {
  const rem = remaining.length ? `\nRemaining items:\n${remaining.map((r) => `- ${r}`).join('\n')}` : '';
  const blocked = blocker
    ? `\nLast round you reported a blocker (${blocker.round}/${blocker.max}): ${blocker.reason}\nTry a different approach or work around it; if it is truly impossible without the user, call block_goal again with what you need.`
    : '';
  return mode === 'goal'
    ? `[Goal checkpoint] The goal is not finished yet. Continue working toward it without waiting for confirmation.\nGoal: ${brief}${rem}${blocked}`
    : `[Loop] Continue the ongoing work described in the brief. Pick the next most valuable thing and do it.\nBrief: ${brief}${rem}${blocked}`;
}

/** Cap on the previous round's report carried into a fresh round (about 2k tokens). */
export const FRESH_REPORT_CHARS = 8_000;

/**
 * Fresh-context goal round (DeepSeek Harness `experimental/tool-ralph`, reimplemented): the new context gets only the
 * fixed objective, the previous round's report, the workspace state LocalDex checked itself, and the plan.
 */
export function goalFreshRoundPrompt(input: {
  brief: string;
  doneCriteria: string;
  mode: 'goal' | 'loop';
  iteration: number;
  maxIterations: number;
  remaining: string[];
  lastReport: string | null;
  fileFacts: string;
  plan: Array<{ title: string; status: string }>;
  blocker?: { reason: string; round: number; max: number };
}): string {
  const report = (input.lastReport ?? '').trim();
  const cut = report.length > FRESH_REPORT_CHARS ? `${report.slice(0, FRESH_REPORT_CHARS)}\n[… report cut at ${FRESH_REPORT_CHARS} characters]` : report;
  const parts = [
    `[Goal round ${input.iteration + 1}/${input.maxIterations}, fresh context] Earlier rounds worked on this goal; their conversation is not in your context. Everything you need is below and on disk. Read files before editing them.`,
    input.mode === 'goal' ? `Goal: ${input.brief}${input.doneCriteria ? `\nDone when: ${input.doneCriteria}` : ''}` : `Brief: ${input.brief}`,
  ];
  if (input.remaining.length) parts.push(`Remaining items:\n${input.remaining.map((r) => `- ${r}`).join('\n')}`);
  if (input.blocker) parts.push(`Last round reported a blocker (${input.blocker.round}/${input.blocker.max}): ${input.blocker.reason}\nTry a different approach; if it is truly impossible without the user, call block_goal again.`);
  if (cut) parts.push(`Previous round's report:\n${cut}`);
  if (input.fileFacts) parts.push(input.fileFacts);
  if (input.plan.length) parts.push(`Plan:\n${input.plan.map((s) => `- [${s.status === 'done' ? 'x' : s.status === 'in_progress' ? '>' : s.status === 'skipped' ? '-' : ' '}] ${s.title}`).join('\n')}`);
  parts.push(`Continue the work now without waiting for confirmation. ${GOAL_TOOLS_HINT}`);
  return parts.join('\n\n');
}

export function goalAssessPrompt(brief: string, criteria: string, mode: 'goal' | 'loop'): string {
  return `You are auditing an AI coding agent's progress.
${mode === 'goal' ? `Goal: ${brief}\nDone criteria: ${criteria || '(use your judgement: the goal is fully achieved and verified)'}` : `Ongoing brief: ${brief}`}

Based on the transcript excerpt, respond with ONLY a JSON object:
{"done": boolean, "remaining": string[], "note": string}
- "done": true only if every part of the goal is complete AND verified (tests/builds run where relevant). ${mode === 'loop' ? 'In loop mode, "done" is always false.' : ''}
- "remaining": short list of concrete things still to do (empty if done).
- "note": one sentence of assessment.`;
}

export function compactPrompt(kind: 'main' | 'worker'): string {
  return `Summarize this ${kind === 'main' ? 'coding session' : "worker's conversation"} so that a fresh agent instance can resume seamlessly. Write in plain prose and bullet points, no preamble. Include:
1. The user's overall objective and any constraints or preferences they stated.
2. Decisions made and why.
3. Files created/modified/deleted (full paths) with a one-line description each.
4. Current state: what is done, what is in progress, what is still open.
5. Known problems, failing tests, or gotchas discovered.
6. Any open terminals (ids and what runs in them) and important command output.
Be specific and complete; omit chit-chat.`;
}
