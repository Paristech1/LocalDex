import path from 'node:path';
import { unzipSync } from 'fflate';
import type { SkillImportResult } from '@localdex/shared';
import { installAll, LIMITS, sanitizeName, type IncomingSkill } from './store.js';

const SKILL_FILE = /(^|\/)skill\.md$/i;
const SKIP_SEG = new Set(['.git', 'node_modules', '__MACOSX', '.DS_Store', '.github']);
const MAX_ROOT_DEPTH = 6;

function skippable(rel: string): boolean {
  return rel.split('/').some((s) => SKIP_SEG.has(s));
}

function cleanRel(rel: string): string | null {
  const n = path.posix.normalize(rel.replace(/\\/g, '/')).replace(/^\/+/, '');
  if (!n || n === '.' || n === '..' || n.startsWith('../') || n.includes('/../')) return null;
  return n;
}

/**
 * Given a flat tree of files, find every skill (a folder with SKILL.md) and bundle each folder's contents.
 * The shallowest SKILL.md wins, so a skill's own bundled examples are not mistaken for separate skills.
 */
export function skillsFromTree(tree: Map<string, Buffer>, source: string, rootName: string, subPath = ''): IncomingSkill[] {
  const prefix = subPath ? subPath.replace(/^\/+|\/+$/g, '') + '/' : '';
  const roots: string[] = [];
  for (const rel of tree.keys()) {
    if (!rel.startsWith(prefix) || skippable(rel) || !SKILL_FILE.test(rel)) continue;
    const dir = path.posix.dirname(rel);
    const root = dir === '.' ? '' : dir;
    if (root.split('/').length > MAX_ROOT_DEPTH) continue;
    roots.push(root);
  }
  const unique = [...new Set(roots)].sort((a, b) => a.length - b.length);
  const chosen: string[] = [];
  for (const r of unique) if (!chosen.some((c) => c === '' ? true : r === c || r.startsWith(c + '/'))) chosen.push(r);

  return chosen.map((root) => {
    const files = new Map<string, Buffer>();
    const base = root ? root + '/' : '';
    for (const [rel, buf] of tree) {
      if (!rel.startsWith(base) || skippable(rel)) continue;
      const inner = rel.slice(base.length);
      // normalise the entry file name to SKILL.md
      files.set(SKILL_FILE.test('/' + inner) && !inner.includes('/') ? 'SKILL.md' : inner, buf);
    }
    const leaf = root ? path.posix.basename(root) : rootName;
    return { fallbackName: sanitizeName(leaf) || 'skill', files, source };
  });
}

/** Files the browser sent (dropped folder, loose files, or a single .zip). */
export function importFromUpload(entries: { path: string; data: Buffer }[]): SkillImportResult {
  if (!entries.length) return { ok: false, added: [], updated: [], skipped: [], error: 'Nothing was uploaded.' };
  let total = 0;
  for (const e of entries) total += e.data.length;
  if (total > LIMITS.maxUploadBytes) return { ok: false, added: [], updated: [], skipped: [], error: `Upload is bigger than ${LIMITS.maxUploadBytes / 1024 / 1024}MB.` };

  const isZip = (e: { path: string; data: Buffer }) => /\.zip$/i.test(e.path) || (e.data[0] === 0x50 && e.data[1] === 0x4b && e.data[2] === 0x03);
  const skills: IncomingSkill[] = [];

  for (const z of entries.filter(isZip)) {
    try {
      const tree = unzipToTree(z.data, () => true);
      const found = skillsFromTree(tree, 'upload', path.posix.basename(z.path).replace(/\.zip$/i, ''));
      skills.push(...found);
    } catch (e) {
      return { ok: false, added: [], updated: [], skipped: [], error: `Could not read ${z.path}: ${(e as Error).message}` };
    }
  }

  const loose = entries.filter((e) => !isZip(e));
  if (loose.length) {
    const tree = new Map<string, Buffer>();
    for (const e of loose) {
      const rel = cleanRel(e.path);
      if (rel && !skippable(rel)) tree.set(rel, e.data);
    }
    const found = skillsFromTree(tree, 'upload', 'skill');
    if (found.length) skills.push(...found);
    else if (loose.length === 1 && /\.(md|markdown|txt)$/i.test(loose[0].path)) {
      // A single markdown file that is not called SKILL.md: treat it as the skill itself.
      const base = path.posix.basename(loose[0].path).replace(/\.(md|markdown|txt)$/i, '');
      skills.push({ fallbackName: sanitizeName(base) || 'skill', files: new Map([['SKILL.md', loose[0].data]]), source: 'upload' });
    }
  }
  return installAll(skills);
}

function unzipToTree(data: Uint8Array, want: (name: string) => boolean): Map<string, Buffer> {
  let budget = LIMITS.maxUploadBytes * 2;
  const files = unzipSync(data, {
    filter(f) {
      if (f.name.endsWith('/')) return false;
      const rel = cleanRel(f.name);
      if (!rel || skippable(rel) || !want(rel)) return false;
      if (f.originalSize > LIMITS.maxFileBytes) return false; // oversized files are skipped, not extracted
      budget -= f.originalSize;
      if (budget < 0) throw new Error('archive expands to too much data');
      return true;
    },
  });
  const tree = new Map<string, Buffer>();
  for (const [name, bytes] of Object.entries(files)) {
    const rel = cleanRel(name);
    if (rel) tree.set(rel, Buffer.from(bytes));
  }
  return tree;
}

// ---------- GitHub ----------

export interface GithubRef {
  owner: string;
  repo: string;
  /** Tree path segments after /tree/ or /blob/ (ref first, then subpath), or empty for the default branch. */
  rest: string[];
  isBlob: boolean;
}

