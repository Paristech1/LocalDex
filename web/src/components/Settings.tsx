import { useEffect, useState } from 'react';
import { ALL_TOOL_NAMES, type EditStyle, type McpGalleryEntry, type McpServerStatus, type PermissionPreset, type ReasoningMode, type Settings, type ShellApprovalMode, type ToolMode } from '@localdex/shared';
import { send, useStore } from '../store';
import { collectDropped, fromInput, importGithub, removeSkill, setSkillEnabled, summarize, uploadSkills, type UploadEntry } from '../skills';
import { Button, Field, Toggle, cx, inputCls, timeAgo } from './ui';
import { CouncilSettingsTab } from './Council';

export type SettingsTab = 'workspace' | 'model' | 'capabilities' | 'skills' | 'mcp' | 'council' | 'prompt';
type Tab = SettingsTab;

export function SettingsModal({ onClose, initialTab, onRunSetup }: { onClose: () => void; initialTab?: SettingsTab; onRunSetup?: () => void }) {
  const settings = useStore((s) => s.settings);
  const models = useStore((s) => s.models);
  const [tab, setTab] = useState<Tab>(initialTab ?? (settings?.approvedFolders.length ? 'model' : 'workspace'));
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
              ['council', 'Council'],
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
            {tab === 'council' && <CouncilSettingsTab settings={settings} patch={patch} />}
            {tab === 'prompt' && <PromptTab settings={settings} patch={patch} />}
          </div>
          <div className="border-t border-ink-700 px-5 py-3 flex items-center justify-between">
            {onRunSetup ? (
              <Button variant="ghost" size="sm" onClick={onRunSetup} title="Walk through choosing a model or cloud account and a folder again">
                Run setup again
              </Button>
            ) : (
              <span />
            )}
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
        <PermissionsPicker settings={settings} patch={patch} />
        <Field label="Shell command approval" hint="'Dangerous only' prompts for rm -rf, sudo, force-push, curl|sh and similar. 'Always' prompts for every command.">
          <select className={inputCls} value={settings.shellApproval} onChange={(e) => patch({ shellApproval: e.target.value as ShellApprovalMode })}>
            <option value="dangerous">Dangerous only (recommended)</option>
            <option value="always">Always ask</option>
            <option value="never">Never ask</option>
          </select>
        </Field>
        <Field label="Auto-review risky commands (experimental)" hint="Before you're asked about a risky shell command, a reviewer rates it. Only a 'low risk' verdict runs it without asking; anything else, or a reviewer error, shows the normal prompt with the reviewer's reason. Never auto-approves medium or high risk. A small local model is not a safe judge: prefer the council.">
          <select className={inputCls} value={settings.autoReview ?? 'off'} onChange={(e) => patch({ autoReview: e.target.value as 'off' | 'council' | 'local' })}>
            <option value="off">Off (always ask me)</option>
            <option value="council" disabled={!settings.council.enabled}>Council quick member (read-only, your subscription){settings.council.enabled ? '' : ' — council is off'}</option>
            <option value="local">Local model (not recommended)</option>
          </select>
        </Field>
        <Field label="Run my hooks (experimental)" hint="Claude Code hook format: PreToolUse can block a tool call, PostToolUse can add feedback, UserPromptSubmit can block a message or add context, Stop can ask for another turn. Hooks can never approve anything, and a hook that fails or times out is skipped. Never loaded from project folders.">
          <select className={inputCls} value={settings.hooksSource ?? 'off'} onChange={(e) => patch({ hooksSource: e.target.value as 'off' | 'localdex' | 'claude-code' })}>
            <option value="off">Off</option>
            <option value="localdex">~/.localdex/hooks.json</option>
            <option value="claude-code">My Claude Code hooks (~/.claude/settings.json)</option>
          </select>
        </Field>
        <div className="mt-3">
          <Toggle label="Files must be read before they are edited (and re-read if they changed meanwhile)" checked={settings.requireReadBeforeEdit !== false} onChange={(v) => patch({ requireReadBeforeEdit: v })} />
        </div>
        <div className="mt-2">
          <Toggle label="Name new sessions automatically (one short local-model call after the first answer)" checked={settings.autoTitle !== false} onChange={(v) => patch({ autoTitle: v })} />
        </div>
      </div>
    </>
  );
}

