// E2: headless CLI. `localdex run "task" --folder . [--model X] [--council] [--access read|ask|edit] [--json]`
// Runs one task to the end without the web UI and prints the final answer. Exit 0 = done, 1 = stopped or failed,
// 2 = bad usage. Approvals are denied unless --yes-safe (and dangerous commands are always denied); questions get
// "no user available". Settings changes here are for this process only (never written to config.json).
// Pattern from DeepSeek Harness bundle/headless (one-shot task mode), reimplemented.
import fs from 'node:fs';
import path from 'node:path';
import type { CouncilRunAccess, PermissionPreset } from '@localdex/shared';

export interface CliOptions {
  task: string;
  folder: string;
  model?: string;
  council: boolean;
  access: 'read' | 'ask' | 'edit';
  json: boolean;
  yesSafe: boolean;
  verbose: boolean;
  maxSteps?: number;
}

export const USAGE = `Usage: localdex run "<task>" [options]

Options:
  --folder <dir>     Project folder the agent may work in (default: current folder)
  --model <id>       LM Studio model (default: the one in Settings)
  --council          Send the task to the model council instead of the local model
  --access <mode>    read | ask | edit  (default: ask)
                       read: nothing may change files (Read only preset / read-only council)
                       ask:  normal rules; anything that would ask is denied, since nobody can answer
                       edit: files may be edited (council builder edits allowed)
  --yes-safe         Approve prompts for commands that aren't on the dangerous list (dangerous ones stay denied)
  --max-steps <n>    Cap on model steps (default: Settings)
  --json             Print {"status","answer","session","steps","error"} as JSON
  --verbose          Show tool calls and progress on stderr
Exit codes: 0 done · 1 stopped or failed · 2 bad usage`;

/** Parse argv (after "run"). Returns an error string for bad usage. */
export function parseArgs(argv: string[], cwd = process.cwd()): CliOptions | string {
  const opts: CliOptions = { task: '', folder: cwd, council: false, access: 'ask', json: false, yesSafe: false, verbose: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    try {
      if (a === '--folder') opts.folder = path.resolve(cwd, val());
      else if (a === '--model') opts.model = val();
      else if (a === '--council') opts.council = true;
      else if (a === '--access') {
        const v = val();
        if (v !== 'read' && v !== 'ask' && v !== 'edit') return `--access must be read, ask or edit (got "${v}")`;
        opts.access = v;
      } else if (a === '--json') opts.json = true;
      else if (a === '--yes-safe') opts.yesSafe = true;
      else if (a === '--verbose' || a === '-v') opts.verbose = true;
      else if (a === '--max-steps') opts.maxSteps = Math.max(1, Number(val()) || 0) || undefined;
      else if (a.startsWith('--')) return `Unknown option ${a}`;
      else rest.push(a);
    } catch (e) {
      return (e as Error).message;
    }
  }
  opts.task = rest.join(' ').trim();
  if (!opts.task) return 'Give the task in quotes: localdex run "fix the failing test"';
  if (!fs.existsSync(opts.folder) || !fs.statSync(opts.folder).isDirectory()) return `--folder ${opts.folder} is not a folder`;
  return opts;
}

export interface CliResult {
  status: 'done' | 'stopped' | 'failed';
  answer: string;
  session: string;
  steps: number;
  error?: string;
}

