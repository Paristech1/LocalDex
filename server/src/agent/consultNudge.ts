/**
 * "Ask the council" nudges for the local lead in Solo mode. Pure and cheap: the loop feeds it
 * tool outcomes and it returns at most one suggestion per kind per run.
 */

export interface NudgeOutcome {
  name: string;
  /** Raw JSON arguments string, as the model sent it. */
  args: string;
  ok: boolean;
}

export type NudgeKind = 'failures' | 'repeat';

const EDIT_TOOLS = new Set(['edit_file', 'write_file']);
const CONSULT_TOOLS = new Set(['ask_member', 'council']);

export const FAILURES_HINT =
  'If you are still stuck, ask a council member with ask_member: describe the goal, what you tried and the exact error.';

export const REPEAT_HINT = (cmd: string) =>
  `[system] \`${cmd}\` failed again after your edits. Two fixes did not work; before a third attempt, consider ask_member with the goal, what you changed and the exact error (the member can read the repo but not this chat).`;

/** Nudges apply only when the council can actually be asked and the user has not turned them off. */
export function consultEnabled(o: { councilAvailable: boolean; toolNames: string[]; setting: boolean | undefined }): boolean {
  return o.councilAvailable && o.setting !== false && o.toolNames.includes('ask_member');
}

function commandOf(args: string): string | null {
  try {
    const v = JSON.parse(args) as { command?: unknown; cwd?: unknown };
    if (typeof v.command !== 'string') return null;
    const cmd = v.command.trim().replace(/\s+/g, ' ');
    return cmd ? `${typeof v.cwd === 'string' ? v.cwd : ''}\u0000${cmd}` : null;
  } catch {
    return null;
  }
}

export class ConsultNudger {
  private fired = new Set<NudgeKind>();
  private edits = 0;
  /** Failing shell command → edit count when it last failed. */
  private failing = new Map<string, number>();

  constructor(private readonly enabled: boolean) {}

  /** Feed one round of tool outcomes; returns a message to inject, or null. */
  observe(outcomes: NudgeOutcome[]): string | null {
    let hint: string | null = null;
    for (const o of outcomes) {
      // The model already consulted: no need to suggest it again this run.
      if (CONSULT_TOOLS.has(o.name)) {
        this.fired.add('failures').add('repeat');
        continue;
      }
      if (EDIT_TOOLS.has(o.name) && o.ok) {
        this.edits++;
        continue;
      }
      if (o.name !== 'shell_run') continue;
      const key = commandOf(o.args);
      if (!key) continue;
      if (o.ok) {
        this.failing.delete(key);
        continue;
      }
      const editsAtLastFailure = this.failing.get(key);
      this.failing.set(key, this.edits);
      // Same command failing again with edits in between = a fix was tried and did not work.
      if (editsAtLastFailure !== undefined && this.edits > editsAtLastFailure && !hint && this.take('repeat')) {
        hint = REPEAT_HINT(key.split('\u0000')[1].slice(0, 120));
      }
    }
    return hint;
  }

  /** Extra line for the "N tool calls in a row failed" message ('' when not applicable). */
  failuresHint(): string {
    return this.take('failures') ? ` ${FAILURES_HINT}` : '';
  }

  private take(kind: NudgeKind): boolean {
    if (!this.enabled || this.fired.has(kind)) return false;
    this.fired.add(kind);
    return true;
  }
}
