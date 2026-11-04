// E1: MCP preset gallery. The browser can only name a gallery entry; the command, args and env come from this
// file on the server, so the WebSocket still can't make LocalDex run an arbitrary program.
// Pattern from DeepSeek Harness packages/mcp/mcp-manager (add / probe / observe servers at runtime), reimplemented.
import type { McpGalleryEntry, McpServerConfig } from '@localdex/shared';
import { DEFAULT_SETTINGS } from '@localdex/shared';
import { getSettings, updateSettings } from '../config.js';
import { approvedFolders } from '../tools/permissions.js';

interface GallerySpec extends Omit<McpGalleryEntry, 'config' | 'installed'> {
  /** Built when the user adds it (e.g. the filesystem server gets the approved folders as arguments). */
  build(): McpServerConfig;
}

const GALLERY: GallerySpec[] = [
  {
    id: 'playwright',
    name: 'playwright',
    title: 'Playwright (browser)',
    description: 'Open web pages, read them as a text outline, click and type. Uses your installed Chrome with its sandbox on.',
    needs: 'Node 20+ and Google Chrome. The first start downloads the server with npx.',
    homepage: 'https://github.com/microsoft/playwright-mcp',
    build: () => ({ ...DEFAULT_SETTINGS.mcpServers.playwright, enabled: true }),
  },
  {
    id: 'blender',
    name: 'blender',
    title: 'Blender',
    description: 'Read the open Blender scene and run Python inside Blender. Every call asks first, because execute_blender_code can do anything Blender can.',
    needs: 'uv (`brew install uv`), Blender with the blender-mcp add-on installed and its server started (Blender sidebar → BlenderMCP → Connect).',
    homepage: 'https://github.com/ahujasid/blender-mcp',
    build: () => ({
      command: 'uvx',
      args: ['blender-mcp@2.0.0'],
      enabled: true,
      allowTools: ['get_scene_info', 'get_object_info', 'execute_blender_code'],
      approval: 'always',
      timeoutSeconds: 120,
      maxOutputChars: 12000,
      hint: 'Blender: read the scene with get_scene_info / get_object_info before changing anything; execute_blender_code runs Python in Blender (keep scripts small, one change at a time).',
    }),
  },
  {
    id: 'filesystem',
    name: 'filesystem',
    title: 'Filesystem (read-only)',
    description: 'The reference MCP filesystem server, limited to your approved folders and to its read-only tools. Mostly useful for workers or for models that know this server.',
    needs: 'Node 20+. The first start downloads the server with npx.',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    build: () => ({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem@2.1.0', ...approvedFolders()],
      enabled: true,
      allowTools: ['read_text_file', 'list_directory', 'directory_tree', 'search_files', 'get_file_info'],
      approval: 'once',
      timeoutSeconds: 60,
      maxOutputChars: 12000,
    }),
  },
  {
    id: 'github',
    name: 'github',
    title: 'GitHub (read-only)',
    description: "GitHub's official MCP server in read-only mode: repositories, issues and pull requests.",
    needs: 'The github-mcp-server binary on your PATH (GitHub releases or `brew install github-mcp-server`) and GITHUB_PERSONAL_ACCESS_TOKEN set in the environment LocalDex starts from. The token is passed to this server only.',
    homepage: 'https://github.com/github/github-mcp-server',
    build: () => ({
      command: 'github-mcp-server',
      args: ['stdio', '--read-only', '--toolsets', 'repos,issues,pull_requests'],
      enabled: true,
      inheritEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN', 'HTTPS_PROXY'],
      approval: 'once',
      timeoutSeconds: 60,
      maxOutputChars: 12000,
      hint: 'GitHub: read-only access to repositories, issues and pull requests.',
    }),
  },
];

/** Gallery entries with the exact config they would add, and whether a server of that name already exists. */
export function mcpGallery(): McpGalleryEntry[] {
  const have = getSettings().mcpServers ?? {};
  return GALLERY.map(({ build, ...e }) => ({ ...e, config: build(), installed: !!have[e.name] }));
}

/**
 * Add a gallery server to config.json. `confirmName` must equal the server name (the user typed it in the confirm
 * dialog). An existing server of the same name is enabled, never overwritten (its config may be hand-edited).
 */
export function addFromGallery(id: string, confirmName: string): { ok: boolean; message: string } {
  const spec = GALLERY.find((g) => g.id === id);
  if (!spec) return { ok: false, message: `Unknown gallery entry "${id}".` };
  if (confirmName.trim() !== spec.name) return { ok: false, message: `Type "${spec.name}" to confirm.` };
  const servers = { ...(getSettings().mcpServers ?? {}) };
  if (servers[spec.name]) {
    servers[spec.name] = { ...servers[spec.name], enabled: true };
    updateSettings({ mcpServers: servers });
    return { ok: true, message: `"${spec.name}" already existed; it is switched on (its config was not changed).` };
  }
  servers[spec.name] = spec.build();
  updateSettings({ mcpServers: servers });
  return { ok: true, message: `Added "${spec.name}". Starting it now…` };
}

/** Which of the server's own tools the model sees. Only names the server actually offers are accepted. */
export function setAllowTools(name: string, allowTools: string[], available: string[]): { ok: boolean; message: string } {
  const servers = { ...(getSettings().mcpServers ?? {}) };
  const cfg = servers[name];
  if (!cfg) return { ok: false, message: `No MCP server named "${name}".` };
  const offered = new Set(available);
  const unknown = allowTools.filter((t) => !offered.has(t));
  if (unknown.length) return { ok: false, message: `The server does not offer: ${unknown.join(', ')}.` };
  if (!allowTools.length) return { ok: false, message: 'Pick at least one tool, or switch the server off.' };
  servers[name] = { ...cfg, allowTools: [...new Set(allowTools)] };
  updateSettings({ mcpServers: servers });
  return { ok: true, message: `${name}: ${allowTools.length} tool${allowTools.length === 1 ? '' : 's'} exposed.` };
}

/** Remove a server from config.json (removing only ever takes capability away). */
export function removeServer(name: string): { ok: boolean; message: string } {
  const servers = { ...(getSettings().mcpServers ?? {}) };
  if (!servers[name]) return { ok: false, message: `No MCP server named "${name}".` };
  delete servers[name];
  updateSettings({ mcpServers: servers });
  return { ok: true, message: `Removed "${name}".` };
}
