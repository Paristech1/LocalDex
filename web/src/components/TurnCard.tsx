import { useState } from 'react';
import type { TurnCheckpoint } from '@localdex/shared';
import { send, useStore } from '../store';
import { Button, cx } from './ui';

/** "Changed files" under a Solo turn: file list with +/-, the diff on demand, and Undo this turn. */
export function TurnCard({ turn }: { turn: TurnCheckpoint }) {
  const sessionId = useStore((s) => s.session?.id);
  const running = useStore((s) => s.status.main?.status && s.status.main.status !== 'idle');
  const diff = useStore((s) => s.turnDiffs[turn.id]);
  const [open, setOpen] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const added = turn.files.reduce((n, f) => n + f.added, 0);
  const removed = turn.files.reduce((n, f) => n + f.removed, 0);
  const toggleDiff = () => {
    if (!showDiff && diff === undefined && sessionId) send({ type: 'get_turn_diff', sessionId, turnId: turn.id });
    setShowDiff((v) => !v);
  };
  return (
    <div className={cx('mb-3 -mt-1 rounded-md border px-2.5 py-1.5 text-xs', turn.undone ? 'border-ink-800 bg-ink-950/40 text-ink-500' : 'border-ink-700 bg-ink-900/60')}>
      <div className="flex items-center gap-2">
        <button type="button" className="text-left text-ink-300 hover:text-ink-100" onClick={() => setOpen((v) => !v)}>
          {open ? '▾' : '▸'} Changed {turn.files.length} file{turn.files.length === 1 ? '' : 's'} <span className="text-accent">+{added}</span> <span className="text-danger">−{removed}</span>
          {turn.undone && <span className="ml-2 text-ink-500">· undone</span>}
        </button>
        <span className="flex-1" />
        {!turn.undone && (
          <button type="button" className="text-[11px] text-ink-400 hover:text-ink-200" onClick={toggleDiff}>
            {showDiff ? 'Hide diff' : 'Show diff'}
          </button>
        )}
        {!turn.undone && !confirm && (
          <Button variant="ghost" size="sm" onClick={() => setConfirm(true)} disabled={!!running} title="Put every file this turn changed back to how it was when the turn started. Refused if a file changed since.">
            Undo this turn
          </Button>
        )}
        {!turn.undone && confirm && (
          <span className="flex items-center gap-1">
            <span className="text-ink-400">Restore {turn.files.length} file{turn.files.length === 1 ? '' : 's'}?</span>
            <Button variant="danger" size="sm" onClick={() => { if (sessionId) send({ type: 'undo_turn', sessionId, turnId: turn.id }); setConfirm(false); }}>
              Undo
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>
              Keep
            </Button>
          </span>
        )}
      </div>
      {open && (
        <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
          {turn.files.map((f) => (
            <li key={f.path} className="flex items-center gap-2 min-w-0">
              <span className={cx('w-1.5 h-1.5 rounded-full shrink-0', f.kind === 'added' ? 'bg-accent' : f.kind === 'deleted' ? 'bg-danger' : 'bg-warn')} title={f.kind} />
              <span className="truncate text-ink-200" title={f.path}>{f.rel}</span>
              <span className="text-accent">+{f.added}</span>
              <span className="text-danger">−{f.removed}</span>
            </li>
          ))}
        </ul>
      )}
      {showDiff && (
        <pre className="mt-1.5 max-h-80 overflow-auto rounded border border-ink-800 bg-ink-950 px-2 py-1.5 font-mono text-[11px] leading-4 text-ink-200 whitespace-pre">
          {(diff ?? 'Loading…').split('\n').map((l, i) => (
            <div key={i} className={cx(l.startsWith('+') && !l.startsWith('+++') ? 'text-accent' : l.startsWith('-') && !l.startsWith('---') ? 'text-danger' : l.startsWith('@@') ? 'text-[#7cc0f2]' : l.startsWith('diff --git') ? 'text-ink-400' : '')}>
              {l || ' '}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
