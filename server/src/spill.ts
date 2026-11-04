import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getSettings } from './config.js';
import { contextLengthFor } from './lmstudio.js';

/**
 * Oversized tool output is never thrown away: the complete text goes to a private file under LocalDex's data folder
 * and the model gets the head, the tail and the path, so it can read the rest on demand (read_file / grep).
 * Pattern borrowed from DeepSeek Harness `spill/spill-policy` + `spill/spill-local` (reimplemented).
 */
export const SPILL_DIR = path.join(DATA_DIR, 'spill');

/** Rough characters per token for budgeting (code and logs run closer to 3.5; 4 keeps the inline part on the safe side). */
export const CHARS_PER_TOKEN = 4;
/** Cap on what stays inline whatever the window (DeepSeek Harness's default `maxInlineTokens`). */
export const MAX_INLINE_TOKENS = 12_500;
/** Used when the model's context window is unknown. */
const UNKNOWN_WINDOW_TOKENS = 32_768;
/** Never go below this, so tiny windows still get something useful inline. */
const MIN_INLINE_TOKENS = 2_000;

export interface SpillOptions {
  sessionId: string;
  /** File name under the session's spill folder (the tool call id, or any short label). */
  callId: string;
  /** Characters allowed inline. Default: inlineBudgetChars() for the session's model. */
  budgetChars?: number;
  /** Shown in the notice, e.g. "Command output". */
  label?: string;
}

export interface SpillResult {
  text: string;
  /** Set when the output was saved to a file. */
  path?: string;
  omitted: number;
}

/** Inline budget in characters for a model: min(30% of its context window, 12.5k tokens), with a floor. */
export function inlineBudgetChars(model: string | null): number {
  const ctx = contextLengthFor(model) || UNKNOWN_WINDOW_TOKENS;
  const tokens = Math.max(MIN_INLINE_TOKENS, Math.min(Math.floor(ctx * 0.3), MAX_INLINE_TOKENS));
  return tokens * CHARS_PER_TOKEN;
}

/** The inline budget for whichever model the main agent uses right now. */
export function currentInlineBudgetChars(): number {
  return inlineBudgetChars(getSettings().model);
}

export function spillDir(sessionId: string): string {
  return path.join(SPILL_DIR, safeName(sessionId));
}

export function spillPath(sessionId: string, callId: string): string {
  return path.join(spillDir(sessionId), `${safeName(callId)}.txt`);
}

/**
 * Keep `text` inline when it fits; otherwise save all of it and return head (60% of the budget) + marker + tail (25%)
 * + a notice naming what was left out and where the full text is.
 */
export function spill(text: string, opts: SpillOptions): SpillResult {
  const budget = Math.max(1_000, opts.budgetChars ?? currentInlineBudgetChars());
  if (text.length <= budget) return { text, omitted: 0 };
  const file = spillPath(opts.sessionId, opts.callId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  } catch (e) {
    // Can't save: fall back to a plain truncation that still says what was lost.
    return { text: `${headTail(text, budget)}\n\n[${opts.label ?? 'Output'} was ${text.length} chars; showing start and end. It could not be saved to a file (${(e as Error).message}).]`, omitted: text.length - budget };
  }
  const lines = text.split('\n').length;
  const body = headTail(text, budget);
  const notice = `[${opts.label ?? 'Output'} was ${text.length} chars (${lines} lines); showing start and end. Full output: ${file}. Read it with read_file start_line/end_line or grep.]`;
  return { text: `${body}\n\n${notice}`, path: file, omitted: text.length - body.length };
}

/** Save the whole text under the session's spill folder (e.g. a council diff too big for a reviewer). Returns the path, or undefined when it couldn't be written. */
export function saveSpill(sessionId: string, name: string, text: string): string | undefined {
  const file = spillPath(sessionId, name);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    return file;
  } catch {
    return undefined;
  }
}

function headTail(text: string, budget: number): string {
  const head = text.slice(0, Math.floor(budget * 0.6));
  const tail = text.slice(-Math.floor(budget * 0.25));
  return `${head}\n\n[...]\n\n${tail}`;
}

/** Is this path inside the spill folder (file tools may read there, never write)? */
export function isSpillPath(abs: string): boolean {
  const rel = path.relative(SPILL_DIR, abs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** A session was deleted: its saved outputs go with it. */
export function deleteSpill(sessionId: string): void {
  try {
    fs.rmSync(spillDir(sessionId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || '_';
}
