import os from 'node:os';
import { getSettings } from '../config.js';
import { enabledTools } from '../tools/index.js';
import { approvedFolders } from '../tools/permissions.js';
import { mcpPromptNotes } from '../mcp/client.js';
import { skillsPromptNotes } from '../skills/store.js';

function environment(): string {
  const folders = approvedFolders();
  return [
    `OS: ${process.platform} (${os.release()}), shell: ${process.env.SHELL ?? 'sh'}`,
    `Date: ${new Date().toDateString()}`,
    folders.length
      ? `Approved folders (you may only read/write inside these): ${folders.join(', ')}\nDefault working directory: ${folders[0]}`
      : 'No folders are approved yet. Ask the user to add one in Settings → Workspace before using file or shell tools.',
  ].join('\n');
}

function toolList(kind: 'main' | 'worker'): string {
  const names = enabledTools(kind).map((t) => t.function.name);
  return `Tools available to you (use exactly these names, no others): ${names.join(', ')}.`;
}

const SHARED_RULES = `Working rules:
- Use tools to inspect before you change anything. Read a file before editing it.
- Every action on files or the shell must be a real tool call; never just describe or print code that "would" do it. Never claim a result you did not observe in a tool result.
- Prefer edit_file for small changes and write_file for new files or rewrites.
- Run commands with shell_run; use terminal_* only for long-lived processes.
- Keep going until the task is actually finished and verified (run tests/builds when relevant). Do not stop to ask whether to proceed on routine steps.
- Use ask_user only when a decision genuinely requires the user.
- When done, reply with a concise summary of what changed and anything the user must do next.
- Paths outside the approved folders are blocked; do not try to work around that.`;

export function mainSystemPrompt(): string {
  const custom = getSettings().systemPrompt.trim();
  return [
    `You are LocalDex, a local coding agent running on the user's machine with access to their files and terminal through tools.`,
    environment(),
    toolList('main'),
    SHARED_RULES,
    mcpPromptNotes('main'),
    skillsPromptNotes(),
    `Planning: for multi-step work, call update_plan first with the steps, then keep it current as you progress.`,
    `Delegation: for independent sub-tasks (e.g. "write tests" while you implement), call delegate_to_worker, giving each worker complete, self-contained instructions. Several delegate calls in one turn run in parallel. Reuse a worker's name to continue its context. Review workers' reports and integrate them.`,
    custom ? `User instructions:\n${custom}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function workerSystemPrompt(name: string): string {
  const custom = getSettings().systemPrompt.trim();
  return [
    `You are "${name}", a worker agent delegated a task by the lead LocalDex agent. You have the same file and shell tools. Complete the task fully, then reply with a report: what you did, files touched, verification results, and any problems. Do not ask the lead agent questions; make reasonable decisions and state them in the report.`,
    environment(),
    toolList('worker'),
    SHARED_RULES,
    mcpPromptNotes('worker'),
    skillsPromptNotes(),
    custom ? `User instructions:\n${custom}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function goalContinuePrompt(brief: string, remaining: string[], mode: 'goal' | 'loop'): string {
  const rem = remaining.length ? `\nRemaining items:\n${remaining.map((r) => `- ${r}`).join('\n')}` : '';
  return mode === 'goal'
    ? `[Goal checkpoint] The goal is not finished yet. Continue working toward it without waiting for confirmation.\nGoal: ${brief}${rem}`
    : `[Loop] Continue the ongoing work described in the brief. Pick the next most valuable thing and do it.\nBrief: ${brief}${rem}`;
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
