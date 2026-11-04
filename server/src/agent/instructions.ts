import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getSettings } from '../config.js';
import { approvedFolders } from '../tools/permissions.js';

/**
 * Project instructions (pattern borrowed from DeepSeek Harness `context/agent-instructions`, reimplemented): a
 * user-global file and the project's own file go into the system prompt, each under its own byte budget, so a long
 * project file never crowds out the global one and vice versa. Nested instruction files are discovered when the
 * agent touches a subfolder and appended as context then (the system prompt itself stays frozen, see C3).
 */
export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'LOCALDEX.md'];
export const GLOBAL_INSTRUCTIONS = path.join(DATA_DIR, 'AGENTS.md');
export const GLOBAL_BUDGET = 4 * 1024;
export const PROJECT_BUDGET = 8 * 1024;
/** Nested files get the project budget split in half each: deeper = more specific, but never the whole window. */
export const NESTED_BUDGET = 4 * 1024;

export function instructionsEnabled(): boolean {
  return getSettings().projectInstructions !== false;
}

/** Read a file and cut it to `budget` bytes with a notice; null when absent or unreadable. */
export function readInstructionFile(file: string, budget: number): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return null;
    if (Buffer.byteLength(text, 'utf8') <= budget) return text.trimEnd();
    const cut = Buffer.from(text, 'utf8').subarray(0, budget).toString('utf8').replace(/\uFFFD$/, '');
    // Cut at a line end when one is near, so the notice doesn't land mid-sentence.
    const nl = cut.lastIndexOf('\n');
    const kept = nl > budget * 0.8 ? cut.slice(0, nl) : cut;
    return `${kept.trimEnd()}\n\n[… ${file} is ${st.size} bytes; only the first ${budget} are loaded. Keep instruction files short, or move details into docs the agent can read on demand.]`;
  } catch {
    return null;
  }
}

/** The first instruction file found in `dir` (AGENTS.md wins over CLAUDE.md over LOCALDEX.md). */
export function instructionFileIn(dir: string): string | null {
  for (const name of INSTRUCTION_FILES) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/**
 * The section for the system prompt: the global file (4 KB) then each approved folder's root file (8 KB).
 * Empty string when there is nothing or the setting is off.
 */
export function projectInstructions(): string {
  if (!instructionsEnabled()) return '';
  const parts: string[] = [];
  const global = readInstructionFile(GLOBAL_INSTRUCTIONS, GLOBAL_BUDGET);
  if (global) parts.push(`Your instructions (${GLOBAL_INSTRUCTIONS}):\n${global}`);
  for (const folder of approvedFolders()) {
    const f = instructionFileIn(folder);
    const text = f ? readInstructionFile(f, PROJECT_BUDGET) : null;
    if (text) parts.push(`Project instructions (${f}):\n${text}`);
  }
  return parts.length ? `Instructions from the user and the project. Follow them; they take precedence over general habits.\n\n${parts.join('\n\n')}` : '';
}

// ---------- nested instruction files, discovered as the agent works ----------

/** sessionId → instruction files already handed to the session (root files included, so they are not repeated). */
const seen = new Map<string, Set<string>>();
/** sessionId → texts waiting to be appended before the next model call. */
const pending = new Map<string, string[]>();

/**
 * A file tool touched `abs`: look for instruction files in the folders between it and the approved root. New ones
 * are queued for the session; the agent loop appends them as a context message.
 */
export function noteTouched(sessionId: string, abs: string): void {
  if (!instructionsEnabled()) return;
  const root = approvedFolders().find((f) => abs === f || abs.startsWith(f + path.sep));
  if (!root) return;
  let s = seen.get(sessionId);
  if (!s) seen.set(sessionId, (s = new Set(approvedFolders().map((f) => instructionFileIn(f)).filter((x): x is string => !!x))));
  let dir = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
  const found: string[] = [];
  while (dir.startsWith(root) && dir !== root) {
    const f = instructionFileIn(dir);
    if (f && !s.has(f)) {
      s.add(f);
      found.unshift(f);
    }
    dir = path.dirname(dir);
  }
  for (const f of found) {
    const text = readInstructionFile(f, NESTED_BUDGET);
    if (!text) continue;
    const q = pending.get(sessionId) ?? [];
    q.push(`[context] Instructions for ${path.relative(root, path.dirname(f)) || '.'}/ (${f}):\n${text}`);
    pending.set(sessionId, q);
  }
}

/** Texts to append before the next model call, then cleared. */
export function pullInstructions(sessionId: string): string[] {
  const q = pending.get(sessionId) ?? [];
  pending.delete(sessionId);
  return q;
}

/** Compact & Resume / session deleted: nested files may be shown again when touched. */
export function forgetInstructions(sessionId: string): void {
  seen.delete(sessionId);
  pending.delete(sessionId);
}
