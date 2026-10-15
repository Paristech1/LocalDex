// First-run setup helpers: find local model servers, install a council member's CLI, make a playground folder.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MEMBER_NPM_PACKAGES, type LocalServerScan, type MemberId } from '@localdex/shared';
import { getSettings } from './config.js';
import { probeModels, type LocalServerKind } from './lmstudio.js';
import { memberEnv, npmCommand, resetNpmBinCache } from './council/proc.js';

/** Well-known local servers, checked on every scan. Each speaks the OpenAI API under /v1. */
const KNOWN_SERVERS: Array<{ baseUrl: string; label: string }> = [
  { baseUrl: 'http://localhost:1234/v1', label: 'LM Studio' },
  { baseUrl: 'http://localhost:11434/v1', label: 'Ollama' },
];

const KIND_LABEL: Record<LocalServerKind, string> = { lmstudio: 'LM Studio', ollama: 'Ollama', openai: 'Local server' };

export function normalizeBaseUrl(u: string): string {
  let s = u.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  // Accept "localhost:1234" as well as ".../v1".
  if (!/\/v\d+$/.test(s)) s = `${s}/v1`;
  return s.replace('://127.0.0.1', '://localhost');
}

/**
 * Check the configured server, the well-known ones and an optional extra URL, in parallel.
 * Returns one entry per distinct URL; servers that answered come first, the configured one first among them.
 */
export async function scanLocalServers(extra?: string): Promise<LocalServerScan[]> {
  const current = normalizeBaseUrl(getSettings().baseUrl);
  const wanted = new Map<string, string | undefined>();
  wanted.set(current, undefined);
  for (const k of KNOWN_SERVERS) if (!wanted.has(normalizeBaseUrl(k.baseUrl))) wanted.set(normalizeBaseUrl(k.baseUrl), k.label);
  if (extra?.trim()) {
    const u = normalizeBaseUrl(extra);
    if (!wanted.has(u)) wanted.set(u, undefined);
  }
  const results = await Promise.all(
    [...wanted].map(async ([baseUrl, label]): Promise<LocalServerScan> => {
      try {
        const r = await probeModels(baseUrl, 2500);
        return { baseUrl, label: r.kind === 'openai' ? (label ?? KIND_LABEL.openai) : KIND_LABEL[r.kind], kind: r.kind, ok: true, models: r.models, current: baseUrl === current };
      } catch (e) {
        const known = KNOWN_SERVERS.find((k) => normalizeBaseUrl(k.baseUrl) === baseUrl);
        return { baseUrl, label: label ?? known?.label ?? KIND_LABEL.openai, kind: 'openai', ok: false, models: [], error: shortError(e), current: baseUrl === current };
      }
    }),
  );
  return results.sort((a, b) => Number(b.ok) - Number(a.ok) || Number(b.current) - Number(a.current));
}

function shortError(e: unknown): string {
  const err = e as Error & { cause?: { code?: string } };
  if (err.cause?.code === 'ECONNREFUSED') return 'not running';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'no answer';
  return (err.message || String(e)).slice(0, 160);
}

let installing: MemberId | null = null;

/**
 * `npm install -g <the vendor's official package>` for a CLI member. Only the fixed packages in
 * MEMBER_NPM_PACKAGES can be installed this way; nothing from the request reaches the command line.
 */
export function installMember(member: MemberId): Promise<{ ok: boolean; output: string }> {
  const pkg = MEMBER_NPM_PACKAGES[member];
  if (!pkg) return Promise.resolve({ ok: false, output: `${member} is not installed with npm.` });
  if (installing) return Promise.resolve({ ok: false, output: `Already installing ${installing}. Try again when it finishes.` });
  installing = member;
  return new Promise((resolve) => {
    let output = '';
    const npm = npmCommand();
    // Keep PATH so npm finds node; never pass API keys along (memberEnv drops them).
    const child = spawn(npm, ['install', '-g', '--no-audit', '--no-fund', pkg], {
      env: memberEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60_000);
    const add = (c: Buffer) => {
      output = (output + c.toString('utf8')).slice(-6000);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const finish = (ok: boolean, extra = '') => {
      clearTimeout(timer);
      installing = null;
      resetNpmBinCache();
      resolve({ ok, output: (output + extra).trim() });
    };
    child.on('error', (e) => finish(false, `\n${e.message}`));
    child.on('close', (code) => finish(code === 0));
  });
}

/** A fresh folder for trying LocalDex out: ~/LocalDex Playground (created if needed). */
export function ensurePlayground(): string {
  const dir = path.join(os.homedir(), 'LocalDex Playground');
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      '# LocalDex Playground\n\nA scratch folder for trying things with LocalDex. Ask the agent to build something here; nothing outside this folder is touched.\n',
    );
  }
  return dir;
}