export function parseGithubUrl(input: string): GithubRef | null {
  let s = input.trim().replace(/\.git$/, '');
  if (/^[\w.-]+\/[\w.-]+(\/.*)?$/.test(s) && !/^https?:/i.test(s)) s = 'https://github.com/' + s;
  if (/^github\.com\//i.test(s)) s = 'https://' + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !/^(www\.)?github\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2) return null;
  const [owner, repoRaw, kind, ...rest] = parts;
  const repo = repoRaw.replace(/\.git$/, '');
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  if (kind && kind !== 'tree' && kind !== 'blob') return { owner, repo, rest: [], isBlob: false };
  return { owner, repo, rest: kind ? rest : [], isBlob: kind === 'blob' };
}

/** Overridable so tests (or a GitHub Enterprise-style mirror) can point somewhere else. */
const ZIP_BASE = process.env.LOCALDEX_GITHUB_ZIP_BASE || 'https://codeload.github.com';

async function download(url: string, maxBytes: number): Promise<Buffer | 'notfound'> {
  const res = await fetch(url, { headers: { 'user-agent': 'LocalDex' }, signal: AbortSignal.timeout(90_000), redirect: 'follow' });
  if (res.status === 404) return 'notfound';
  if (!res.ok) throw new Error(`GitHub returned ${res.status} ${res.statusText}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new Error(`The repository download is ${(len / 1024 / 1024).toFixed(0)}MB, over the ${maxBytes / 1024 / 1024}MB limit.`);
  const chunks: Buffer[] = [];
  let got = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    got += chunk.length;
    if (got > maxBytes) throw new Error(`The repository download is over the ${maxBytes / 1024 / 1024}MB limit.`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function importFromGithub(input: string): Promise<SkillImportResult> {
  const fail = (error: string): SkillImportResult => ({ ok: false, added: [], updated: [], skipped: [], error });
  const ref = parseGithubUrl(input);
  if (!ref) return fail('That does not look like a GitHub link. Use https://github.com/owner/repo (or a /tree/branch/folder link).');

  // Branch names can contain slashes, so try the longest-unambiguous guesses: first segment, then first two, ...
  const attempts: { ref: string; sub: string }[] = [];
  if (!ref.rest.length) attempts.push({ ref: 'HEAD', sub: '' });
  else for (let i = 1; i <= Math.min(ref.rest.length, 4); i++) attempts.push({ ref: ref.rest.slice(0, i).join('/'), sub: ref.rest.slice(i).join('/') });

  let zip: Buffer | null = null;
  let sub = '';
  let usedRef = '';
  try {
    for (const a of attempts) {
      const r = await download(`${ZIP_BASE}/${ref.owner}/${ref.repo}/zip/${a.ref === 'HEAD' ? 'HEAD' : encodeURI(a.ref)}`, 100 * 1024 * 1024);
      if (r !== 'notfound') {
        zip = r;
        sub = a.sub;
        usedRef = a.ref;
        break;
      }
    }
  } catch (e) {
    return fail(`Could not download from GitHub: ${(e as Error).message}`);
  }
  if (!zip) return fail(`Could not find ${ref.owner}/${ref.repo}${ref.rest.length ? ` at "${ref.rest.join('/')}"` : ''}. Private repos are not supported; check the link is public.`);

  // GitHub zips wrap everything in "<repo>-<ref>/"; strip that wrapper.
  let tree: Map<string, Buffer>;
  try {
    // Pass 1 needs names only: decompress just SKILL.md files to find the roots cheaply, then pull the folders we need.
    const probe = unzipToTree(zip, (rel) => SKILL_FILE.test(rel));
    const wrapper = [...probe.keys()][0]?.split('/')[0] ?? '';
    const roots = new Set<string>();
    const subFull = (sub ? `${wrapper}/${sub}`.replace(/\/+$/, '') : wrapper) + '/';
    for (const rel of probe.keys()) {
      if (!rel.startsWith(subFull) && rel + '/' !== subFull && !(ref.isBlob && rel === `${wrapper}/${sub}`)) continue;
      const dir = path.posix.dirname(rel);
      roots.add(dir);
    }
    if (!roots.size) {
      return fail(`No SKILL.md found in ${ref.owner}/${ref.repo}${sub ? '/' + sub : ''}. A skill is a folder containing a SKILL.md file.`);
    }
    const rootList = [...roots].sort((a, b) => a.length - b.length);
    tree = unzipToTree(zip, (rel) => rootList.some((r) => rel === r || rel.startsWith(r + '/')));
    const stripped = new Map<string, Buffer>();
    for (const [rel, buf] of tree) stripped.set(wrapper && rel.startsWith(wrapper + '/') ? rel.slice(wrapper.length + 1) : rel, buf);
    const subRel = sub.replace(/\/+$/, '');
    const subIsFile = ref.isBlob && SKILL_FILE.test(subRel);
    const effectiveSub = subIsFile ? (path.posix.dirname(subRel) === '.' ? '' : path.posix.dirname(subRel)) : subRel;
    const source = `https://github.com/${ref.owner}/${ref.repo}${usedRef !== 'HEAD' || effectiveSub ? `/tree/${usedRef}${effectiveSub ? '/' + effectiveSub : ''}` : ''}`;
    const rootName = effectiveSub ? path.posix.basename(effectiveSub) : ref.repo;
    return installAllFromTree(stripped, source, rootName, effectiveSub);
  } catch (e) {
    return fail(`Could not read the repository: ${(e as Error).message}`);
  }
}

function installAllFromTree(tree: Map<string, Buffer>, source: string, rootName: string, sub: string): SkillImportResult {
  return installAll(skillsFromTree(tree, source, rootName, sub));
}
