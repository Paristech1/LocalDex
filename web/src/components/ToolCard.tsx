import { useState } from 'react';
import { cx } from './ui';

export interface ToolCardProps {
  name: string;
  args: unknown;
  result?: string;
  ok?: boolean;
  running?: boolean;
  startedAt?: number;
}

const ICONS: Record<string, string> = {
  read_file: '📄',
  write_file: '✍️',
  edit_file: '✏️',
  list_dir: '📁',
  glob: '🔎',
  grep: '🔍',
  shell_run: '⌘',
  terminal_open: '🖥',
  terminal_send: '⌨️',
  terminal_read: '📟',
  terminal_close: '✖',
  ask_user: '❓',
  delegate_to_worker: '🧑‍🔧',
  update_plan: '📋',
};

function summarizeArgs(name: string, args: unknown): string {
  if (!args || typeof args !== 'object') return typeof args === 'string' ? args.slice(0, 120) : '';
  const a = args as Record<string, unknown>;
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'list_dir':
      return String(a.path ?? '');
    case 'glob':
      return String(a.pattern ?? '');
    case 'grep':
      return `/${String(a.pattern ?? '')}/${a.glob ? ` in ${a.glob}` : ''}`;
    case 'shell_run':
    case 'terminal_open':
      return String(a.command ?? a.cwd ?? '');
    case 'terminal_send':
      return `${a.id}: ${String(a.input ?? '')}`;
    case 'terminal_read':
    case 'terminal_close':
      return String(a.id ?? '');
    case 'ask_user':
      return String(a.question ?? '').slice(0, 120);
    case 'delegate_to_worker':
      return `→ ${a.name}: ${String(a.task ?? '').slice(0, 100)}`;
    case 'update_plan':
      return Array.isArray(a.steps) ? `${a.steps.length} steps` : '';
    default:
      return JSON.stringify(a).slice(0, 120);
  }
}

export function ToolCard({ name, args, result, ok, running, startedAt }: ToolCardProps) {
  const [open, setOpen] = useState(false);
  const isRunning = running || result === undefined;
  const border = isRunning ? 'border-warn/40' : ok === false ? 'border-danger/40' : 'border-ink-600';
  const argStr = typeof args === 'string' ? args : JSON.stringify(args, null, 2);

  return (
    <div className={cx('rounded-md border bg-ink-900/70 text-xs my-1 overflow-hidden', border)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-ink-800"
      >
        <span className="w-4 text-center">{ICONS[name] ?? '🔧'}</span>
        <span className="font-mono text-ink-100">{name}</span>
        <span className="font-mono text-ink-300 truncate flex-1">{summarizeArgs(name, args)}</span>
        {isRunning ? (
          <span className="text-warn pulse">running{startedAt ? ` · ${Math.round((Date.now() - startedAt) / 1000)}s` : ''}</span>
        ) : ok === false ? (
          <span className="text-danger">failed</span>
        ) : (
          <span className="text-accent-dim">ok</span>
        )}
        <span className="text-ink-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="border-t border-ink-700 px-2.5 py-2 space-y-2">
          <div>
            <div className="text-ink-400 mb-0.5">arguments</div>
            <pre className="font-mono whitespace-pre-wrap break-words text-ink-200 max-h-60 overflow-auto">{argStr}</pre>
          </div>
          {result !== undefined && (
            <div>
              <div className="text-ink-400 mb-0.5">result</div>
              <pre className="font-mono whitespace-pre-wrap break-words text-ink-200 max-h-96 overflow-auto">{result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
