import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DEFAULT_COUNCIL,
  DEFAULT_SETTINGS,
  DEFAULT_CAPABILITIES,
  MEMBER_IDS,
  type CouncilSettings,
  type Settings,
} from '@localdex/shared';

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
      council: mergeCouncil(DEFAULT_COUNCIL, raw.council),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Deep-merge a (partial) council patch so older config files and partial UI patches keep every field. */
export function mergeCouncil(base: CouncilSettings, patch: Partial<CouncilSettings> | undefined): CouncilSettings {
  if (!patch) return base;
  const members = { ...base.members };
  for (const id of MEMBER_IDS) {
    if (patch.members?.[id]) members[id] = { ...base.members[id], ...patch.members[id] };
  }
  return {
    ...base,
    ...patch,
    members,
    roles: { ...base.roles, ...(patch.roles ?? {}) },
  };
}

/**
 * Settings patches from the UI/WebSocket may not change which program a council member runs:
 * like MCP commands, executables can only be set in ~/.localdex/config.json.
 */
export function stripCouncilCommands(patch: Partial<CouncilSettings> | undefined): Partial<CouncilSettings> | undefined {
  if (!patch?.members) return patch;
  const members: Partial<CouncilSettings['members']> = {};
  for (const id of MEMBER_IDS) {
    const m = patch.members[id];
    if (!m) continue;
    const { command: _drop, ...rest } = m;
    members[id] = { ...rest, command: settings.council.members[id]?.command } as CouncilSettings['members'][typeof id];
  }
  return { ...patch, members: members as CouncilSettings['members'] };
}

export function getSettings(): Settings {
  return settings;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  settings = {
    ...settings,
    ...patch,
    capabilities: { ...settings.capabilities, ...(patch.capabilities ?? {}) },
    council: mergeCouncil(settings.council, patch.council),
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