/** Run one task headless. Uses the same runner, tools and safety rules as the web UI. */
export async function runHeadless(opts: CliOptions, log: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): Promise<CliResult> {
  const { getSettings, overrideSettings } = await import('./config.js');
  const { bus } = await import('./agent/bus.js');
  const { isDangerousCommand } = await import('./tools/permissions.js');
  const { createSession, flushAll } = await import('./store.js');
  const { runnerFor } = await import('./agent/runner.js');
  const { listModels } = await import('./lmstudio.js');

  const preset: PermissionPreset = opts.access === 'read' ? 'read-only' : (getSettings().permissionPreset ?? 'full');
  const st = getSettings();
  overrideSettings({
    approvedFolders: [opts.folder, ...st.approvedFolders.filter((f) => path.resolve(f) !== opts.folder)],
    permissionPreset: preset,
    autoTitle: false,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.maxSteps ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.council ? { council: { ...st.council, enabled: true, ...(opts.access === 'edit' ? { allowWrite: true } : {}) } } : {}),
  });
  if (!opts.council) {
    await listModels().catch(() => []);
    if (!getSettings().model) return { status: 'failed', answer: '', session: '', steps: 0, error: 'No model: pass --model or pick one in Settings.' };
  }

  const s = createSession(getSettings().model);
  s.title = `CLI: ${opts.task.split('\n')[0].slice(0, 50)}`;
  s.titleSource = 'user';
  if (opts.council) s.mode = 'council';
  let steps = 0;
  let stopReason: string | null = null;
  const unsub = bus.subscribe((ev) => {
    if (ev.type === 'log' && /Run stopped: |reached max steps|got stuck/.test(ev.message)) stopReason ??= ev.message.replace(/^\[[^\]]+\]\s*/, '');
    if (!('sessionId' in ev) || ev.sessionId !== s.id) return;
    if (ev.type === 'approval_request') {
      const yes = opts.yesSafe && !isDangerousCommand(ev.command) && !/^MCP |sandbox blocked/.test(ev.command);
      log(`${yes ? '✓ approved' : '✗ denied'} (headless): ${ev.command.split('\n')[0].slice(0, 160)}`);
      setTimeout(() => bus.resolvePrompt(ev.id, yes), 0);
    } else if (ev.type === 'ask_user') {
      log(`? ${ev.question.slice(0, 160)} → no user (headless)`);
      setTimeout(() => bus.resolvePrompt(ev.id, 'No user is available: this is a headless run. Make the most reasonable choice yourself and say which one you made, or stop and explain what you need.'), 0);
    } else if (ev.type === 'turn_start') {
      steps++;
    } else if (ev.type === 'tool_start' && opts.verbose) {
      log(`→ ${ev.name} ${JSON.stringify(ev.args).slice(0, 160)}`);
    } else if (ev.type === 'tool_end' && opts.verbose) {
      log(`  ${ev.ok ? 'ok' : 'failed'}: ${String(ev.result).split('\n')[0].slice(0, 160)}`);
    }
  });
  try {
    const access: CouncilRunAccess | undefined = opts.council ? ({ read: 'read', ask: 'confirm', edit: 'auto' } as const)[opts.access] : undefined;
    await runnerFor(s).handleUserMessage(opts.task, access);
  } catch (e) {
    unsub();
    flushAll();
    return { status: 'failed', answer: '', session: s.id, steps, error: (e as Error).message };
  }
  unsub();
  flushAll();
  // The outcome: the last assistant text after the request, unless the run left a "[system] Run stopped" note.
  const after = s.messages.slice(s.messages.findIndex((m) => m.role === 'user' && m.content === opts.task) + 1);
  const stopped = after.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[system] Run stopped'));
  const lastAnswer = [...after].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
  const run = opts.council ? s.councilRuns?.at(-1) : undefined;
  const answer = (lastAnswer?.content as string | undefined)?.trim() ?? '';
  if (stopped) return { status: 'stopped', answer, session: s.id, steps, error: (stopped.content as string).replace(/^\[system\] /, '').split('\n')[0] };
  if (run && run.status !== 'done') return { status: run.status === 'cancelled' ? 'stopped' : 'failed', answer, session: s.id, steps, error: `council run ${run.status}` };
  if (stopReason && !answer) return { status: 'stopped', answer, session: s.id, steps, error: stopReason };
  if (!answer) return { status: 'failed', answer, session: s.id, steps, error: 'the run ended without an answer' };
  return { status: 'done', answer, session: s.id, steps };
}

/** Entry point: `localdex run …`. */
export async function main(argv: string[]): Promise<number> {
  // stdout is for the answer (or JSON) only: server log lines go to stderr.
  for (const k of ['log', 'info', 'warn', 'debug'] as const) console[k] = (...a: unknown[]) => process.stderr.write(`${a.map(String).join(' ')}\n`);
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return cmd ? 0 : 2;
  }
  if (cmd !== 'run') {
    process.stderr.write(`Unknown command "${cmd}".\n\n${USAGE}\n`);
    return 2;
  }
  const opts = parseArgs(rest);
  if (typeof opts === 'string') {
    process.stderr.write(`${opts}\n\n${USAGE}\n`);
    return 2;
  }
  const r = await runHeadless(opts, opts.verbose || !opts.json ? (l) => process.stderr.write(`${l}\n`) : () => undefined);
  if (opts.json) process.stdout.write(`${JSON.stringify(r)}\n`);
  else {
    if (r.answer) process.stdout.write(`${r.answer}\n`);
    if (r.status !== 'done') process.stderr.write(`\n[${r.status}] ${r.error ?? ''}\n`);
  }
  return r.status === 'done' ? 0 : 1;
}
