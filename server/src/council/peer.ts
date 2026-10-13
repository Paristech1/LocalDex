import type { CouncilMemberRef, CouncilPeerRank } from '@localdex/shared';

/** Blind peer review helpers (pure): anonymize answers, parse "RANKING: B > A > C", aggregate with a Borda count. */

export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const NAMES = 'claude(?:[ -]code)?|codex(?:[ -]cli)?|gemini(?:[ -]cli)?|cursor|anthropic|openai|google|local(?: model)?';

/**
 * Strip obvious self-identification so reviewers can't tell whose answer is whose:
 * "(claude)" / "[Codex]" tags, "— Gemini" sign-offs, "As Claude, …" / "I'm Codex." at the start of a line.
 * Mentions of a vendor as a subject ("the Claude API") are left alone.
 */
export function anonymize(text: string): string {
  return text
    .replace(new RegExp(`\\s*[([]\\s*(?:${NAMES})\\s*[)\\]]`, 'gi'), '')
    .replace(new RegExp(`^\\s*(?:[-–—~]+|signed,?|regards,?)\\s*(?:${NAMES})\\s*\\.?\\s*$`, 'gim'), '')
    .replace(new RegExp(`^(\\s*)(?:as|i am|i'm|this is)\\s+(?:${NAMES})\\s*[,:.]\\s*`, 'gim'), '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Random permutation (Fisher–Yates), so each reviewer sees the answers in its own order. */
export function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Read the last "RANKING:" line of a review. Tolerates case, markdown, "Response B", commas, ">" or spaces,
 * and a ranking on the line after the label. Unknown and repeated letters are dropped; a ranking that names
 * only some answers is returned as-is (partial). Returns null when there is no usable ranking.
 */
export function parseRanking(review: string, count: number): string[] | null {
  const valid = LETTERS.slice(0, Math.max(0, Math.min(count, LETTERS.length)));
  const lines = review.replace(/[*_`#]/g, '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/\branking\s*[:=–—-]\s*(.*)$/i);
    if (!m) continue;
    const body = m[1].trim() || lines[i + 1] || '';
    const out: string[] = [];
    for (const t of body.replace(/\bresponses?\b/gi, ' ').matchAll(/(?<![A-Za-z])([A-Za-z])(?![A-Za-z])/g)) {
      const letter = t[1].toUpperCase();
      if (valid.includes(letter) && !out.includes(letter)) out.push(letter);
    }
    if (out.length) return out;
  }
  return null;
}

export interface PeerBallot {
  /** Who wrote the review. */
  reviewer: CouncilMemberRef;
  /** Answer authors, best first (possibly partial). */
  order: CouncilMemberRef[];
}

/**
 * Borda count: in a field of n answers, 1st place earns n-1 points, 2nd n-2, …; answers a ballot leaves out earn nothing.
 * Reviewers rank their own answer too (they can't tell which one it is); `selfRank` shows where they put it.
 * Ties fall back to average rank, then to the original answer order.
 */
export function aggregateRanking(members: CouncilMemberRef[], ballots: PeerBallot[]): CouncilPeerRank[] {
  const n = members.length;
  const score = new Map<CouncilMemberRef, { points: number; rankSum: number; votes: number; selfRank?: number }>();
  for (const m of members) score.set(m, { points: 0, rankSum: 0, votes: 0 });
  for (const b of ballots) {
    b.order.forEach((m, i) => {
      const s = score.get(m);
      if (!s) return;
      s.points += n - 1 - i;
      s.rankSum += i + 1;
      s.votes++;
      if (m === b.reviewer) s.selfRank = i + 1;
    });
  }
  return members
    .map((member, idx) => ({ member, idx, ...score.get(member)! }))
    .filter((s) => s.votes > 0)
    .map((s) => ({ ...s, avgRank: Math.round((s.rankSum / s.votes) * 100) / 100 }))
    .sort((a, b) => b.points - a.points || a.avgRank - b.avgRank || a.idx - b.idx)
    .map(({ member, avgRank, votes, selfRank }) => (selfRank ? { member, avgRank, votes, selfRank } : { member, avgRank, votes }));
}

const ORD = ['1st', '2nd', '3rd'];
export const ordinal = (i: number) => ORD[i] ?? `${i + 1}th`;

/** For the judge (names revealed): "Advisers ranked the answers blind (Borda count): 1st Codex avg 1.3 (3 votes) …". */
export function rankingForJudge(ranking: CouncilPeerRank[], label: (m: CouncilMemberRef) => string): string {
  const parts = ranking.map((r, i) => `${ordinal(i)} ${label(r.member)}, avg rank ${r.avgRank.toFixed(1)} (${r.votes} vote${r.votes === 1 ? '' : 's'})`);
  return `Advisers ranked the answers blind, without knowing whose was whose (Borda count, 1 = best): ${parts.join('; ')}.`;
}

/** Short line under the verdict: "Peer ranking: 1. Codex (1.3) · 2. Claude (1.7) · 3. Gemini (3.0)". */
export function rankingLine(ranking: CouncilPeerRank[], label: (m: CouncilMemberRef) => string): string {
  return `Peer ranking (blind): ${ranking.map((r, i) => `${i + 1}. ${label(r.member)} (avg ${r.avgRank.toFixed(1)})`).join(' · ')}`;
}
