// A3: a read-only LSP client for the `lsp` tool: definition, references, implementation, hover.
// Pattern from DeepSeek Harness lsp/lsp-stdio + tool-lsp (stdio servers chosen by file extension, 1-based
// positions, results grouped by file and capped), reimplemented. Servers are found on PATH; none are installed.
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { getSettings } from './config.js';
import { approvedFolders } from './tools/permissions.js';

export type LspOperation = 'definition' | 'references' | 'implementation' | 'hover';

interface ServerSpec {
  id: string;
  command: string;
  args: string[];
  languageId: (ext: string) => string;
  install: string;
}

const TS: ServerSpec = { id: 'typescript', command: 'typescript-language-server', args: ['--stdio'], languageId: (e) => ({ '.ts': 'typescript', '.tsx': 'typescriptreact', '.jsx': 'javascriptreact' })[e] ?? 'javascript', install: 'npm i -g typescript-language-server typescript' };
const PY: ServerSpec = { id: 'python', command: 'pyright-langserver', args: ['--stdio'], languageId: () => 'python', install: 'npm i -g pyright' };
const GO: ServerSpec = { id: 'go', command: 'gopls', args: [], languageId: () => 'go', install: 'go install golang.org/x/tools/gopls@latest' };
const RS: ServerSpec = { id: 'rust', command: 'rust-analyzer', args: [], languageId: () => 'rust', install: 'rustup component add rust-analyzer' };

const BY_EXT: Record<string, ServerSpec> = { '.ts': TS, '.tsx': TS, '.js': TS, '.jsx': TS, '.mjs': TS, '.cjs': TS, '.py': PY, '.go': GO, '.rs': RS };

export function serverFor(file: string): ServerSpec | null {
  const ext = path.extname(file).toLowerCase();
  const custom = getSettings().lspServers?.[ext];
  if (custom?.command) return { id: `custom${ext}`, command: custom.command, args: custom.args ?? [], languageId: () => custom.languageId ?? ext.slice(1), install: '(configured in ~/.localdex/config.json)' };
  return BY_EXT[ext] ?? null;
}

export function onPath(bin: string): boolean {
  if (path.isAbsolute(bin)) return fs.existsSync(bin);
  return (process.env.PATH ?? '').split(path.delimiter).some((d) => {
    try {
      fs.accessSync(path.join(d, bin), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

class LspConnection {
  private proc: ChildProcess;
  private buf = Buffer.alloc(0);
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private opened = new Map<string, number>(); // uri → mtimeMs
  private idle: NodeJS.Timeout | null = null;
  ready: Promise<void>;
  dead = false;
  stderr = '';

  constructor(readonly spec: ServerSpec, readonly root: string, private onExit: () => void) {
    this.proc = spawn(spec.command, spec.args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
    this.proc.stdout!.on('data', (d: Buffer) => this.onData(d));
    this.proc.stderr!.on('data', (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-2000)));
    this.proc.on('exit', () => this.die('the language server exited'));
    this.proc.on('error', (e) => this.die(e.message));
    this.ready = this.initialize();
    this.touch();
  }

  private die(why: string) {
    if (this.dead) return;
    this.dead = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
    }
    this.pending.clear();
    if (this.idle) clearTimeout(this.idle);
    this.onExit();
  }

  /** Stop after 5 idle minutes. */
  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), 5 * 60_000);
    this.idle.unref?.();
  }

  close() {
    if (this.dead) return;
    try {
      this.notify('exit', null);
    } catch {
      /* ignore */
    }
    this.proc.kill();
    this.die('closed');
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const len = Number(/Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0, sep).toString())?.[1] ?? -1);
      if (len < 0 || this.buf.length < sep + 4 + len) return;
      const body = this.buf.subarray(sep + 4, sep + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(sep + 4 + len);
      let msg: { id?: number | string; method?: string; result?: unknown; error?: { message: string } };
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      if (msg.method && msg.id !== undefined) {
        // Requests from the server (configuration, capability registration, progress): answer so it never waits.
        const result = msg.method === 'workspace/configuration' ? [] : null;
        this.write({ jsonrpc: '2.0', id: msg.id, result });
      } else if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    }
  }

  private write(o: unknown) {
    const s = JSON.stringify(o);
    this.proc.stdin!.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
  }

  request<T>(method: string, params: unknown, timeoutMs = 20_000): Promise<T> {
    if (this.dead) return Promise.reject(new Error('language server is not running'));
    this.touch();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private async initialize() {
    await this.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(this.root).href,
      workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }],
      capabilities: {
        textDocument: {
          definition: { linkSupport: true },
          references: {},
          implementation: { linkSupport: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          synchronization: { didSave: false },
        },
        workspace: { workspaceFolders: true, configuration: true },
        general: { positionEncodings: ['utf-16'] },
      },
      ...(this.spec.id === 'typescript' ? { initializationOptions: tsInitOptions() } : {}),
    }, 60_000);
    this.notify('initialized', {});
  }

  /** Open (or refresh) a document so the server knows its current text. */
  sync(file: string) {
    const uri = pathToFileURL(file).href;
    const mtime = fs.statSync(file).mtimeMs;
    const prev = this.opened.get(uri);
    if (prev === mtime) return;
    const text = fs.readFileSync(file, 'utf8');
    if (prev !== undefined) this.notify('textDocument/didClose', { textDocument: { uri } });
    this.notify('textDocument/didOpen', { textDocument: { uri, languageId: this.spec.languageId(path.extname(file).toLowerCase()), version: Math.floor(mtime), text } });
    this.opened.set(uri, mtime);
  }
}

