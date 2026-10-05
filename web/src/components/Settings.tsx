import { useEffect, useState } from 'react';
import { ALL_TOOL_NAMES, type Settings, type ShellApprovalMode, type ToolMode } from '@localdex/shared';
import { send, useStore } from '../store';
import { collectDropped, fromInput, importGithub, removeSkill, setSkillEnabled, summarize, uploadSkills, type UploadEntry } from '../skills';
import { Button, Field, Toggle, cx, inputCls } from './ui';

type Tab = 'workspace' | 'model' | 'capabilities' | 'skills' | 'mcp' | 'prompt';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const models = useStore((s) => s.models);
  const [tab, setTab] = useState<Tab>(settings?.approvedFolders.length ? 'model' : 'workspace');
  if (!settings) return null;

  const patch = (p: Partial<Settings>) => send({ type: 'set_settings', patch: p });

  return (
    <div className="fixed inset-0 z-40 bg-black/60 grid place-items-center" onClick={onClose}>
      <div className="w-[760px] max-w-[95vw] h-[600px] max-h-[90vh] bg-ink-900 border border-ink-600 rounded-xl shadow-2xl flex overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <nav className="w-44 border-r border-ink-700 p-2 text-sm">
          <div className="px-2 py-2 font-semibold">Settings</div>
          {(
            [
              ['workspace', 'Workspace'],
              ['model', 'Model & Agent'],
              ['capabilities', 'Capabilities'],
              ['skills', 'Skills'],
              ['mcp', 'MCP Servers'],
              ['prompt', 'Instructions'],
            ] as Array<[Tab, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cx('w-full text-left px-2 py-1.5 rounded-md', tab === id ? 'bg-ink-700 text-ink-100' : 'text-ink-300 hover:bg-ink-800')}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {tab === 'workspace' && <WorkspaceTab settings={settings} patch={patch} />}
            {tab === 'model' && <ModelTab settings={settings} patch={patch} models={models.map((m) => m.id)} />}
            {tab === 'capabilities' && <CapabilitiesTab settings={settings} patch={patch} />}
            {tab === 'skills' && <SkillsTab />}
            {tab === 'mcp' && <McpTab settings={settings} patch={patch} />}
            {tab === 'prompt' && <PromptTab settings={settings} patch={patch} />}
          </div>
          <div className="border-t border-ink-700 px-5 py-3 flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

type TabProps = { settings: Settings; patch: (p: Partial<Settings>) => void };

function WorkspaceTab({ settings, patch }: TabProps) {
  const [manual, setManual] = useState('');
  const [browse, setBrowse] = useState<{ path: string; parent: string; dirs: string[] } | null>(null);
  const [browsing, setBrowsing] = useState(false);

  const load = async (p?: string) => {
    const r = await fetch(`/api/fs/dirs${p ? `?path=${encodeURIComponent(p)}` : ''}`);
    setBrowse(await r.json());
  };
  useEffect(() => {
    if (browsing && !browse) void load();
  }, [browsing, browse]);

  const add = (p: string) => {
    const t = p.trim();
    if (!t) return;
    patch({ approvedFolders: [...settings.approvedFolders, t] });
    setManual('');
  };

  return (
    <>
      <div>
        <h3 className="font-medium">Approved folders</h3>
        <p className="text-xs text-ink-400 mt-1">The agent (and its workers) can only read, write and run commands inside these folders. The first one is the default working directory.</p>
      </div>
      {settings.approvedFolders.length === 0 && <div className="text-xs text-warn bg-warn/10 border border-warn/30 rounded-md px-3 py-2">No folders approved. File and shell tools are blocked until you add one.</div>}
      <ul className="space-y-1">
        {settings.approvedFolders.map((f, i) => (
          <li key={f} className="flex items-center gap-2 text-sm bg-ink-800 rounded-md px-3 py-1.5">
            <span className="font-mono text-xs flex-1 truncate">{f}</span>
            {i === 0 && <span className="text-[10px] text-accent">default</span>}
            {i > 0 && (
              <button type="button" className="text-xs text-ink-400 hover:text-ink-100" title="Make default" onClick={() => patch({ approvedFolders: [f, ...settings.approvedFolders.filter((x) => x !== f)] })}>
                ↑
              </button>
            )}
            <button type="button" className="text-xs text-ink-400 hover:text-danger" onClick={() => patch({ approvedFolders: settings.approvedFolders.filter((x) => x !== f) })}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add(manual);
        }}
      >
        <input className={inputCls} value={manual} onChange={(e) => setManual(e.target.value)} placeholder="/Users/you/projects/my-app  or  ~/projects/my-app" />
        <Button type="submit" variant="primary" disabled={!manual.trim()}>
          Add
        </Button>
        <Button onClick={() => setBrowsing((b) => !b)}>{browsing ? 'Hide' : 'Browse…'}</Button>
      </form>
      {browsing && browse && (
        <div className="border border-ink-600 rounded-md text-sm">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-ink-700 bg-ink-800">
            <button type="button" className="text-ink-300 hover:text-ink-100" onClick={() => load(browse.parent)} title="Up">
              ↰
            </button>
            <span className="font-mono text-xs flex-1 truncate">{browse.path}</span>
            <Button size="sm" variant="primary" onClick={() => add(browse.path)}>
              Approve this folder
            </Button>
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {browse.dirs.length === 0 && <div className="px-3 py-2 text-xs text-ink-400">No subfolders</div>}
            {browse.dirs.map((d) => (
              <button key={d} type="button" className="w-full text-left px-3 py-1 hover:bg-ink-800 font-mono text-xs" onClick={() => load(`${browse.path}/${d}`)}>
                📁 {d}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="pt-2">
        <Field label="Shell command approval" hint="'Dangerous only' prompts for rm -rf, sudo, force-push, curl|sh and similar. 'Always' prompts for every command.">
          <select className={inputCls} value={settings.shellApproval} onChange={(e) => patch({ shellApproval: e.target.value as ShellApprovalMode })}>
            <option value="dangerous">Dangerous only (recommended)</option>
            <option value="always">Always ask</option>
            <option value="never">Never ask</option>
          </select>
        </Field>
      </div>
    </>
  );
}

function ModelTab({ settings, patch, models }: TabProps & { models: string[] }) {
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  return (
    <>
      <h3 className="font-medium">LM Studio</h3>
      <Field label="Base URL" hint="LM Studio → Developer → Start server. Default is http://localhost:1234/v1.">
        <div className="flex gap-2">
          <input className={inputCls} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <Button onClick={() => patch({ baseUrl: baseUrl.trim().replace(/\/+$/, '') })} disabled={baseUrl.trim() === settings.baseUrl}>
            Apply
          </Button>
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Default model">
          <select className={inputCls} value={settings.model ?? ''} onChange={(e) => patch({ model: e.target.value || null })}>
            <option value="">(none)</option>
            {models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
        <Field label="Worker model" hint="Leave as 'same as main' unless LM Studio has JIT loading / multiple models loaded.">
          <select className={inputCls} value={settings.workerModel ?? ''} onChange={(e) => patch({ workerModel: e.target.value || null })}>
            <option value="">same as main</option>
            {models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
        <Field label="Tool call mode" hint="Auto probes the model once. Text mode works with any model: tools are described in the prompt and calls are parsed from the reply.">
          <select className={inputCls} value={settings.toolMode} onChange={(e) => patch({ toolMode: e.target.value as ToolMode })}>
            <option value="auto">Auto-detect (recommended)</option>
            <option value="native">Native (OpenAI tools API)</option>
            <option value="text">Text protocol</option>
          </select>
        </Field>
        <Field label="Temperature">
          <input type="number" step={0.1} min={0} max={2} className={inputCls} value={settings.temperature} onChange={(e) => patch({ temperature: Number(e.target.value) })} />
        </Field>
        <Field label="Max steps per run" hint="Tool-call rounds before the agent pauses.">
          <input type="number" min={1} max={500} className={inputCls} value={settings.maxSteps} onChange={(e) => patch({ maxSteps: Number(e.target.value) })} />
        </Field>
        <Field label="Context length override" hint="0 = use what LM Studio reports. Set this to the context you loaded the model with if auto-detect is wrong.">
          <input type="number" min={0} step={1024} className={inputCls} value={settings.contextLength} onChange={(e) => patch({ contextLength: Number(e.target.value) })} />
        </Field>
        <Field label="Auto-compact at (fraction of context)" hint="0 disables. 0.8 = compact when the prompt reaches 80% of the window.">
          <input type="number" min={0} max={0.95} step={0.05} className={inputCls} value={settings.autoCompactThreshold} onChange={(e) => patch({ autoCompactThreshold: Number(e.target.value) })} />
        </Field>
        <Field label="Worker concurrency" hint="LM Studio serves one request per model at a time, so >1 only helps with multiple loaded models.">
          <input type="number" min={1} max={8} className={inputCls} value={settings.workerConcurrency} onChange={(e) => patch({ workerConcurrency: Number(e.target.value) })} />
        </Field>
      </div>
    </>
  );
}

function CapabilitiesTab({ settings, patch }: TabProps) {
  return (
    <>
      <div>
        <h3 className="font-medium">Tools available to the model</h3>
        <p className="text-xs text-ink-400 mt-1">Disable anything you don't want the agent to be able to do. Fewer tools also make small local models more reliable at tool calling.</p>
      </div>
      <div className="grid grid-cols-2 gap-x-6">
        {ALL_TOOL_NAMES.map((name) => (
          <Toggle key={name} label={name} checked={settings.capabilities[name] !== false} onChange={(v) => patch({ capabilities: { ...settings.capabilities, [name]: v } })} />
        ))}
      </div>
    </>
  );
}

const MCP_STATE_STYLE: Record<string, string> = {
  ready: 'text-accent',
  connecting: 'text-warn',
  error: 'text-danger',
  disabled: 'text-ink-400',
};

function SkillsTab() {
  const skills = useStore((s) => s.skills);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [url, setUrl] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const run = async (job: () => Promise<import('@localdex/shared').SkillImportResult>): Promise<void> => {
    setBusy(true);
    setMsg(null);
    const r = await job();
    setMsg({ ok: r.ok, text: summarize(r) });
    setBusy(false);
    if (r.ok) setUrl('');
  };
  const upload = (entries: UploadEntry[]): Promise<void> => run(() => uploadSkills(entries));
  const enabledCount = skills.filter((s) => s.enabled).length;

  return (
    <>
      <div>
        <h3 className="font-medium">Skills</h3>
        <p className="text-xs text-ink-400 mt-1">
          A skill is a folder with a <span className="font-mono">SKILL.md</span> that teaches LocalDex how to do something. Only each skill's one-line description is sent to the model; it loads the full text when a task matches.
        </p>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setOver(false);
          const entries = await collectDropped(e.dataTransfer);
          void upload(entries);
        }}
        className={cx('rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm transition-colors', over ? 'border-accent bg-accent/10 text-ink-100' : 'border-ink-600 text-ink-300')}
      >
        <div className="font-medium">{busy ? 'Adding…' : 'Drop a skill here'}</div>
        <div className="text-xs text-ink-400 mt-1">a folder, a SKILL.md, a .md file or a .zip. You can drop several at once.</div>
        <div className="flex justify-center gap-2 mt-3">
          <label className="cursor-pointer">
            <input type="file" multiple accept=".md,.markdown,.zip" className="hidden" onChange={(e) => { void upload(fromInput(e.target.files)); e.target.value = ''; }} />
            <span className="inline-flex px-2 py-1 text-xs rounded-md bg-ink-700 hover:bg-ink-600 border border-ink-600 text-ink-100">Choose files</span>
          </label>
          <label className="cursor-pointer">
            <input type="file" className="hidden" {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} onChange={(e) => { void upload(fromInput(e.target.files)); e.target.value = ''; }} />
            <span className="inline-flex px-2 py-1 text-xs rounded-md bg-ink-700 hover:bg-ink-600 border border-ink-600 text-ink-100">Choose folder</span>
          </label>
        </div>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) void run(() => importGithub(url.trim()));
        }}
      >
        <input className={cx(inputCls, 'flex-1 font-mono text-xs')} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo  (or a /tree/main/folder link)" />
        <Button type="submit" variant="primary" disabled={busy || !url.trim()}>
          Add from GitHub
        </Button>
      </form>

      {msg && <div className={cx('text-xs rounded-md px-3 py-2 whitespace-pre-wrap break-words', msg.ok ? 'bg-accent/10 text-accent' : 'bg-danger/10 text-danger')}>{msg.text}</div>}

      <div className="text-xs text-ink-400">
        {skills.length === 0 ? 'No skills yet.' : `${enabledCount} of ${skills.length} on.`} Each enabled skill adds a line to every prompt, so with a small local model keep only the ones you use.
      </div>
      <ul className="space-y-2">
        {skills.map((sk) => (
          <li key={sk.name} className="bg-ink-800 rounded-md px-3 py-2">
            <div className="flex items-center gap-3">
              <button type="button" className="flex-1 min-w-0 text-left" onClick={() => setOpen(open === sk.name ? null : sk.name)}>
                <div className="font-mono text-sm truncate">{sk.name}</div>
                <div className={cx('text-xs text-ink-300', open === sk.name ? '' : 'truncate')}>{sk.description}</div>
              </button>
              {sk.hasScripts && <span className="text-[10px] px-1.5 py-0.5 rounded bg-warn/15 text-warn shrink-0" title="Ships scripts. LocalDex only runs them if the model calls the shell, which follows your shell approval setting.">scripts</span>}
              <div className="w-16 shrink-0">
                <Toggle label="" checked={sk.enabled} onChange={(v) => void setSkillEnabled(sk.name, v)} />
              </div>
              <Button size="sm" variant="ghost" title="Remove this skill" onClick={() => { if (window.confirm(`Remove skill "${sk.name}"?`)) void removeSkill(sk.name); }}>
                ✕
              </Button>
            </div>
            {open === sk.name && (
              <div className="mt-2 text-[11px] text-ink-400 space-y-1 break-words">
                <div>source: {sk.source} · {(sk.bytes / 1024).toFixed(0)} KB · {sk.files.length} extra file{sk.files.length === 1 ? '' : 's'}</div>
                {sk.files.length > 0 && <div className="font-mono">{sk.files.slice(0, 12).join(', ')}{sk.files.length > 12 ? ', …' : ''}</div>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function McpTab({ settings, patch }: TabProps) {
  const status = useStore((s) => s.mcp);
  const names = Object.keys(settings.mcpServers ?? {});
  return (
    <>
      <div>
        <h3 className="font-medium">MCP servers</h3>
        <p className="text-xs text-ink-400 mt-1">
          MCP servers add extra tools (for example a browser). Turn one on here. To add a server or change its command, edit <span className="font-mono">~/.localdex/config.json</span> and restart LocalDex; commands cannot be changed from this screen. Only the tools listed under "exposed" are shown to the model.
        </p>
      </div>
      {names.length === 0 && <div className="text-xs text-ink-400">No MCP servers configured.</div>}
      <ul className="space-y-3">
        {names.map((name) => {
          const cfg = settings.mcpServers[name];
          const st = status.find((x) => x.name === name);
          const state = st?.state ?? 'disabled';
          return (
            <li key={name} className="bg-ink-800 rounded-md px-3 py-2 space-y-1.5">
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm flex-1">{name}</span>
                <span className={cx('text-xs', MCP_STATE_STYLE[state])}>{state}</span>
                <div className="w-16 shrink-0">
                  <Toggle label="" checked={cfg.enabled} onChange={(v) => patch({ mcpServers: { ...settings.mcpServers, [name]: { ...cfg, enabled: v } } })} />
                </div>
              </div>
              <div className="font-mono text-[11px] text-ink-400 truncate">
                {cfg.command} {(cfg.args ?? []).join(' ')}
              </div>
              {st && st.state === 'ready' && (
                <div className="text-xs text-ink-300">
                  exposed ({st.exposedTools.length} of {st.availableTools.length}): <span className="font-mono">{st.exposedTools.join(', ') || 'none'}</span>
                </div>
              )}
              {st?.error && <pre className="text-xs text-danger whitespace-pre-wrap break-words">{st.error}</pre>}
              <div className="text-[11px] text-ink-400">approval: {cfg.approval ?? 'once'} · workers: {cfg.allowWorkers ? 'allowed' : 'main agent only'}</div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function PromptTab({ settings, patch }: TabProps) {
  const [text, setText] = useState(settings.systemPrompt);
  return (
    <>
      <div>
        <h3 className="font-medium">Custom instructions</h3>
        <p className="text-xs text-ink-400 mt-1">Appended to the system prompt for the main agent and all workers. Coding conventions, preferred tools, things to avoid.</p>
      </div>
      <textarea className={cx(inputCls, 'min-h-[260px] font-mono text-xs')} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Use pnpm, not npm. Always run `pnpm test` before reporting done. Never touch files under /infra." />
      <Button variant="primary" onClick={() => patch({ systemPrompt: text })} disabled={text === settings.systemPrompt}>
        Save instructions
      </Button>
    </>
  );
}
