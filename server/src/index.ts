import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientEvent, CouncilRunAccess, CouncilWorktree, ServerEvent } from '@localdex/shared';
import { MEMBER_IDS } from '@localdex/shared';
import { DATA_DIR, applyMcpToggles, expandHome, getSettings, stripCouncilCommands, updateSettings } from './config.js';
import { MEMBERS, cachedStatuses, memberStatuses } from './council/registry.js';
import { getStats, resetStats } from './council/stats.js';
import { cleanupStaleWorktrees } from './council/worktrees.js';
import { applyArenaEntry, applyRunChanges, discardArena, discardRunChanges, discardSessionCopies } from './council/orchestrator.js';
import { waitingCopyPaths } from './council/recover.js';
import { listModels, reloadModel } from './lmstudio.js';
import { createSession, deleteSession, flushAll, getSession, listSessions, saveSession } from './store.js';
import { bus } from './agent/bus.js';
import { dropRunner, runnerFor } from './agent/runner.js';
import { PTY_UNAVAILABLE_NOTE, closeAllTerminals, ptyAvailable } from './tools/terminal.js';
import { deleteSpill } from './spill.js';
import { killAllJobs, killJob, listJobs } from './jobs.js';
import { deleteCheckpoints, turnDiff, undoTurn } from './checkpoints.js';
import { resetReads } from './tools/readTracker.js';
import { forgetInstructions } from './agent/instructions.js';
import { unavailableTools } from './tools/index.js';
import { sandboxStatus } from './sandbox.js';
import { forgeStatus, openPullRequest, refreshPullRequest } from './council/forge.js';
import { feedbackStats, rateMessage } from './feedback.js';
import { searchFiles } from './fileMentions.js';
import { closeAllLsp } from './lsp.js';
import { attachmentPath, isAttachmentId, saveImage } from './attachments.js';
import { forkAt, isEditableUserMessage } from './fork.js';
import { exportFileName, exportMarkdown, searchSessions } from './sessionTools.js';
import { closeAllMcp, mcpStatuses, reloadMcp, restartMcp } from './mcp/client.js';
import { doctorReports, doctorRunning, runDoctor, stopDoctor } from './doctor.js';
import { addFromGallery, mcpGallery, removeServer, setAllowTools } from './mcp/gallery.js';
import { LIMITS, listSkills, removeSkill, setSkillEnabled } from './skills/store.js';
import { BIND_HOST, checkRequest, checkUpgrade } from './security.js';
import { importFromGithub, importFromUpload } from './skills/import.js';
import { ensurePlayground, installMember, scanLocalServers } from './setup.js';

const PORT = Number(process.env.PORT ?? 7331);
const here = path.dirname(fileURLToPath(import.meta.url));
// server/src → ../../web/dist. Set LOCALDEX_NO_STATIC=1 to force API-only mode (e.g. when using the Vite dev server).
const webDist = process.env.LOCALDEX_NO_STATIC
  ? undefined
  : [path.resolve(here, '../../web/dist')].find((p) => fs.existsSync(path.join(p, 'index.html')));

const app = new Hono();

// Reject foreign Host (DNS rebinding) and foreign Origin / cross-site requests on every API route.
app.use('/api/*', async (c, next) => {
  const why = checkRequest(c.req.header('host'), c.req.header('origin'), c.req.header('sec-fetch-site'));
  if (why) return c.json({ ok: false, error: why }, 403);
  await next();
});

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

// ---------- First-run setup ----------

/** Local model servers LocalDex can reach (configured one, LM Studio, Ollama, plus ?url=). */
app.get('/api/setup/scan', async (c) => c.json({ servers: await scanLocalServers(c.req.query('url') || undefined) }));

/** Install a council member's official CLI with npm (fixed package list), then re-check every member. */
app.post('/api/setup/install', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { member?: string };
  const member = MEMBER_IDS.find((m) => m === body.member);
  if (!member) return c.json({ ok: false, output: 'Unknown member.' }, 400);
  const r = await installMember(member);
  bus.log(r.ok ? 'info' : 'warn', `[setup] npm install for ${member} ${r.ok ? 'finished' : 'failed'}`);
  await memberStatuses(true).catch(() => undefined);
  return c.json(r, r.ok ? 200 : 500);
});

