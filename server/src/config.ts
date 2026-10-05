import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_SETTINGS, DEFAULT_CAPABILITIES, type Settings } from '@localdex/shared';

export const DATA_DIR = process.env.LOCALDEX_HOME ?? path.join(os.homedir(), '.localdex');
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

let settings: Settings = load();

function load(): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      capabilities: { ...DEFAULT_CAPABILITIES, ...(raw.capabilities ?? {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function getSettings(): Settings {
  return settings;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  settings = {
    ...settings,
    ...patch,
    capabilities: { ...settings.capabilities, ...(patch.capabilities ?? {}) },
  };
  if (patch.approvedFolders) {
    settings.approvedFolders = Array.from(
      new Set(patch.approvedFolders.map((f) => path.resolve(expandHome(f)))),
    );
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(settings, null, 2));
  return settings;
}

/**
 * Apply enable/disable toggles for MCP servers that already exist in config.json.
 * Commands, args and env are deliberately NOT changeable from the UI/WebSocket: they run programs on this machine,
 * so they can only be edited in ~/.localdex/config.json.
 */
export function applyMcpToggles(toggles: Record<string, { enabled?: boolean }>): Settings {
  const next = { ...settings.mcpServers };
  for (const [name, t] of Object.entries(toggles ?? {})) {
    if (next[name] && typeof t?.enabled === 'boolean') next[name] = { ...next[name], enabled: t.enabled };
  }
  settings = { ...settings, mcpServers: next };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(settings, null, 2));
  return settings;
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
