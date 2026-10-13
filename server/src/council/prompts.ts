import type { CouncilAccess, CouncilRole } from '@localdex/shared';

const ROLE_BRIEF: Record<CouncilRole | 'judge' | 'voter', string> = {
  planner: 'You are the PLANNER. Inspect the code you need, then produce a concrete, numbered implementation plan: files to change (full paths), what to change in each, new files, edge cases, and how to verify (exact commands). Do not change any files.',
  builder: 'You are the BUILDER. Carry out the task (and the plan, if one is given) completely. Make the edits, keep changes minimal and consistent with the codebase style, and verify where you can.',
  frontend: 'You are the BUILDER for frontend work (UI, components, styling, layout, accessibility). Carry out the task (and the plan, if one is given) completely. Follow the project\'s existing component patterns, styling system and design tokens; keep layouts responsive and accessible (labels, focus, contrast); keep changes minimal and verify where you can (typecheck, build, tests).',
  backend: 'You are the BUILDER for backend work (APIs, server code, data, auth, jobs). Carry out the task (and the plan, if one is given) completely. Validate inputs, handle errors explicitly, keep database changes safe and reversible (migrations, no destructive queries), never weaken auth or log secrets, keep changes minimal and verify where you can (tests, typecheck).',
  reviewer: 'You are the REVIEWER. Check the work against the task with a skeptical eye: correctness, missed requirements, bugs, security problems, broken edge cases, style drift. Do not change any files.',
  researcher: 'You are the RESEARCHER. Read whatever you need in the codebase and answer the question accurately, citing file paths (and line numbers when useful). Do not change any files.',
  vision: 'You are the VISION member. The request is about one or more images (screenshots, mockups, designs). Open each image with your own file-reading tools and look at it carefully, then answer: describe what matters, compare it with the code when asked, and give concrete, actionable findings (components, layout, spacing, colors, text, errors shown). Do not change any files.',
  quick: 'Answer the question directly and briefly. Do not change any files.',
  voter: 'You are one of several independent advisers. Give your own best answer with your reasoning. Be decisive. Do not change any files.',
  judge: 'You are the JUDGE. Several advisers answered the same question independently. Compare their answers, say where they agree and disagree, point out any that are wrong, and give one final recommendation. Do not change any files.',
};

/** System-style instructions for a member run. */
export function memberInstructions(role: CouncilRole | 'judge' | 'voter', access: CouncilAccess, cwd: string): string {
  return [
    `You are a member of the LocalDex model council, working inside the user's project at ${cwd}.`,
    ROLE_BRIEF[role],
    access === 'write'
      ? 'You may edit files inside the project folder. Never touch files outside it, never delete large amounts of code without being asked, and never commit, push or publish.'
      : 'READ-ONLY: do not create, edit or delete files and do not run commands that change anything.',
    'Your final message is handed to the other council members and the user, so end with a clear, self-contained report.',
  ].join('\n');
}

export function plannerPrompt(task: string): string {
  return `Task from the user:\n${task}\n\nWrite the implementation plan.`;
}

export function builderPrompt(task: string, plan?: string): string {
  return plan
    ? `Task from the user:\n${task}\n\nPlan from the planner (follow it unless you find a real problem; say so if you deviate):\n${plan}\n\nImplement it. Finish with a report: files changed, what you did, how you verified it, anything left undone.`
    : `Task from the user:\n${task}\n\nDo it. Finish with a report: files changed, what you did, how you verified it, anything left undone.`;
}

/** Vision runs: point the member at the image files; it opens them itself (LocalDex never uploads images). */
export function visionPrompt(task: string, images: string[]): string {
  const where = images.length
    ? `Images referenced (paths are relative to the project folder unless absolute):\n${images.map((p) => `- ${p}`).join('\n')}\n\nOpen each image with your own tools before answering. If one can't be found, say so and continue with the rest.`
    : 'The request mentions an image but gives no file path. Look for the most likely image file in the project (e.g. recent .png/.jpg/.webp files, screenshots or design folders) and open it with your own tools; if you can\'t find one, say which file you need.';
  return `Task from the user:\n${task}\n\n${where}`;
}

export function reviewerPrompt(task: string, report: string, diff: string, plan?: string): string {
  return [
    `Task from the user:\n${task}`,
    plan ? `Plan that was followed:\n${plan}` : '',
    `Builder's report:\n${report || '(no report)'}`,
    diff ? `Changes (git diff):\n${diff}` : 'No git diff is available; inspect the files the builder says it changed.',
    'Review the changes. Start your reply with exactly one line: "VERDICT: APPROVE" or "VERDICT: CHANGES_REQUESTED". Then list concrete issues (file:line, what is wrong, how to fix). Only request changes for real problems, not taste.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function fixPrompt(task: string, review: string): string {
  return `Task from the user:\n${task}\n\nA reviewer checked your changes and requested fixes:\n${review}\n\nFix every valid issue (say why if you disagree with one). Finish with a short report of what you changed.`;
}

export function critiquePrompt(task: string, report: string, diff: string): string {
  return reviewerPrompt(task, report, diff).replace('Review the changes.', 'Give a second opinion on this work.');
}

export function votePrompt(question: string): string {
  return `Question from the user:\n${question}\n\nGive your answer. End with one line starting "Bottom line:".`;
}

export function judgePrompt(question: string, answers: Array<{ member: string; text: string }>): string {
  return `Question from the user:\n${question}\n\n${answers.map((a, i) => `--- Adviser ${i + 1} (${a.member}) ---\n${a.text}`).join('\n\n')}\n\nCompare the answers and give the final recommendation. Structure: "Agreement", "Disagreement", "Recommendation".`;
}

export function parseVerdict(review: string): 'approve' | 'changes' | 'unknown' {
  const m = review.match(/VERDICT:\s*(APPROVE|CHANGES[_ ]REQUESTED)/i);
  if (!m) return 'unknown';
  return /approve/i.test(m[1]) ? 'approve' : 'changes';
}