/** Make (or reuse) ~/LocalDex Playground and return its path. Approving it is a separate settings change. */
app.post('/api/setup/playground', (c) => {
  try {
    return c.json({ ok: true, path: ensurePlayground() });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

// ---------- Skills ----------

app.get('/api/skills', (c) => c.json({ skills: listSkills() }));

// U1: search every session's title and messages; export one session as Markdown or JSON.
// A7: image attachments (pasted or dropped in the composer). Content is sniffed; only PNG/JPEG/WebP/GIF up to 10 MB.
app.post('/api/attachments', async (c) => {
  try {
    const body = (await c.req.json()) as { dataBase64?: string };
    const buf = Buffer.from(String(body.dataBase64 ?? ''), 'base64');
    return c.json({ id: saveImage(buf) });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});
app.get('/api/attachments/:id', (c) => {
  const p = attachmentPath(c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  const ext = p.split('.').pop()!;
  return c.body(fs.readFileSync(p), 200, { 'Content-Type': ext === 'jpg' ? 'image/jpeg' : `image/${ext}`, 'Cache-Control': 'private, max-age=31536000, immutable' });
});
// A6: path completion for @mentions in the composer (first approved folder, protected files skipped).
app.get('/api/files/search', (c) => c.json({ files: searchFiles(c.req.query('q') ?? '') }));
app.get('/api/sessions/search', (c) => c.json({ results: searchSessions(c.req.query('q') ?? '') }));
app.get('/api/sessions/:id/export', (c) => {
  const s = getSession(c.req.param('id'));
  if (!s) return c.json({ error: 'not found' }, 404);
  const json = c.req.query('format') === 'json';
  const name = exportFileName(s, json ? 'json' : 'md');
  c.header('Content-Disposition', `attachment; filename="${name}"`);
  if (json) return c.body(JSON.stringify(s, null, 2), 200, { 'Content-Type': 'application/json; charset=utf-8' });
  return c.body(exportMarkdown(s), 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
});

app.post('/api/skills/upload', async (c) => {
  if (Number(c.req.header('content-length') ?? 0) > LIMITS.maxUploadBytes + 1024 * 1024) {
    return c.json({ ok: false, added: [], updated: [], skipped: [], error: `Upload is bigger than ${LIMITS.maxUploadBytes / 1024 / 1024}MB.` }, 413);
  }
  try {
    const form = await c.req.formData();
    const files = form.getAll('files').filter((f): f is File => typeof f !== 'string');
    let paths: string[] = [];
    try {
      paths = JSON.parse(String(form.get('paths') ?? '[]'));
    } catch {
      /* fall back to file names */
    }
    const entries = await Promise.all(
      files.map(async (f, i) => ({ path: typeof paths[i] === 'string' && paths[i] ? paths[i] : f.name, data: Buffer.from(await f.arrayBuffer()) })),
    );
    return c.json(importFromUpload(entries));
  } catch (e) {
    return c.json({ ok: false, added: [], updated: [], skipped: [], error: (e as Error).message }, 400);
  }
});

app.post('/api/skills/github', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { url?: string };
  if (typeof body.url !== 'string' || !body.url.trim()) return c.json({ ok: false, added: [], updated: [], skipped: [], error: 'Paste a GitHub link.' }, 400);
  return c.json(await importFromGithub(body.url));
});

app.post('/api/skills/:name/enabled', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
  if (typeof body.enabled !== 'boolean') return c.json({ ok: false }, 400);
  if (!listSkills().some((s) => s.name === c.req.param('name'))) return c.json({ ok: false, error: 'No such skill.' }, 404);
  setSkillEnabled(c.req.param('name'), body.enabled);
  return c.json({ ok: true });
});

app.delete('/api/skills/:name', (c) => {
  return removeSkill(c.req.param('name')) ? c.json({ ok: true }) : c.json({ ok: false, error: 'No such skill.' }, 404);
});

if (webDist) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), webDist) || '.' }));
  app.get('*', (c) => c.html(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8')));
} else {
  app.get('/', (c) => c.text('LocalDex server running. Start the web UI with `npm run dev -w web` (http://localhost:5173).'));
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: BIND_HOST }, () => {
  console.log(`LocalDex server  →  http://localhost:${PORT}${BIND_HOST === '127.0.0.1' ? '' : `  (listening on ${BIND_HOST})`}${webDist ? '' : '  (API only; UI dev server on :5173)'}`);
  console.log(`Data dir         →  ${DATA_DIR}`);
  console.log(`LM Studio        →  ${getSettings().baseUrl}`);
  if (!ptyAvailable().ok) console.log(`Terminals        →  unavailable. ${PTY_UNAVAILABLE_NOTE}`);
  void reloadMcp();
  // Builder copies applied or discarded more than a week ago, and waiting copies whose session or run is gone.
  // Loading every session first also cancels runs a previous server left "running".
  try {
    const waiting = waitingCopyPaths(listSessions().map((x) => getSession(x.id)).filter((x): x is NonNullable<typeof x> => !!x));
    const n = cleanupStaleWorktrees(undefined, undefined, (rec) => !waiting.has(path.resolve(rec.path)));
    if (n) console.log(`Council          →  removed ${n} old separate cop${n === 1 ? 'y' : 'ies'}`);
  } catch (e) {
    console.warn(`Council: worktree cleanup failed: ${(e as Error).message}`);
  }
});