const PRESETS: { id: PermissionPreset; label: string; hint: string; needsSandbox: boolean }[] = [
  { id: 'full', label: 'Full access', hint: 'Today\'s behaviour: shell commands run with your user\'s rights. File tools stay inside the approved folders.', needsSandbox: false },
  { id: 'workspace', label: 'Workspace (sandboxed)', hint: 'Shell commands may only write inside the approved folders, temp and tool caches (npm, pip…). A blocked command asks you once whether to allow it. Recommended.', needsSandbox: true },
  { id: 'read-only', label: 'Read only', hint: 'Nothing can change your files: shell writes are blocked and write_file / edit_file are off. Good for reviews and questions.', needsSandbox: true },
];

/** S3: sandbox + write tools as one choice. Presets that need a sandbox are disabled when this machine has none. */
function PermissionsPicker({ settings, patch }: TabProps) {
  const sandbox = useStore((s) => s.sandbox);
  const current = settings.permissionPreset ?? 'full';
  const backend = sandbox?.kind === 'seatbelt' ? 'macOS Seatbelt' : sandbox?.kind === 'bwrap' ? 'bubblewrap' : null;
  return (
    <Field label="Permissions" hint={sandbox?.available ? `Sandbox: ${backend}.` : `No sandbox on this machine${sandbox?.reason ? ` (${sandbox.reason})` : ''}, so only Full access is available.`}>
      <div role="radiogroup" aria-label="Permissions" className="space-y-1.5">
        {PRESETS.map((p) => {
          const disabled = p.needsSandbox && !sandbox?.available;
          return (
            <label key={p.id} className={cx('flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer', current === p.id ? 'border-accent/50 bg-accent/5' : 'border-ink-700', disabled && 'opacity-50 cursor-not-allowed')}>
              <input type="radio" name="permissionPreset" className="mt-1" checked={current === p.id} disabled={disabled} onChange={() => patch({ permissionPreset: p.id })} />
              <span>
                <span className="text-sm text-ink-100">{p.label}</span>
                <span className="block text-[11px] text-ink-400">{p.hint}</span>
              </span>
            </label>
          );
        })}
      </div>
    </Field>
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
        <Field label="Reasoning (thinking)" hint="Auto switches thinking off while the agent uses tools, for models that support it (Gemma 4, Qwen 3…). Small models call tools far more reliably, and several times faster, without it.">
          <select className={inputCls} value={settings.reasoning ?? 'auto'} onChange={(e) => patch({ reasoning: e.target.value as ReasoningMode })}>
            <option value="auto">Auto: off while using tools (recommended)</option>
            <option value="on">On (model default)</option>
            <option value="off">Always off</option>
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
      {settings.model && (
        <Field label={`Edit tools for ${settings.model}`} hint="Some fine-tunes were trained on one way of editing files. Pick the one this model handles best (the model doctor's edit checks use edit_file). Read-before-edit, Undo and the Read only preset apply to all three.">
          <select className={inputCls} value={settings.editStyle?.[settings.model] ?? 'edit_file'} onChange={(e) => patch({ editStyle: { ...(settings.editStyle ?? {}), [settings.model!]: e.target.value as EditStyle } })}>
            <option value="edit_file">edit_file + write_file (default)</option>
            <option value="apply_patch">apply_patch (Codex-style patches)</option>
            <option value="str_replace_editor">str_replace_editor (Claude-Code-style)</option>
          </select>
        </Field>
      )}
      <ReloadModel settings={settings} patch={patch} />
      <ModelDoctor settings={settings} patch={patch} />
    </>
  );
}

const fmtCtx = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n));

