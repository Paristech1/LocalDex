import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientEvent, ServerEvent } from '@localdex/shared';
import { DATA_DIR, expandHome, getSettings, updateSettings } from './config.js';
import { listModels } from './lmstudio.js';
import { createSession, deleteSession, flushAll, getSession, listSessions, saveSession } from './store.js';
import { bus } from './agent/bus.js';
import { dropRunner, runnerFor } from './agent/runner.js';
import { closeAllTerminals } from './tools/terminal.js';

const PORT = Number(process.env.PORT ?? 7331);
const here = path.dirname(fileURLToPath(import.meta.url));
// server/src → ../../web/dist. Set LOCALDEX_NO_STATIC=1 to force API-only mode (e.g. when using the Vite dev server).
const webDist = process.env.LOCALDEX_NO_STATIC
  ? undefined
  : [path.resolve(here, '../../web/dist')].find((p) => fs.existsSync(path.join(p, 'index.html')));

const app = new Hono();

app.get('/api/health', (c) => c.json({ ok: true, dataDir: DATA_DIR, settings: getSettings() }));

/** Directory listing for the folder picker in Settings → Workspace (directories only). */
app.get('/api/fs/dirs', (c) => {
  const q = c.req.query('path') || os.homedir();
  const dir = path.resolve(expandHome(q));
  try {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    return c.json({ path: dir, parent: path.dirname(dir), dirs: entries });
  } catch (e) {
    return c.json({ error: (e as Error).message, path: dir, parent: path.dirname(dir), dirs: [] }, 400);
  }
});

if (webDist) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), webDist) || '.' }));
  app.get('*', (c) => c.html(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8')));
} else {
  app.get('/', (c) => c.text('LocalDex server running. Start the web UI with `npm run dev -w web` (http://localhost:5173).'));
}

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`LocalDex server  →  http://localhost:${PORT}${webDist ? '' : '  (API only; UI dev server on :5173)'}`);
  console.log(`Data dir         →  ${DATA_DIR}`);
  console.log(`LM Studio        →  ${getSettings().baseUrl}`);
});

// ---------- WebSocket ----------

const wss = new WebSocketServer({ server: server as import('node:http').Server, path: '/ws' });
let modelsCache: Awaited<ReturnType<typeof listModels>> = [];

function send(ws: WebSocket, ev: ServerEvent): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
}

bus.subscribe((ev) => {
  const data = JSON.stringify(ev);
  for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(data);
});

async function refreshModels(): Promise<void> {
  try {
    modelsCache = await listModels();
    if (!getSettings().model && modelsCache.length) {
      const loaded = modelsCache.find((m) => m.loaded) ?? modelsCache[0];
      updateSettings({ model: loaded.id });
      bus.emit({ type: 'settings', settings: getSettings() });
    }
    bus.emit({ type: 'models', models: modelsCache });
  } catch (e) {
    bus.emit({ type: 'models', models: modelsCache, error: `LM Studio unreachable at ${getSettings().baseUrl}: ${(e as Error).message}` });
  }
}

wss.on('connection', (ws) => {
  const sessions = listSessions();
  const current = sessions[0] ? getSession(sessions[0].id) : null;
  send(ws, { type: 'hello', settings: getSettings(), sessions, session: current, models: modelsCache });
  void refreshModels();

  ws.on('message', async (raw) => {
    let ev: ClientEvent;
    try {
      ev = JSON.parse(raw.toString()) as ClientEvent;
    } catch {
      return;
    }
    try {
      await handle(ws, ev);
    } catch (e) {
      send(ws, { type: 'error', message: (e as Error).message });
    }
  });
});

async function handle(ws: WebSocket, ev: ClientEvent): Promise<void> {
  switch (ev.type) {
    case 'send_message': {
      const s = getSession(ev.sessionId);
      if (!s) return send(ws, { type: 'error', message: 'Session not found' });
      void runnerFor(s).handleUserMessage(ev.content);
      return;
    }
    case 'new_session': {
      const s = createSession(getSettings().model);
      send(ws, { type: 'session', session: s });
      bus.emit({ type: 'sessions', sessions: listSessions() });
      return;
    }
    case 'load_session': {
      const s = getSession(ev.id);
      if (!s) return send(ws, { type: 'error', message: 'Session not found' });
      runnerFor(s);
      return send(ws, { type: 'session', session: s });
    }
    case 'delete_session': {
      dropRunner(ev.id);
      deleteSession(ev.id);
      bus.emit({ type: 'sessions', sessions: listSessions() });
      return;
    }
    case 'rename_session': {
      const s = getSession(ev.id);
      if (!s) return;
      s.title = ev.title.slice(0, 80) || s.title;
      saveSession(s);
      bus.emit({ type: 'sessions', sessions: listSessions() });
      return;
    }
    case 'stop': {
      const s = getSession(ev.sessionId);
      if (s) runnerFor(s).stop();
      return;
    }
    case 'set_settings': {
      const settings = updateSettings(ev.patch);
      bus.emit({ type: 'settings', settings });
      if (ev.patch.baseUrl) void refreshModels();
      return;
    }
    case 'list_models':
      return void refreshModels();
    case 'set_model': {
      const s = getSession(ev.sessionId);
      if (!s) return;
      s.model = ev.model;
      saveSession(s);
      updateSettings({ model: ev.model });
      bus.emit({ type: 'settings', settings: getSettings() });
      bus.emit({ type: 'session', session: s });
      return;
    }
    case 'approval_response':
      if (!bus.resolvePrompt(ev.id, ev.approved)) send(ws, { type: 'error', message: 'That prompt is no longer pending.' });
      return;
    case 'ask_user_response':
      if (!bus.resolvePrompt(ev.id, ev.answer)) send(ws, { type: 'error', message: 'That prompt is no longer pending.' });
      return;
    case 'set_goal': {
      const s = getSession(ev.sessionId);
      if (!s) return;
      const r = runnerFor(s);
      r.setGoal(ev.goal);
      if (!r.running) void r.startGoalRun();
      return;
    }
    case 'clear_goal': {
      const s = getSession(ev.sessionId);
      if (s) runnerFor(s).clearGoal();
      return;
    }
    case 'compact': {
      const s = getSession(ev.sessionId);
      if (!s) return;
      try {
        await runnerFor(s).compact();
        bus.log('info', 'Context compacted. Continue chatting; the summary is now the conversation start.');
      } catch (e) {
        send(ws, { type: 'error', sessionId: s.id, message: `Compact failed: ${(e as Error).message}` });
      }
      return;
    }
    case 'reset_worker': {
      const s = getSession(ev.sessionId);
      const w = s?.workers[ev.name];
      if (!s || !w || w.status === 'running') return;
      if (w.messages.length) w.archive.push(w.messages.slice());
      w.messages = [];
      w.lastResult = null;
      saveSession(s);
      bus.emit({ type: 'session', session: s });
      return;
    }
    case 'delete_worker': {
      const s = getSession(ev.sessionId);
      if (!s || s.workers[ev.name]?.status === 'running') return;
      delete s.workers[ev.name];
      saveSession(s);
      bus.emit({ type: 'session', session: s });
      return;
    }
  }
}

function shutdown(): void {
  console.log('\nShutting down…');
  closeAllTerminals();
  flushAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