// ---------- WebSocket ----------

const wss = new WebSocketServer({
  server: server as import('node:http').Server,
  path: '/ws',
  // Browsers cannot forge Origin/Host, so this stops other websites from driving the agent.
  verifyClient: (info, done) => {
    const why = checkUpgrade(info.req);
    if (why) {
      console.warn(`Rejected WebSocket connection: ${why} (origin=${info.req.headers.origin ?? '-'}, host=${info.req.headers.host ?? '-'})`);
      return done(false, 403, why);
    }
    done(true);
  },
});
let modelsCache: Awaited<ReturnType<typeof listModels>> = [];
let loginAbort: AbortController | null = null;
/** Sends a pasted code to the sign-in that is waiting for one. */
let loginInput: { member: string; write: (text: string) => void } | null = null;

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
  send(ws, { type: 'hello', settings: getSettings(), sessions, session: current, models: modelsCache, unavailableTools: unavailableTools(), sandbox: sandboxStatus(), forge: forgeStatus() });
  send(ws, { type: 'mcp_status', servers: mcpStatuses() });
  send(ws, { type: 'mcp_gallery', entries: mcpGallery() });
  send(ws, { type: 'doctor_reports', reports: doctorReports() });
  send(ws, { type: 'skills', skills: listSkills() });
  const cached = cachedStatuses();
  if (cached.length) send(ws, { type: 'council_status', members: cached });
  send(ws, { type: 'council_stats', stats: getStats() });
  send(ws, { type: 'feedback_stats', stats: feedbackStats() });
  void memberStatuses().catch(() => undefined);
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
      const images = Array.isArray(ev.images) ? ev.images.filter((x) => typeof x === 'string' && isAttachmentId(x)) : undefined;
      void runnerFor(s).handleUserMessage(ev.content, parseRunAccess(ev.access), ev.notRisky === true, images);
      return;
    }
    case 'council_escalate': {
      const s = getSession(ev.sessionId);
      if (!s) return send(ws, { type: 'error', message: 'Session not found' });
      if (!getSettings().council.enabled) return send(ws, { type: 'error', sessionId: s.id, message: 'Turn on the model council in Settings → Council first.' });
      const member = MEMBER_IDS.find((m) => m === ev.member);
      void runnerFor(s).escalate({ pattern: ev.pattern, member, note: typeof ev.note === 'string' ? ev.note : undefined, access: parseRunAccess(ev.access), notRisky: ev.notRisky === true });
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
      send(ws, { type: 'session', session: s });
      return send(ws, { type: 'jobs', sessionId: s.id, jobs: listJobs(s.id) });
    }
    case 'delete_session': {
      const gone = getSession(ev.id);
      dropRunner(ev.id);
      // Its waiting copies could never be applied any more.
      if (gone) discardSessionCopies(gone);
      deleteSpill(ev.id);
      deleteCheckpoints(ev.id);
      forgetInstructions(ev.id);
      deleteSession(ev.id);
      bus.emit({ type: 'sessions', sessions: listSessions() });
      return;
    }
    case 'message_feedback': {
      const s = getSession(ev.sessionId);
      if (!s || !Number.isInteger(ev.messageIndex)) return;
      if (rateMessage(s, ev.messageIndex, ev.rating === 'up' || ev.rating === 'down' ? ev.rating : null, ev.category)) {
        saveSession(s);
        bus.emit({ type: 'session', session: s });
      }
      return;
    }
    case 'fork_session': {
      const src = getSession(ev.sessionId);
      if (!src || !Number.isInteger(ev.messageIndex)) return;
      const f = forkAt(src, ev.messageIndex + 1);
      runnerFor(f);
      send(ws, { type: 'session', session: f });
      bus.emit({ type: 'sessions', sessions: listSessions() });
      return;
    }
    case 'edit_message': {
      const src = getSession(ev.sessionId);
      const content = String(ev.content ?? '').trim();
      if (!src || !content || !Number.isInteger(ev.messageIndex)) return;
      if (!isEditableUserMessage(src, ev.messageIndex)) return send(ws, { type: 'error', sessionId: src.id, message: 'Only your own messages can be edited.' });
      const f = forkAt(src, ev.messageIndex, `${src.title} (edited)`);
      send(ws, { type: 'session', session: f });
      bus.emit({ type: 'sessions', sessions: listSessions() });
      void runnerFor(f).handleUserMessage(content);
      return;
    }
    case 'rename_session': {
      const s = getSession(ev.id);
      if (!s) return;
      const title = ev.title.trim().slice(0, 80);
      if (!title) return;
      s.title = title;
      s.titleSource = 'user';
      saveSession(s);
      bus.emit({ type: 'sessions', sessions: listSessions() });
      return;
    }
    case 'stop': {
      const s = getSession(ev.sessionId);
      if (s) runnerFor(s).stop();
      return;
    }
    case 'mcp_gallery_add': {
      const r = addFromGallery(ev.id, ev.confirmName);
      bus.emit({ type: 'mcp_notice', ok: r.ok, message: r.message });
      if (!r.ok) return;
      bus.emit({ type: 'settings', settings: getSettings() });
      bus.emit({ type: 'mcp_gallery', entries: mcpGallery() });
      void reloadMcp();
      return;
    }
    case 'mcp_set_tools': {
      const st = mcpStatuses().find((x) => x.name === ev.name);
      const r = setAllowTools(ev.name, Array.isArray(ev.allowTools) ? ev.allowTools.map(String) : [], st?.availableTools ?? []);
      bus.emit({ type: 'mcp_notice', ok: r.ok, message: r.message });
      if (!r.ok) return;
      bus.emit({ type: 'settings', settings: getSettings() });
      void reloadMcp();
      return;
    }
    case 'mcp_remove': {
      const r = removeServer(ev.name);
      bus.emit({ type: 'mcp_notice', ok: r.ok, message: r.message });
      if (!r.ok) return;
      bus.emit({ type: 'settings', settings: getSettings() });
      bus.emit({ type: 'mcp_gallery', entries: mcpGallery() });
      void reloadMcp();
      return;
    }
    case 'doctor_run': {
      if (doctorRunning()) return;
      void runDoctor(ev.model)
        .then(() => bus.emit({ type: 'doctor_reports', reports: doctorReports() }))
        .catch((e) => bus.emit({ type: 'error', message: `Model doctor: ${(e as Error).message}` }));
      return;
    }
    case 'doctor_stop':
      stopDoctor();
      return;
    case 'mcp_test': {
      if (!getSettings().mcpServers?.[ev.name]) return;
      void restartMcp(ev.name);
      return;
    }
    case 'set_settings': {
      // MCP server definitions run local programs, so only enable/disable toggles are accepted over the socket.
      // sandboxExtraWritable widens what a sandboxed shell may write: config file only, like MCP commands.
      const { mcpServers, council, sandboxExtraWritable: _extra, lspServers: _lsp, ...rest } = ev.patch;
      void _extra;
      void _lsp;
      if (rest.permissionPreset !== undefined && !['full', 'workspace', 'read-only'].includes(rest.permissionPreset)) delete rest.permissionPreset;
      let settings = updateSettings(council ? { ...rest, council: stripCouncilCommands(council) as typeof council } : rest);
      if (mcpServers) {
        settings = applyMcpToggles(mcpServers);
        void reloadMcp();
      }
      bus.emit({ type: 'settings', settings });
      if (rest.baseUrl) void refreshModels();
      if (council?.members) void memberStatuses(true).catch(() => undefined);
      return;
    }
    case 'set_mode': {
      const s = getSession(ev.sessionId);
      if (!s) return;
      if (ev.mode === 'council' && !getSettings().council.enabled) {
        return send(ws, { type: 'error', sessionId: s.id, message: 'Turn on the model council in Settings → Council first.' });
      }
      runnerFor(s).setMode(ev.mode === 'council' ? 'council' : 'solo');
      return;
    }
    case 'council_refresh':
      void memberStatuses(true, ev.deep === true).catch((e) => send(ws, { type: 'error', message: `Council status check failed: ${(e as Error).message}` }));
      return;
    case 'council_stats_reset':
      resetStats();
      return;
    case 'council_new_conversation': {
      const s = getSession(ev.sessionId);
      if (s) runnerFor(s).clearMemberSessions();
      return;
    }
    case 'council_apply':
    case 'council_discard': {
      const s = getSession(ev.sessionId);
      const run = s?.councilRuns?.find((r) => r.id === ev.runId);
      if (!s || !(run?.worktree || run?.arena)) return send(ws, { type: 'error', message: 'No waiting changes for that council run.' });
      if (run.status === 'running') return send(ws, { type: 'error', sessionId: s.id, message: 'Wait for the council run to finish first.' });
      let wts: Array<CouncilWorktree | undefined>;
      if (run.arena) {
        const member = ev.member;
        if (member && !run.arena.entries.some((x) => x.member === member)) return send(ws, { type: 'error', sessionId: s.id, message: 'That member did not race in this arena.' });
        if (ev.type === 'council_apply' && !member) return send(ws, { type: 'error', sessionId: s.id, message: 'Pick which version to keep.' });
        wts = ev.type === 'council_apply' ? [applyArenaEntry(run, member!)] : discardArena(run, member);
      } else {
        wts = [ev.type === 'council_apply' ? applyRunChanges(run) : discardRunChanges(run)];
      }
      saveSession(s);
      bus.emit({ type: 'session', session: s });
      for (const wt of wts) if (wt?.error) bus.log('warn', `[council] ${wt.error}`);
      return;
    }
    case 'council_open_pr':
    case 'council_pr_refresh': {
      const s = getSession(ev.sessionId);
      const run = s?.councilRuns?.find((r) => r.id === ev.runId);
      if (!s || !run?.worktree) return send(ws, { type: 'error', message: 'No separate copy for that council run.' });
      if (run.status === 'running') return send(ws, { type: 'error', sessionId: s.id, message: 'Wait for the council run to finish first.' });
      const r = ev.type === 'council_open_pr' ? openPullRequest(run, run.worktree) : refreshPullRequest(run.worktree);
      if (!r.ok) send(ws, { type: 'error', sessionId: s.id, message: r.message });
      else bus.log('info', `[council] ${r.message}`);
      saveSession(s);
      bus.emit({ type: 'session', session: s });
      return;
    }
    case 'council_login': {
      // The vendor's own browser sign-in (subscription login). One at a time: a new one cancels the last.
      const member = MEMBER_IDS.find((m) => m === ev.member);
      const adapter = member ? MEMBERS[member] : undefined;
      if (!member || !adapter?.login) return send(ws, { type: 'error', message: `${adapter?.label ?? ev.member} signs in from Terminal; see Settings → Council.` });
      loginAbort?.abort();
      const ac = new AbortController();
      loginAbort = ac;
      setTimeout(() => ac.abort(), 5 * 60_000).unref();
      let url: string | undefined;
      bus.emit({ type: 'council_login', member });
      const r = await adapter.login(
        {
          onUrl: (u) => {
            url = u;
            bus.emit({ type: 'council_login', member, url: u });
          },
          onNeedsCode: () => bus.emit({ type: 'council_login', member, url, needsCode: true }),
          setInput: (write) => {
            if (write) loginInput = { member, write };
            else if (loginInput?.member === member) loginInput = null;
          },
        },
        ac.signal,
      );
      if (loginAbort === ac) loginAbort = null;
      bus.emit({ type: 'council_login', member, done: true, error: r.ok ? undefined : r.error });
      void memberStatuses(true).catch(() => undefined);
      return;
    }
    case 'council_login_code': {
      const code = typeof ev.code === 'string' ? ev.code.trim() : '';
      if (!code || code.length > 2000 || /[\r\n]/.test(code)) return send(ws, { type: 'error', message: 'Paste the code exactly as the sign-in page shows it.' });
      if (!loginInput || loginInput.member !== ev.member) return send(ws, { type: 'error', message: 'That sign-in is no longer waiting for a code. Start it again.' });
      loginInput.write(code);
      return;
    }
    case 'council_login_cancel':
      loginAbort?.abort();
      return;
    case 'list_models':
      return void refreshModels();
    case 'reload_model': {
      const ctx = Math.round(Number(ev.contextLength));
      if (!ev.model || !Number.isFinite(ctx) || ctx < 2048 || ctx > 1_048_576) {
        send(ws, { type: 'error', message: 'Pick a model and a context length between 2048 and 1048576.' });
        return;
      }
      bus.log('info', `Reloading ${ev.model} in LM Studio with ${ctx} tokens of context…`);
      void reloadModel(ev.model, ctx)
        .then(() => refreshModels())
        .catch((e) => {
          const msg = `Could not reload ${ev.model}: ${(e as Error).message}. Needs LM Studio 0.4+ (REST API v1); or reload it in LM Studio → Developer with a bigger Context Length.`;
          bus.log('error', msg);
          bus.emit({ type: 'error', message: msg });
        });
      return;
    }
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
    case 'undo_turn': {
      const s = getSession(ev.sessionId);
      if (!s) return;
      if (runnerFor(s).running) return send(ws, { type: 'error', sessionId: s.id, message: 'Wait for the current run to finish before undoing a turn.' });
      const r = undoTurn(s, ev.turnId);
      if (!r.ok) return send(ws, { type: 'error', sessionId: s.id, message: `Undo refused: ${r.error}` });
      saveSession(s);
      bus.emit({ type: 'session', session: s });
      return;
    }
    case 'get_turn_diff': {
      const s = getSession(ev.sessionId);
      if (!s) return;
      return send(ws, { type: 'turn_diff', sessionId: s.id, turnId: ev.turnId, diff: turnDiff(s.id, ev.turnId) });
    }
    case 'plan_approve': {
      const s = getSession(ev.sessionId);
      if (s) void runnerFor(s).approvePlan();
      return;
    }
    case 'plan_revise': {
      const s = getSession(ev.sessionId);
      if (!s) return;
      const feedback = typeof ev.feedback === 'string' ? ev.feedback.trim() : '';
      if (!feedback) return send(ws, { type: 'error', sessionId: s.id, message: 'Say what should change in the plan.' });
      void runnerFor(s).revisePlan(feedback);
      return;
    }
    case 'plan_cancel': {
      const s = getSession(ev.sessionId);
      if (s) runnerFor(s).cancelPlan();
      return;
    }
    case 'job_kill': {
      const s = getSession(ev.sessionId);
      if (!s) return;
      const r = killJob(s.id, String(ev.jobId));
      if (!r.ok) send(ws, { type: 'error', sessionId: s.id, message: r.message });
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
      resetReads(s.id, `worker:${ev.name}`);
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
  killAllJobs();
  // Stop MCP server processes (e.g. the browser) before exiting, but never hang on them.
  closeAllLsp();
  void Promise.race([closeAllMcp(), new Promise((r) => setTimeout(r, 3000))]).finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/** Only the three known access modes are accepted from the socket; anything else means "use Settings". */
function parseRunAccess(v: unknown): CouncilRunAccess | undefined {
  return v === 'read' || v === 'confirm' || v === 'auto' ? v : undefined;
}
