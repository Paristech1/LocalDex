import { loadSession, newSession, send, useStore } from '../store';
import { Button, cx, timeAgo } from './ui';

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const current = useStore((s) => s.session?.id);

  return (
    <aside className="w-60 shrink-0 border-r border-ink-700 bg-ink-900/40 flex flex-col">
      <div className="px-3 py-3 flex items-center justify-between border-b border-ink-700">
        <div className="font-semibold tracking-tight">
          <span className="text-accent">Local</span>Dex
        </div>
        <Button size="sm" onClick={newSession} title="New session">
          + New
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={cx(
              'group flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-ink-800',
              s.id === current && 'bg-ink-800 border-l-2 border-accent',
            )}
            onClick={() => s.id !== current && loadSession(s.id)}
          >
            <div className="flex-1 min-w-0">
              <div className="truncate text-ink-100">{s.title}</div>
              <div className="text-[11px] text-ink-400">
                {s.messageCount} msgs · {timeAgo(s.updatedAt)}
              </div>
            </div>
            <button
              type="button"
              className="opacity-0 group-hover:opacity-100 text-ink-400 hover:text-danger text-xs px-1"
              title="Delete session"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete "${s.title}"?`)) {
                  send({ type: 'delete_session', id: s.id });
                  if (s.id === current) newSession();
                }
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
