import { dismissError, send, useStore } from '../store';
import { Button, StatusDot, cx, fmtTokens, statusLabel } from './ui';
import type { SettingsTab } from './Settings';

export function TopBar({ onOpenSettings }: { onOpenSettings: (tab?: SettingsTab) => void }) {
  const session = useStore((s) => s.session);
  const models = useStore((s) => s.models);
  const modelsError = useStore((s) => s.modelsError);
  const connected = useStore((s) => s.connected);
  const status = useStore((s) => s.status['main']);
  const error = useStore((s) => s.error);
  const settings = useStore((s) => s.settings);

  const model = session?.model ?? settings?.model ?? '';
  const info = models.find((m) => m.id === model);
  const ctx = settings?.contextLength || info?.contextLength || 0;
  const used = session?.usage.lastPromptTokens ?? 0;
  const pct = ctx ? Math.min(100, Math.round((used / ctx) * 100)) : null;
  const councilOn = !!settings?.council.enabled;
  const mode = councilOn && session?.mode === 'council' ? 'council' : 'solo';
  const setMode = (m: 'solo' | 'council') => {
    if (!session) return;
    if (m === 'council' && !councilOn) return onOpenSettings('council');
    send({ type: 'set_mode', sessionId: session.id, mode: m });
  };

  return (
    <header className="h-12 shrink-0 border-b border-ink-700 bg-ink-900/60 flex items-center gap-3 px-4">
      <div className="flex rounded-md border border-ink-600 overflow-hidden text-xs" title="Solo: your local model leads (it can still call the council). Council: messages go to cloud members.">
        {(['solo', 'council'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cx(
              'px-2.5 py-1 transition-colors',
              mode === m ? (m === 'council' ? 'bg-[#7cc0f2]/15 text-[#a9d6f7]' : 'bg-ink-600 text-ink-100') : 'text-ink-400 hover:bg-ink-700 hover:text-ink-200',
            )}
          >
            {m === 'solo' ? 'Solo' : '☁ Council'}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <select
          className="bg-ink-800 border border-ink-600 rounded-md px-2 py-1 text-sm max-w-[360px] focus:outline-none focus:border-accent/60"
          value={model}
          onChange={(e) => session && send({ type: 'set_model', sessionId: session.id, model: e.target.value })}
          title="Model (from LM Studio)"
        >
          {!models.length && <option value={model}>{model || 'No models found'}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.loaded ? '● ' : '○ '}
              {m.id}
              {m.contextLength ? ` · ${fmtTokens(m.contextLength)} ctx` : ''}
            </option>
          ))}
        </select>
        <Button variant="ghost" size="sm" onClick={() => send({ type: 'list_models' })} title="Refresh models from LM Studio">
          ↻
        </Button>
      </div>

      <div className="flex items-center gap-2 text-xs text-ink-300">
        <StatusDot status={status?.status} />
        <span>{statusLabel(status?.status, status?.detail)}</span>
      </div>

      {pct !== null && (
        <div className="flex items-center gap-2 text-[11px] text-ink-400" title={`Last prompt: ${used} tokens of ${ctx}`}>
          <div className="w-24 h-1.5 bg-ink-700 rounded-full overflow-hidden">
            <div className={cx('h-full', pct > 80 ? 'bg-danger' : pct > 60 ? 'bg-warn' : 'bg-accent')} style={{ width: `${pct}%` }} />
          </div>
          <span>
            {fmtTokens(used)}/{fmtTokens(ctx)}
          </span>
        </div>
      )}

      <div className="flex-1" />

      {(error || (modelsError && !(mode === 'council' && !settings?.model))) && (
        <button type="button" onClick={dismissError} className="text-xs text-danger max-w-md truncate hover:underline" title={error ?? modelsError ?? ''}>
          ⚠ {error ?? modelsError}
        </button>
      )}
      <span className={cx('text-[11px]', connected ? 'text-accent-dim' : 'text-danger')}>{connected ? 'connected' : 'reconnecting…'}</span>
      <Button variant="ghost" size="sm" onClick={() => onOpenSettings()}>
        ⚙ Settings
      </Button>
    </header>
  );
}
