import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@localdex/shared';
import { loadSession, newSession, send, useStore } from '../store';
import { Button, cx, timeAgo } from './ui';

interface Hit {
  id: string;
  title: string;
  updatedAt: number;
  snippet: string;
}

/** U1: search box over every session's title and messages (typo-tolerant, server side). */
function useSessionSearch(query: string): { hits: Hit[] | null; loading: boolean } {
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    setLoading(true);
    const ac = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/sessions/search?q=${encodeURIComponent(q)}`, { signal: ac.signal });
        setHits(((await r.json()) as { results: Hit[] }).results);
      } catch {
        /* aborted or offline */
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [query]);
  return { hits, loading };
}

export function exportUrl(id: string, format: 'md' | 'json'): string {
  return `/api/sessions/${encodeURIComponent(id)}/export?format=${format}`;
}

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const current = useStore((s) => s.session?.id);
  const [query, setQuery] = useState('');
  const { hits, loading } = useSessionSearch(query);

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
      <div className="px-2 pt-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          placeholder="Search sessions…"
          aria-label="Search sessions"
          className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs placeholder:text-ink-500 focus:outline-none focus:border-accent/60"
        />
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {hits ? (
          <>
            <div className="px-3 py-1 text-[11px] text-ink-400">{loading ? 'Searching…' : `${hits.length} match${hits.length === 1 ? '' : 'es'}`}</div>
            {hits.map((h) => (
              <button
                key={h.id}
                type="button"
                className={cx('block w-full text-left px-3 py-2 text-sm hover:bg-ink-800', h.id === current && 'bg-ink-800 border-l-2 border-accent')}
                onClick={() => h.id !== current && loadSession(h.id)}
              >
                <div className="truncate text-ink-100">{h.title}</div>
                <div className="text-[11px] text-ink-400 line-clamp-2">{h.snippet}</div>
              </button>
            ))}
          </>
        ) : (
          sessions.map((s) => <SessionRow key={s.id} s={s} current={s.id === current} />)
        )}
      </div>
    </aside>
  );
}

function SessionRow({ s, current }: { s: SessionSummary; current: boolean }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(s.title);
  const [menu, setMenu] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setTitle(s.title), [s.title]);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const t = title.trim();
    if (t && t !== s.title) send({ type: 'rename_session', id: s.id, title: t });
    else setTitle(s.title);
  };

  return (
    <div
      className={cx('group relative flex items-center gap-1 px-3 py-2 text-sm cursor-pointer hover:bg-ink-800', current && 'bg-ink-800 border-l-2 border-accent')}
      onClick={() => !current && !editing && loadSession(s.id)}
    >
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            ref={input}
            value={title}
            maxLength={80}
            aria-label="Session name"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                setTitle(s.title);
                setEditing(false);
              }
            }}
            className="w-full rounded border border-accent/60 bg-ink-900 px-1 text-sm text-ink-100 focus:outline-none"
          />
        ) : (
          <div className="truncate text-ink-100" onDoubleClick={(e) => (e.stopPropagation(), setEditing(true))} title="Double-click to rename">
            {s.title}
          </div>
        )}
        <div className="text-[11px] text-ink-400">
          {s.messageCount} msgs · {timeAgo(s.updatedAt)}
        </div>
      </div>
      <div className="flex opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        <button type="button" className="text-ink-400 hover:text-ink-100 text-xs px-1" title="Rename" aria-label="Rename session" onClick={(e) => (e.stopPropagation(), setEditing(true))}>
          ✎
        </button>
        <button type="button" className="text-ink-400 hover:text-ink-100 text-xs px-1" title="Export" aria-label="Export session" aria-expanded={menu} onClick={(e) => (e.stopPropagation(), setMenu((m) => !m))}>
          ⤓
        </button>
        <button
          type="button"
          className="text-ink-400 hover:text-danger text-xs px-1"
          title="Delete session"
          aria-label="Delete session"
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Delete "${s.title}"?`)) {
              send({ type: 'delete_session', id: s.id });
              if (current) newSession();
            }
          }}
        >
          ✕
        </button>
      </div>
      {menu && (
        <div className="absolute right-2 top-9 z-10 rounded-md border border-ink-600 bg-ink-900 py-1 text-xs shadow-lg" onClick={(e) => e.stopPropagation()} onMouseLeave={() => setMenu(false)}>
          <a className="block px-3 py-1 hover:bg-ink-800" href={exportUrl(s.id, 'md')} download onClick={() => setMenu(false)}>
            Export as Markdown
          </a>
          <a className="block px-3 py-1 hover:bg-ink-800" href={exportUrl(s.id, 'json')} download onClick={() => setMenu(false)}>
            Export as JSON
          </a>
        </div>
      )}
    </div>
  );
}