/** E4: run scripted tool-calling probes against the selected model, then offer the suggested settings. */
function ModelDoctor({ settings, patch }: TabProps) {
  const reports = useStore((s) => s.doctorReports);
  const progress = useStore((s) => s.doctorProgress);
  const model = settings.model;
  const report = reports.find((r) => r.model === model);
  const others = reports.filter((r) => r.model !== model);
  return (
    <div className="pt-4 border-t border-ink-700 space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="font-medium flex-1">Model doctor</h3>
        {progress ? (
          <Button size="sm" variant="ghost" onClick={() => send({ type: 'doctor_stop' })}>
            Stop
          </Button>
        ) : (
          <Button size="sm" onClick={() => send({ type: 'doctor_run', ...(model ? { model } : {}) })} disabled={!model}>
            {report ? 'Run again' : 'Run model doctor'}
          </Button>
        )}
      </div>
      <p className="text-xs text-ink-400">
        Six tool-calling checks in each protocol (native and text) plus a speed test, against {model ? <span className="font-mono">{model}</span> : 'the selected model'}. Nothing touches your files: every check is a single request with a made-up conversation. Takes a minute or two.
      </p>
      {progress && (
        <div className="space-y-1">
          <div className="h-1.5 rounded bg-ink-800 overflow-hidden">
            <div className="h-full bg-accent transition-all" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
          </div>
          <div className="text-[11px] text-ink-400 pulse">
            {progress.done}/{progress.total} · {progress.label}
          </div>
        </div>
      )}
      {report && !progress && (
        <div className="rounded-md bg-ink-800 p-3 space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className={cx('rounded px-1.5 py-0.5 text-[11px] font-medium', report.verdict === 'good' ? 'bg-accent/15 text-accent' : report.verdict === 'usable' ? 'bg-warn/15 text-warn' : 'bg-danger/15 text-danger')}>{report.verdict}</span>
            <span>native {report.score.native}/{report.score.of}</span>
            <span>text {report.score.text}/{report.score.of}</span>
            <span>edits landed {report.editsLanded}/{report.editsTried}</span>
            <span>{report.speed.tokensPerSecond !== null ? `${report.speed.tokensPerSecond} tok/s` : 'tok/s n/a'}</span>
            <span>{report.speed.ttftMs !== null ? `first token ${(report.speed.ttftMs / 1000).toFixed(1)} s` : ''}</span>
            <span className="text-ink-400 ml-auto">{timeAgo(report.ranAt)}</span>
          </div>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-ink-400 text-left">
                <th className="font-normal">Check</th>
                <th className="font-normal w-14">Native</th>
                <th className="font-normal w-14">Text</th>
              </tr>
            </thead>
            <tbody>
              {report.probes
                .filter((p) => p.mode === 'native')
                .map((p) => {
                  const t = report.probes.find((x) => x.mode === 'text' && x.id === p.id);
                  return (
                    <tr key={p.id}>
                      <td>{p.title}</td>
                      <td title={p.detail} className={p.pass ? 'text-accent' : 'text-danger'}>{p.pass ? '✓' : '✗'}</td>
                      <td title={t?.detail} className={t?.pass ? 'text-accent' : 'text-danger'}>{t ? (t.pass ? '✓' : '✗') : '–'}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
          <div className="space-y-1 pt-1">
            <Suggestion label={`Tool call mode: ${report.suggest.toolMode}`} why={report.suggest.toolModeWhy} applied={settings.toolMode === report.suggest.toolMode} onApply={() => patch({ toolMode: report.suggest.toolMode })} />
            <Suggestion label="Reasoning: Auto" why={report.suggest.reasoningWhy} applied={settings.reasoning === report.suggest.reasoning} onApply={() => patch({ reasoning: report.suggest.reasoning })} />
            {report.suggest.contextLength ? (
              <Suggestion label={`Context window: ${fmtCtx(report.suggest.contextLength)}`} why={`${report.suggest.contextWhy}. Then press Reload in LM Studio above.`} applied={settings.loadContextLength === report.suggest.contextLength} onApply={() => patch({ loadContextLength: report.suggest.contextLength! })} />
            ) : (
              <div className="text-[11px] text-ink-400">Context window: no suggestion ({report.suggest.contextWhy}).</div>
            )}
          </div>
        </div>
      )}
      {others.length > 0 && (
        <details className="text-[11px] text-ink-400">
          <summary className="cursor-pointer">Other models ({others.length})</summary>
          <table className="w-full mt-1">
            <tbody>
              {others.map((r) => (
                <tr key={r.model}>
                  <td className="font-mono truncate max-w-[14rem]">{r.model}</td>
                  <td>native {r.score.native}/{r.score.of}</td>
                  <td>text {r.score.text}/{r.score.of}</td>
                  <td>{r.speed.tokensPerSecond ?? '–'} tok/s</td>
                  <td>{timeAgo(r.ranAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function Suggestion({ label, why, applied, onApply }: { label: string; why: string; applied: boolean; onApply: () => void }) {
  return (
    <div className="flex items-start gap-2">
      <div className="flex-1">
        <div className="text-ink-100">{label}</div>
        <div className="text-[11px] text-ink-400">{why}</div>
      </div>
      {applied ? <span className="text-[11px] text-accent">✓ set</span> : <Button size="sm" onClick={onApply}>Apply</Button>}
    </div>
  );
}

/** Reload the default model in LM Studio with a bigger context window (LM Studio REST API v1). */
function ReloadModel({ settings, patch }: TabProps) {
  const infos = useStore((s) => s.models);
  const [busy, setBusy] = useState(false);
  const [want, setWant] = useState(settings.loadContextLength || 32768);
  const info = infos.find((m) => m.id === settings.model);
  const current = info?.contextLength ?? 0;
  // The models list refreshes when the reload finishes (or fails); either way stop showing "Reloading".
  useEffect(() => setBusy(false), [infos]);
  if (!settings.model) return null;
  const max = info?.maxContextLength;
  return (
    <div className="mt-4 rounded-lg border border-ink-700 p-3 space-y-2">
      <div className="text-sm font-medium">Context window</div>
      <p className="text-[11px] text-ink-400">
        {settings.model} is loaded with {current ? `${current.toLocaleString()} tokens` : 'an unknown context'}
        {max ? ` (supports up to ${max.toLocaleString()})` : ''}. More context means longer conversations before Compact & Resume, at the cost of memory: on 16 GB, 32k is a safe size for a 12B model.
      </p>
      <div className="flex gap-2 items-center">
        <select className={inputCls} value={want} onChange={(e) => setWant(Number(e.target.value))}>
          {[8192, 16384, 32768, 49152, 65536, 98304, 131072].filter((n) => !max || n <= max).map((n) => (
            <option key={n} value={n}>
              {n.toLocaleString()} tokens
            </option>
          ))}
        </select>
        <Button
          disabled={busy || want === current}
          onClick={() => {
            setBusy(true);
            patch({ loadContextLength: want });
            send({ type: 'reload_model', model: settings.model!, contextLength: want });
          }}
        >
          {busy ? 'Reloading…' : 'Reload in LM Studio'}
        </Button>
      </div>
      <p className="text-[11px] text-ink-400">Unloads the model and loads it again with this context (needs LM Studio 0.4+). Runs in progress on this model will fail, so wait for them to finish.</p>
    </div>
  );
}

function CapabilitiesTab({ settings, patch }: TabProps) {
  const unavailable = useStore((s) => s.unavailableTools);
  const terminalsOff = ALL_TOOL_NAMES.some((n) => n.startsWith('terminal_') && unavailable[n]);
  return (
    <>
      <div>
        <h3 className="font-medium">Tools available to the model</h3>
        <p className="text-xs text-ink-400 mt-1">Disable anything you don't want the agent to be able to do. Fewer tools also make small local models more reliable at tool calling.</p>
      </div>
      {terminalsOff && (
        <div className="text-xs text-warn bg-warn/10 border border-warn/30 rounded-md px-3 py-2">
          Persistent terminals need <span className="font-mono">node-pty</span>, which is not installed on this machine: install build tools, then run <span className="font-mono">npm rebuild node-pty</span>. The terminal_* tools are hidden from the model until then; <span className="font-mono">shell_run</span> keeps working.
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-6">
        {ALL_TOOL_NAMES.map((name) => (
          <div key={name} className={unavailable[name] ? 'opacity-50' : undefined} title={unavailable[name]}>
            <Toggle label={unavailable[name] ? `${name} (unavailable)` : name} checked={settings.capabilities[name] !== false} onChange={(v) => patch({ capabilities: { ...settings.capabilities, [name]: v } })} />
          </div>
        ))}
      </div>
      <div className="border-t border-ink-700 pt-4">
        <h3 className="font-medium">Web access</h3>
        <p className="text-xs text-ink-400 mt-1">
          <span className="font-mono">web_fetch</span> and <span className="font-mono">web_search</span> are off by default. Fetch reads one http(s) page as Markdown (text only, 2 MB cap, same-site redirects only); every result is marked as untrusted content for the model. Search needs a SearXNG server you run or trust; the tool stays hidden until one is set.
        </p>
        <Field label="Web search server (SearXNG URL)" hint="e.g. http://localhost:8080 — its JSON format must be enabled.">
          <input className={inputCls} value={settings.webSearchUrl ?? ''} onChange={(e) => patch({ webSearchUrl: e.target.value })} placeholder="http://localhost:8080" />
        </Field>
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
  const gallery = useStore((s) => s.mcpGallery);
  const notice = useStore((s) => s.mcpNotice);
  const [adding, setAdding] = useState<string | null>(null);
  const names = Object.keys(settings.mcpServers ?? {});
  return (
    <>
      <div>
        <h3 className="font-medium">MCP servers</h3>
        <p className="text-xs text-ink-400 mt-1">
          MCP servers add extra tools (a browser, Blender, GitHub…). Add one from the gallery below, or define your own in <span className="font-mono">~/.localdex/config.json</span> and restart LocalDex. Commands can't be typed in here: the gallery's commands are fixed in LocalDex itself. Only the tools ticked under a server are shown to the model; keep the list short for small models.
        </p>
      </div>
      {notice && Date.now() - notice.ts < 15_000 && <div className={cx('text-xs rounded-md px-3 py-2', notice.ok ? 'bg-accent/10 text-accent' : 'bg-danger/10 text-danger')}>{notice.message}</div>}
      {names.length === 0 && <div className="text-xs text-ink-400">No MCP servers configured.</div>}
      <ul className="space-y-3">
        {names.map((name) => (
          <McpServerCard key={name} name={name} settings={settings} patch={patch} st={status.find((x) => x.name === name)} />
        ))}
      </ul>
      <div className="pt-4 border-t border-ink-700">
        <h3 className="font-medium">Gallery</h3>
        <ul className="mt-2 grid gap-2">
          {gallery.map((g) => (
            <li key={g.id} className="bg-ink-800 rounded-md px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-sm text-ink-100 flex-1">{g.title}</span>
                {g.installed ? <span className="text-[11px] text-ink-400">added</span> : <Button size="sm" onClick={() => setAdding(g.id)}>Add…</Button>}
              </div>
              <p className="text-[11px] text-ink-400 mt-0.5">{g.description}</p>
              {adding === g.id && <GalleryConfirm entry={g} onDone={() => setAdding(null)} />}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

/** Confirm dialog: everything that will be written to config.json, and the server name typed to confirm. */
function GalleryConfirm({ entry, onDone }: { entry: McpGalleryEntry; onDone: () => void }) {
  const [typed, setTyped] = useState('');
  const c = entry.config;
  return (
    <div className="mt-2 rounded-md border border-warn/40 bg-ink-900 p-3 space-y-2 text-xs" role="dialog" aria-label={`Add ${entry.title}`}>
      <div className="text-ink-200">This starts a program on your computer:</div>
      <pre className="font-mono text-[11px] text-ink-100 bg-ink-800 rounded px-2 py-1 whitespace-pre-wrap break-all">{[c.command, ...(c.args ?? [])].join(' ')}</pre>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
        <dt className="text-ink-400">Tools shown</dt>
        <dd className="font-mono">{c.allowTools?.join(', ') || 'all the server offers'}</dd>
        <dt className="text-ink-400">Asks first</dt>
        <dd>{c.approval === 'always' ? 'every call' : c.approval === 'never' ? 'never' : 'once per LocalDex start'}</dd>
        {!!c.inheritEnv?.length && (
          <>
            <dt className="text-ink-400">Gets env vars</dt>
            <dd className="font-mono">{c.inheritEnv.join(', ')}</dd>
          </>
        )}
        <dt className="text-ink-400">Needs</dt>
        <dd>{entry.needs}</dd>
      </dl>
      <a className="text-accent underline text-[11px]" href={entry.homepage} target="_blank" rel="noreferrer">
        {entry.homepage}
      </a>
      <label className="block text-ink-300">
        Type <span className="font-mono text-ink-100">{entry.name}</span> to confirm
        <input className={cx(inputCls, 'mt-1 font-mono')} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
      </label>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={typed.trim() !== entry.name}
          onClick={() => {
            send({ type: 'mcp_gallery_add', id: entry.id, confirmName: typed.trim() });
            onDone();
          }}
        >
          Add and start
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function McpServerCard({ name, settings, patch, st }: TabProps & { name: string; st?: McpServerStatus }) {
  const cfg = settings.mcpServers[name];
  const state = st?.state ?? 'disabled';
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => setPicked(st?.exposedTools ?? []), [st?.exposedTools?.join(',')]);
  return (
    <li className="bg-ink-800 rounded-md px-3 py-2 space-y-1.5">
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
      {st && st.state === 'ready' && !picking && (
        <div className="text-xs text-ink-300">
          exposed ({st.exposedTools.length} of {st.availableTools.length}): <span className="font-mono">{st.exposedTools.join(', ') || 'none'}</span>
        </div>
      )}
      {st && st.state === 'ready' && picking && (
        <div className="space-y-1">
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 max-h-48 overflow-y-auto">
            {st.availableTools.map((t) => (
              <label key={t} className="flex items-center gap-1.5 text-[11px] font-mono">
                <input type="checkbox" checked={picked.includes(t)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, t] : p.filter((x) => x !== t)))} />
                {t}
              </label>
            ))}
          </div>
          {picked.length > 8 && <div className="text-[11px] text-warn">{picked.length} tools: small local models get less reliable above about 8.</div>}
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={!picked.length} onClick={() => (send({ type: 'mcp_set_tools', name, allowTools: picked }), setPicking(false))}>
              Save tools
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPicking(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {st?.error && <pre className="text-xs text-danger whitespace-pre-wrap break-words">{st.error}</pre>}
      <div className="flex items-center gap-2 text-[11px] text-ink-400">
        <span className="flex-1">approval: {cfg.approval ?? 'once'} · workers: {cfg.allowWorkers ? 'allowed' : 'main agent only'}</span>
        {cfg.enabled && (
          <button type="button" className="hover:text-ink-100" onClick={() => send({ type: 'mcp_test', name })}>
            Test connection
          </button>
        )}
        {st?.state === 'ready' && !picking && (
          <button type="button" className="hover:text-ink-100" onClick={() => setPicking(true)}>
            Choose tools
          </button>
        )}
        <button type="button" className="hover:text-danger" onClick={() => confirm(`Remove "${name}" from config.json?`) && send({ type: 'mcp_remove', name })}>
          Remove
        </button>
      </div>
    </li>
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
      <div className="pt-4 border-t border-ink-700">
        <h3 className="font-medium">Project instruction files</h3>
        <p className="text-xs text-ink-400 mt-1">
          <code>~/.localdex/AGENTS.md</code> (yours, first 4 KB) and the project's <code>AGENTS.md</code>, <code>CLAUDE.md</code> or <code>LOCALDEX.md</code> (first 8 KB) are loaded into the system prompt. Instruction files in subfolders are added when the agent works there.
        </p>
        <div className="mt-2">
          <Toggle label="Load instruction files" checked={settings.projectInstructions !== false} onChange={(v) => patch({ projectInstructions: v })} />
        </div>
      </div>
    </>
  );
}
