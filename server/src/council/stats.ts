import fs from 'node:fs';
import path from 'node:path';
import type { CouncilMemberRef, CouncilMemberStats, CouncilRun, CouncilStats, CouncilStep, CouncilStepCounts } from '@localdex/shared';
import { DATA_DIR } from '../config.js';
import { bus } from '../agent/bus.js';
import { parseVerdict } from './prompts.js';

/** Member scorecard: how each council member performs across runs and sessions. Kept in <DATA_DIR>/council-stats.json. */

const REFS: CouncilMemberRef[] = ['claude', 'codex', 'gemini', 'cursor', 'local'];
const statsFile = () => path.join(DATA_DIR, 'council-stats.json');

let cache: CouncilStats | null = null;

const emptyCounts = (): CouncilStepCounts => ({ runs: 0, done: 0, errors: 0, limited: 0, cancelled: 0, skipped: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 });

const emptyMember = (): CouncilMemberStats => ({
  ...emptyCounts(),
  byRole: {},
  builder: { approvedFirst: 0, approvedAfterFixes: 0, changesRequested: 0 },
  reviewer: { approve: 0, changes: 0, none: 0 },
  voter: { answers: 0, answerChars: 0 },
  peerRanking: { count: 0, rankSum: 0, ofSum: 0 },
});

const emptyStats = (): CouncilStats => ({ since: Date.now(), updatedAt: Date.now(), members: {} });

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** Copy only known numeric fields, so a hand-edited or partial file can't break the scorecard. */
function cleanGroup<T extends object>(template: T, raw: unknown): T {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, number> = {};
  for (const k of Object.keys(template)) out[k] = num(src[k]);
  return out as T;
}

function cleanMember(raw: unknown): CouncilMemberStats {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const base = emptyMember();
  const byRole: CouncilMemberStats['byRole'] = {};
  if (src.byRole && typeof src.byRole === 'object') {
    for (const [role, counts] of Object.entries(src.byRole as Record<string, unknown>)) byRole[role as CouncilStep['role']] = cleanGroup(emptyCounts(), counts);
  }
  return {
    ...cleanGroup(emptyCounts(), src),
    byRole,
    builder: cleanGroup(base.builder, src.builder),
    reviewer: cleanGroup(base.reviewer, src.reviewer),
    voter: cleanGroup(base.voter, src.voter),
    peerRanking: cleanGroup(base.peerRanking, src.peerRanking),
  };
}

function load(): CouncilStats {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(statsFile(), 'utf8')) as Partial<CouncilStats>;
    const members: CouncilStats['members'] = {};
    for (const ref of REFS) if (raw.members?.[ref]) members[ref] = cleanMember(raw.members[ref]);
    cache = { since: num(raw.since) || Date.now(), updatedAt: num(raw.updatedAt) || Date.now(), members };
  } catch (e) {
    // Missing file = fresh start. Corrupt file: keep a copy for the user, then start fresh.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      try {
        fs.copyFileSync(statsFile(), `${statsFile()}.corrupt`);
      } catch {
        /* ignore */
      }
    }
    cache = emptyStats();
  }
  return cache;
}

function save(): void {
  const s = load();
  s.updatedAt = Date.now();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${statsFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, statsFile());
  } catch (e) {
    console.warn(`Could not save council stats: ${(e as Error).message}`);
  }
  bus.emit({ type: 'council_stats', stats: s });
}

function member(ref: CouncilMemberRef): CouncilMemberStats {
  const s = load();
  return (s.members[ref] ??= emptyMember());
}

function addStep(c: CouncilStepCounts, step: CouncilStep): void {
  if (step.status === 'skipped') {
    c.skipped++;
    return;
  }
  c.runs++;
  if (step.status === 'done') c.done++;
  else if (step.status === 'limited') c.limited++;
  else if (step.status === 'cancelled') c.cancelled++;
  else c.errors++;
  if (step.startedAt && step.endedAt) c.durationMs += Math.max(0, step.endedAt - step.startedAt);
  c.inputTokens += num(step.usage?.inputTokens);
  c.outputTokens += num(step.usage?.outputTokens);
}

export function getStats(): CouncilStats {
  return load();
}

/** Called once when a council step finishes (any status). */
export function recordStep(step: CouncilStep, _run: CouncilRun): void {
  const m = member(step.member);
  addStep(m, step);
  addStep((m.byRole[step.role] ??= emptyCounts()), step);
  if (step.status === 'done') {
    if (step.role === 'reviewer') m.reviewer[reviewVerdict(step.output ?? '')]++;
    if (step.role === 'voter' && step.output) {
      m.voter.answers++;
      m.voter.answerChars += step.output.length;
    }
  }
  save();
}

/** Called at the end of a plan → build → review run with the reviewer's final verdict. */
export function recordBuildOutcome(run: CouncilRun, verdict: 'approve' | 'changes' | 'unknown'): void {
  if (verdict === 'unknown') return;
  const builds = run.steps.filter((s) => s.role === 'builder' && s.status === 'done');
  const builder = builds.at(-1);
  if (!builder) return;
  const b = member(builder.member).builder;
  if (verdict === 'changes') b.changesRequested++;
  else if (builds.length > 1) b.approvedAfterFixes++;
  else b.approvedFirst++;
  save();
}

/** Hook for blind peer review: `rank` is 1-based within a field of `of` answers. */
export function recordPeerRanking(ref: CouncilMemberRef, rank: number, of: number): void {
  if (!(rank >= 1 && of >= rank)) return;
  const p = member(ref).peerRanking;
  p.count++;
  p.rankSum += rank;
  p.ofSum += of;
  save();
}

export function resetStats(): void {
  cache = emptyStats();
  save();
}

function reviewVerdict(output: string): 'approve' | 'changes' | 'none' {
  const v = parseVerdict(output);
  return v === 'unknown' ? 'none' : v;
}