/**
 * typescript-language-server needs a TypeScript install: the project's own, else this fallback — the copy LocalDex
 * itself ships with — so it works on projects that don't depend on TypeScript.
 */
function tsInitOptions(): Record<string, unknown> {
  try {
    const tsserver = createRequire(import.meta.url).resolve('typescript/lib/tsserver.js');
    return { tsserver: { fallbackPath: path.dirname(tsserver) } };
  } catch {
    return {};
  }
}

const conns = new Map<string, LspConnection>();

/** The project root a file belongs to: the approved folder that contains it. */
function rootFor(file: string): string {
  const folders = approvedFolders();
  return folders.find((f) => file === f || file.startsWith(f + path.sep)) ?? folders[0] ?? path.dirname(file);
}

function connectionFor(spec: ServerSpec, root: string): LspConnection {
  const key = `${spec.id}\0${root}`;
  const hit = conns.get(key);
  if (hit && !hit.dead) return hit;
  const c = new LspConnection(spec, root, () => conns.delete(key));
  conns.set(key, c);
  return c;
}

export function closeAllLsp(): void {
  for (const c of conns.values()) c.close();
  conns.clear();
}

interface Loc {
  uri: string;
  range: { start: { line: number; character: number } };
}

function toLocs(r: unknown): Loc[] {
  const arr = Array.isArray(r) ? r : r ? [r] : [];
  return arr
    .map((x: { uri?: string; range?: Loc['range']; targetUri?: string; targetSelectionRange?: Loc['range']; targetRange?: Loc['range'] }) =>
      x.uri && x.range ? { uri: x.uri, range: x.range } : x.targetUri ? { uri: x.targetUri, range: (x.targetSelectionRange ?? x.targetRange)! } : null,
    )
    .filter((x): x is Loc => !!x && !!x.range);
}

function hoverText(r: unknown): string {
  const c = (r as { contents?: unknown } | null)?.contents;
  if (!c) return '';
  const one = (v: unknown): string => (typeof v === 'string' ? v : v && typeof v === 'object' && 'value' in v ? String((v as { value: unknown }).value) : '');
  return (Array.isArray(c) ? c.map(one) : [one(c)]).filter(Boolean).join('\n\n').trim();
}

