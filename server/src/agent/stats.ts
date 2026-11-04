import type { Session, StepStat } from '@localdex/shared';

/** Steps kept per session for the Stats tab. */
export const MAX_STATS = 300;

export function recordStep(session: Session, stat: StepStat): void {
  const list = (session.stats ??= []);
  list.push(stat);
  if (list.length > MAX_STATS) list.splice(0, list.length - MAX_STATS);
}

export interface StatsSummary {
  steps: number;
  promptTokens: number;
  completionTokens: number;
  /** Median time to first token over steps that streamed, ms. */
  ttftMedianMs: number | null;
  /** Output speed over steps with ≥ 8 completion tokens: completion tokens / (modelMs − ttft). */
  tokensPerSecond: number | null;
  modelMs: number;
  toolMs: number;
}

/** Aggregates for the Stats tab header; the client computes the same from session.stats, this is for tests and logs. */
export function summarize(stats: StepStat[]): StatsSummary {
  const ttfts = stats.map((s) => s.ttftMs).filter((v): v is number => v !== null).sort((a, b) => a - b);
  let tokens = 0;
  let genMs = 0;
  for (const s of stats) {
    if (s.completionTokens >= 8 && s.ttftMs !== null && s.modelMs > s.ttftMs) {
      tokens += s.completionTokens;
      genMs += s.modelMs - s.ttftMs;
    }
  }
  return {
    steps: stats.length,
    promptTokens: stats.reduce((n, s) => n + s.promptTokens, 0),
    completionTokens: stats.reduce((n, s) => n + s.completionTokens, 0),
    ttftMedianMs: ttfts.length ? ttfts[Math.floor(ttfts.length / 2)] : null,
    tokensPerSecond: genMs > 0 ? Math.round((tokens / genMs) * 1000 * 10) / 10 : null,
    modelMs: stats.reduce((n, s) => n + s.modelMs, 0),
    toolMs: stats.reduce((n, s) => n + s.toolMs, 0),
  };
}
