import type { CouncilAccess, MemberBilling, MemberId, MemberStatus } from '@localdex/shared';

/** Normalized events every member adapter emits, whatever the vendor's own stream format is. */
export type MemberEvent =
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  | { kind: 'tool_start'; id: string; name: string; args: unknown }
  | { kind: 'tool_end'; id: string; ok: boolean; result: string }
  | { kind: 'billing'; billing: MemberBilling; detail?: string }
  | { kind: 'note'; text: string };

export interface MemberRunOptions {
  prompt: string;
  /** Extra system-style instructions (role, rules). Members that support it get it as a system prompt; others get it prepended. */
  instructions: string;
  cwd: string;
  /** Other approved folders the member may use. */
  extraDirs: string[];
  access: CouncilAccess;
  model?: string;
  signal: AbortSignal;
  timeoutMs: number;
  onEvent: (ev: MemberEvent) => void;
  /** Continue this vendor session (from an earlier MemberResult.sessionId) instead of starting a new one. */
  resumeSessionId?: string;
  /**
   * The resumed session already holds these instructions, so adapters that prepend instructions to the prompt
   * (Codex, Gemini) send only the prompt. Adapters with a real system prompt pass it again either way.
   */
  instructionsInSession?: boolean;
}

/** A resume that failed because the vendor could not find or load the session (not a task error). */
export const RESUME_FAILED_RE = /no (conversation|session|saved session|rollout|thread)s? found|(session|conversation|thread|rollout|agent)\b[^\n]{0,60}\bnot found|invalid session|error resuming session|failed to (find|load|resume) (the )?(session|conversation|thread|agent)|unknown (session|thread|agent)/i;

/** Prompt body for members without a system prompt: instructions first, unless a resumed session already has them. */
export function promptWithInstructions(o: MemberRunOptions): string {
  return o.resumeSessionId && o.instructionsInSession ? o.prompt : `${o.instructions}\n\n---\n\n${o.prompt}`;
}

export interface MemberResult {
  ok: boolean;
  /** Final answer/report. */
  text: string;
  error?: string;
  /** The vendor reported a usage/rate limit. The router cools the member down and falls back. */
  limited?: boolean;
  /** When the limit resets, if the vendor said so (epoch ms). */
  limitResetsAt?: number;
  billing: MemberBilling;
  usage?: { inputTokens: number; outputTokens: number };
  model?: string;
  cancelled?: boolean;
  /** The vendor's own session id for this run, so a follow-up can resume it. */
  sessionId?: string;
  /** resumeSessionId was given and the vendor could not continue that session. The caller retries fresh. */
  resumeFailed?: boolean;
}

export type MemberStatusBase = Omit<MemberStatus, 'limitedUntil' | 'lastError' | 'checkedAt'> & { lastError?: string };

export interface ModelList {
  models: string[];
  source: 'account' | 'suggested';
}

export interface MemberAdapter {
  id: MemberId;
  label: string;
  /** Detect install + sign-in + billing. Must be cheap-ish (called on demand and cached). */
  status(): Promise<Omit<MemberStatus, 'limitedUntil' | 'lastError' | 'checkedAt'>>;
  run(opts: MemberRunOptions): Promise<MemberResult>;
  /**
   * Models this member can use. 'account' = listed by the vendor's own CLI/SDK for the signed-in account;
   * 'suggested' = known aliases when the vendor offers no listing. Called off the status path, with a timeout.
   */
  listModels?(status: MemberStatusBase, signal: AbortSignal): Promise<ModelList>;
  /** Cursor only: open the vendor's sign-in page from LocalDex. */
  login?(onUrl: (url: string) => void, signal: AbortSignal): Promise<{ ok: boolean; account?: string; error?: string }>;
}

/** Usage/rate-limit wording across vendors. */
export const LIMIT_RE = /usage limit|rate[ -]?limit|limit reached|limit exceeded|quota|too many requests|\b429\b|resource[_ ]exhausted|hit your .*limit|out of (credits|requests)/i;

export function detectLimit(text: string | undefined): boolean {
  return !!text && LIMIT_RE.test(text);
}

/** Best effort: pull a reset time out of a limit message ("resets 3pm", "|1760380800", "try again in 2 hours"). */
export function parseResetAt(text: string | undefined, now = Date.now()): number | undefined {
  if (!text) return undefined;
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return Number(epoch[1]) * 1000;
  const inMatch = text.match(/in\s+(\d+)\s*(minute|min|hour|hr|h|m)s?\b/i);
  if (inMatch) {
    const n = Number(inMatch[1]);
    const unit = inMatch[2].toLowerCase();
    return now + n * (unit.startsWith('h') ? 3_600_000 : 60_000);
  }
  return undefined;
}

export function stringify(v: unknown, max = 4000): string {
  let s: string;
  if (typeof v === 'string') s = v;
  else if (Array.isArray(v)) {
    // Anthropic-style content blocks: [{type:'text', text}]
    s = v.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : JSON.stringify(b))).join('\n');
  } else if (v === undefined || v === null) s = '';
  else s = JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}\n… [${s.length - max} more chars]` : s;
}
