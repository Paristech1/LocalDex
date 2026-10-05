import type { SkillImportResult } from '@localdex/shared';

export interface UploadEntry {
  file: File;
  path: string;
}

const SKIP = new Set(['.git', 'node_modules', '__MACOSX', '.DS_Store', '.github']);
const MAX_FILES = 3000;

/** Walk a drop (files and/or whole folders) into a flat list with relative paths. */
export async function collectDropped(dt: DataTransfer): Promise<UploadEntry[]> {
  const out: UploadEntry[] = [];
  const roots = Array.from(dt.items ?? [])
    .map((i) => (i.kind === 'file' ? (i as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() ?? null : null))
    .filter((e): e is FileSystemEntry => !!e);

  if (!roots.length) {
    for (const f of Array.from(dt.files)) out.push({ file: f, path: f.name });
    return out;
  }

  const readAll = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> =>
    new Promise((resolve, reject) => {
      const all: FileSystemEntry[] = [];
      const next = (): void =>
        reader.readEntries((batch) => {
          if (!batch.length) return resolve(all);
          all.push(...batch);
          next();
        }, reject);
      next();
    });

  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (out.length >= MAX_FILES || SKIP.has(entry.name)) return;
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: prefix + entry.name });
    } else if (entry.isDirectory) {
      const children = await readAll((entry as FileSystemDirectoryEntry).createReader());
      for (const c of children) await walk(c, prefix + entry.name + '/');
    }
  };
  for (const r of roots) await walk(r, '');
  return out;
}

/** Entries from a hidden <input type=file> (webkitdirectory gives webkitRelativePath). */
export function fromInput(files: FileList | null): UploadEntry[] {
  return Array.from(files ?? [])
    .map((f) => ({ file: f, path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name }))
    .filter((e) => !e.path.split('/').some((s) => SKIP.has(s)));
}

const fail = (error: string): SkillImportResult => ({ ok: false, added: [], updated: [], skipped: [], error });

export async function uploadSkills(entries: UploadEntry[]): Promise<SkillImportResult> {
  if (!entries.length) return fail('Nothing to upload.');
  const total = entries.reduce((n, e) => n + e.file.size, 0);
  if (total > 60 * 1024 * 1024) return fail('That is more than 60MB. Drop just the skill folder, not the whole repo (or paste the GitHub link instead).');
  const form = new FormData();
  for (const e of entries) form.append('files', e.file, e.file.name);
  form.append('paths', JSON.stringify(entries.map((e) => e.path)));
  try {
    const res = await fetch('/api/skills/upload', { method: 'POST', body: form });
    return (await res.json()) as SkillImportResult;
  } catch (e) {
    return fail(`Upload failed: ${(e as Error).message}`);
  }
}

export async function importGithub(url: string): Promise<SkillImportResult> {
  try {
    const res = await fetch('/api/skills/github', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
    return (await res.json()) as SkillImportResult;
  } catch (e) {
    return fail(`Import failed: ${(e as Error).message}`);
  }
}

export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  await fetch(`/api/skills/${encodeURIComponent(name)}/enabled`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
}

export async function removeSkill(name: string): Promise<void> {
  await fetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export function summarize(r: SkillImportResult): string {
  if (!r.ok) return r.error ?? 'Import failed.';
  const parts: string[] = [];
  if (r.added.length) parts.push(`Added ${r.added.length}: ${r.added.slice(0, 6).join(', ')}${r.added.length > 6 ? '…' : ''}`);
  if (r.updated.length) parts.push(`Updated ${r.updated.length}: ${r.updated.slice(0, 6).join(', ')}${r.updated.length > 6 ? '…' : ''}`);
  if (r.skipped.length) parts.push(`Skipped ${r.skipped.length} (${r.skipped.map((s) => `${s.name}: ${s.reason}`).join('; ')})`);
  return parts.join('. ');
}
