// A6: @file mentions. The composer completes paths from the approved folders; on send, mentioned files that exist
// become a short read hint for the model (their content is not inlined, to save context).
// Pattern from DeepSeek Harness context/file-reference + file-reference-local (mention grammar, local completion).
import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { approvedFolders, resolvePath } from './tools/permissions.js';

const IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**', '**/.venv/**', '**/venv/**', '**/__pycache__/**', '**/target/**', '**/.cache/**'];
const MAX_SCAN = 20_000;

let index: { at: number; root: string; files: string[] } | null = null;

function files(root: string): string[] {
  if (index && index.root === root && Date.now() - index.at < 15_000) return index.files;
  const list = fg.sync('**/*', { cwd: root, ignore: IGNORE, onlyFiles: true, dot: false, suppressErrors: true, followSymbolicLinks: false }).slice(0, MAX_SCAN);
  index = { at: Date.now(), root, files: list };
  return list;
}

/** Subsequence match, preferring hits in the file name, consecutive runs and short paths. -1 = no match. */
export function fuzzyScore(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (!q) return 1;
  const base = c.lastIndexOf('/') + 1;
  let score = 0;
  let qi = 0;
  let last = -2;
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] !== q[qi]) continue;
    score += 1 + (i === last + 1 ? 2 : 0) + (i >= base ? 1 : 0) + (i === base || c[i - 1] === '/' || c[i - 1] === '-' || c[i - 1] === '_' || c[i - 1] === '.' ? 2 : 0);
    last = i;
    qi++;
  }
  if (qi < q.length) return -1;
  const name = c.slice(base);
  if (name.startsWith(q)) score += 5;
  if (name.replace(/\.[^.]*$/, '') === q) score += 8; // "button" → Button.tsx

  return score - c.length * 0.01;
}

/** Files under the first approved folder matching `query`, best first (relative paths). Protected files are skipped. */
export function searchFiles(query: string, limit = 20): string[] {
  const root = approvedFolders()[0];
  if (!root) return [];
  return files(root)
    .map((f) => ({ f, s: fuzzyScore(query, f) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit * 3)
    .filter(({ f }) => {
      try {
        resolvePath(f);
        return true;
      } catch {
        return false;
      }
    })
    .slice(0, limit)
    .map((x) => x.f);
}

/** `@path` tokens in a message that name existing files inside the approved folders (absolute paths, deduplicated). */
export function mentionedFiles(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|\s)@((?:[^\s`'"]|\\ )+)/g)) {
    const raw = m[1].replace(/[),.;:!?]+$/, '');
    try {
      const abs = resolvePath(raw);
      if (fs.statSync(abs).isFile()) out.add(abs);
    } catch {
      /* not a file we may read */
    }
  }
  return [...out].slice(0, 20);
}

/** The read hint appended after a message that mentions files. */
export function mentionHint(paths: string[]): string | null {
  if (!paths.length) return null;
  const root = approvedFolders()[0] ?? '';
  const shown = paths.map((p) => (root && p.startsWith(root + path.sep) ? path.relative(root, p) : p));
  return `[context] Files the user mentioned (read them with read_file before relying on them): ${shown.join(', ')}`;
}