/** Resolve a 1-based column: the given character, or where `symbol` first appears on that line. */
export function columnFor(lineText: string, symbol?: string, character?: number): number | null {
  if (symbol) {
    const re = new RegExp(`(^|[^A-Za-z0-9_$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_$])`);
    const m = re.exec(lineText);
    if (m) return m.index + m[1].length + 1;
    const plain = lineText.indexOf(symbol);
    return plain >= 0 ? plain + 1 : null;
  }
  return character && character > 0 ? character : null;
}

const MAX_LOCS = 50;

/** Run one read-only LSP operation; returns text for the model. Throws with an install hint when no server exists. */
export async function lspQuery(op: LspOperation, file: string, line: number, column: number): Promise<string> {
  const spec = serverFor(file);
  if (!spec) throw new Error(`No language server for ${path.extname(file) || 'this file type'}. Supported: TypeScript/JavaScript, Python, Go, Rust (or add one under "lspServers" in ~/.localdex/config.json).`);
  if (!onPath(spec.command)) throw new Error(`${spec.command} is not installed (install: ${spec.install}). Use grep and read_file instead.`);
  const root = rootFor(file);
  const conn = connectionFor(spec, root);
  await conn.ready;
  conn.sync(file);
  const params = { textDocument: { uri: pathToFileURL(file).href }, position: { line: line - 1, character: column - 1 }, ...(op === 'references' ? { context: { includeDeclaration: false } } : {}) };
  const method = op === 'hover' ? 'textDocument/hover' : `textDocument/${op}`;
  // A server that is still loading the project can answer empty at first: retry a few times.
  let result: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    result = await conn.request(method, params);
    const empty = op === 'hover' ? !hoverText(result) : toLocs(result).length === 0;
    if (!empty) break;
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  if (op === 'hover') {
    const h = hoverText(result);
    return h ? h.slice(0, 2000) : 'No hover information at that position.';
  }
  let locs = toLocs(result);
  // TypeScript answers "definition" of an imported name with the import line (an alias); "implementation" at the
  // same spot resolves to the real declaration, so use that instead.
  if (op === 'definition' && locs.length === 1) {
    let lineText = '';
    try {
      lineText = fs.readFileSync(fileURLToPath(locs[0].uri), 'utf8').split('\n')[locs[0].range.start.line] ?? '';
    } catch {
      /* ignore */
    }
    if (/^\s*(import\b|export\s+(\{|\*))/.test(lineText)) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const impl = toLocs(await conn.request('textDocument/implementation', params).catch(() => null));
        if (impl.length) {
          locs = impl;
          break;
        }
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  }
  if (!locs.length) return `No ${op} found at ${path.relative(root, file) || file}:${line}:${column}.`;
  const folders = approvedFolders();
  const byFile = new Map<string, number[]>();
  for (const l of locs.slice(0, MAX_LOCS)) {
    const p = fileURLToPath(l.uri);
    byFile.set(p, [...(byFile.get(p) ?? []), l.range.start.line + 1]);
  }
  const out: string[] = [`${op}: ${locs.length} location${locs.length === 1 ? '' : 's'}${locs.length > MAX_LOCS ? ` (first ${MAX_LOCS} shown)` : ''}`];
  for (const [p, lines] of byFile) {
    const inside = folders.some((f) => p.startsWith(f + path.sep));
    const shown = inside ? path.relative(root, p) : p;
    let text: string[] = [];
    if (inside) {
      try {
        text = fs.readFileSync(p, 'utf8').split('\n');
      } catch {
        /* ignore */
      }
    }
    out.push(shown);
    for (const ln of [...new Set(lines)].sort((a, b) => a - b)) out.push(`  ${ln}: ${(text[ln - 1] ?? '').trim().slice(0, 160)}`);
  }
  return out.join('\n');
}
