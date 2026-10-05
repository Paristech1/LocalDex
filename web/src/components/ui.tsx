import type { ReactNode } from 'react';
import type { AgentStatus } from '@localdex/shared';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function Button({
  children,
  onClick,
  variant = 'default',
  size = 'md',
  disabled,
  title,
  type = 'button',
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  className?: string;
}) {
  const base = 'inline-flex items-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const sizes = size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm';
  const variants = {
    default: 'bg-ink-700 hover:bg-ink-600 text-ink-100 border border-ink-600',
    primary: 'bg-accent text-ink-950 hover:bg-accent-dim',
    danger: 'bg-danger/15 text-danger hover:bg-danger/25 border border-danger/30',
    ghost: 'text-ink-300 hover:text-ink-100 hover:bg-ink-700',
  }[variant];
  return (
    <button type={type} className={cx(base, sizes, variants, className)} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

export function StatusDot({ status }: { status: AgentStatus | undefined }) {
  const color =
    status === 'thinking' || status === 'running'
      ? 'bg-accent pulse'
      : status === 'tool'
        ? 'bg-warn pulse'
        : status === 'waiting'
          ? 'bg-warn'
          : status === 'queued'
            ? 'bg-ink-300 pulse'
            : status === 'error'
              ? 'bg-danger'
              : 'bg-ink-500';
  return <span className={cx('inline-block w-2 h-2 rounded-full', color)} />;
}

export function statusLabel(status: AgentStatus | undefined, detail?: string): string {
  if (detail) return detail;
  switch (status) {
    case 'thinking':
      return 'Thinking…';
    case 'running':
      return 'Working…';
    case 'tool':
      return 'Running tools…';
    case 'waiting':
      return 'Waiting for you';
    case 'queued':
      return 'Queued';
    case 'error':
      return 'Error';
    default:
      return 'Idle';
  }
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs font-medium text-ink-300 mb-1">{label}</div>
      {children}
      {hint && <div className="text-[11px] text-ink-400 mt-1">{hint}</div>}
    </label>
  );
}

export const inputCls =
  'w-full bg-ink-900 border border-ink-600 rounded-md px-2.5 py-1.5 text-sm text-ink-100 placeholder:text-ink-400 focus:outline-none focus:border-accent/60';

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center justify-between w-full px-2.5 py-1.5 rounded-md hover:bg-ink-700 text-sm"
    >
      <span className="font-mono text-xs text-ink-200">{label}</span>
      <span className={cx('w-8 h-4 rounded-full relative transition-colors', checked ? 'bg-accent' : 'bg-ink-600')}>
        <span
          className={cx(
            'absolute top-0.5 w-3 h-3 rounded-full bg-ink-950 transition-all',
            checked ? 'left-[18px]' : 'left-0.5',
          )}
        />
      </span>
    </button>
  );
}

export function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
