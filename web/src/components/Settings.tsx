import { useEffect, useState } from 'react';
import { ALL_TOOL_NAMES, type Settings, type ShellApprovalMode, type ToolMode } from '@localdex/shared';
import { send, useStore } from '../store';
import { Button, Field, Toggle, cx, inputCls } from './ui';

type Tab = 'workspace' | 'model' | 'capabilities' | 'prompt';

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
