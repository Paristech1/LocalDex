// A8: alternative edit tools for models trained on a specific format. Both are thin layers over read_file /
// write_file / edit_file, so read-before-edit (S1), checkpoints + Undo (S2) and the Read only preset (S3) apply.
// Patterns from DeepSeek Harness fs/fs-patch (Codex-style patches) and fs/tool-str-replace-editor, reimplemented.
import fs from 'node:fs';
import { resolvePath } from './permissions.js';
import { fail, ok, optNum, optStr, str, type ToolContext, type ToolDef, type ToolResult } from './types.js';
import { edit_file, read_file, write_file } from './fs.js';

// ---------- Codex-style patch ----------

export interface PatchOp {
  kind: 'add' | 'update' | 'delete';
  path: string;
  /** add: the new file's lines. */
  lines?: string[];
  /** update: hunks of context (' '), removed ('-') and added ('+') lines. */
  hunks?: string[][];
}

/** Parse "*** Begin Patch … *** End Patch". Throws with a short reason on malformed input. */
export function parsePatch(text: string): PatchOp[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = lines.findIndex((l) => l.trim() === '*** Begin Patch');
  if (i < 0) throw new Error('missing "*** Begin Patch"');
  const ops: PatchOp[] = [];
  let cur: PatchOp | null = null;
  let hunk: string[] | null = null;
  for (i++; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '*** End Patch') {
      if (cur) ops.push(cur);
      if (!ops.length) throw new Error('the patch changes no files');
      return ops;
    }
    const head = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(l);
    if (head) {
      if (cur) ops.push(cur);
      cur = { kind: head[1].toLowerCase() as PatchOp['kind'], path: head[2].trim(), ...(head[1] === 'Add' ? { lines: [] } : head[1] === 'Update' ? { hunks: [] } : {}) };
      hunk = null;
      continue;
    }
    if (/^\*\*\* Move to:/.test(l)) throw new Error('moving files is not supported; use shell_run mv');
    if (!cur) {
      if (l.trim()) throw new Error(`unexpected line before a file header: ${l.slice(0, 60)}`);
      continue;
    }
    if (cur.kind === 'add') {
      if (!l.startsWith('+') && l !== '') throw new Error(`lines of an added file must start with "+": ${l.slice(0, 60)}`);
      cur.lines!.push(l.slice(1));
    } else if (cur.kind === 'update') {
      if (l.startsWith('@@')) {
        hunk = [];
        cur.hunks!.push(hunk);
        continue;
      }
      if (l === '*** End of File') continue;
      if (!hunk) {
        hunk = [];
        cur.hunks!.push(hunk);
      }
      if (l === '') hunk.push(' ');
      else if (/^[ +-]/.test(l)) hunk.push(l);
      else throw new Error(`hunk lines must start with " ", "-" or "+": ${l.slice(0, 60)}`);
    }
  }
  throw new Error('missing "*** End Patch"');
}

/** Apply update hunks to text. Each hunk's context+removed lines must appear in order; whitespace at line ends is forgiven. */
export function applyHunks(text: string, hunks: string[][]): string {
  const hadNewline = text.endsWith('\n');
  let lines = (hadNewline ? text.slice(0, -1) : text).split('\n');
  let from = 0;
  for (const [n, h] of hunks.entries()) {
    const oldBlock = h.filter((l) => l[0] !== '+').map((l) => l.slice(1));
    const newBlock = h.filter((l) => l[0] !== '-').map((l) => l.slice(1));
    if (!oldBlock.length) {
      lines = [...lines.slice(0, from), ...newBlock, ...lines.slice(from)];
      from += newBlock.length;
      continue;
    }
    const eq = (a: string, b: string) => a === b || a.trimEnd() === b.trimEnd();
    const findAt = (start: number) => {
      for (let i = start; i + oldBlock.length <= lines.length; i++) if (oldBlock.every((o, k) => eq(lines[i + k], o))) return i;
      return -1;
    };
    let at = findAt(from);
    if (at < 0) at = findAt(0);
    if (at < 0) throw new Error(`hunk ${n + 1} does not match the file (first line: "${oldBlock[0].slice(0, 60)}"). Read the file and copy the lines exactly.`);
    lines = [...lines.slice(0, at), ...newBlock, ...lines.slice(at + oldBlock.length)];
    from = at + newBlock.length;
  }
  return lines.join('\n') + (hadNewline ? '\n' : '');
}

export const apply_patch: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'apply_patch',
      description:
        'Create or change files with a patch:\n*** Begin Patch\n*** Update File: path\n@@\n context line\n-old line\n+new line\n*** Add File: path\n+first line\n*** End Patch\nRead a file before updating it; copy context lines exactly.',
      parameters: { type: 'object', properties: { patch: { type: 'string' } }, required: ['patch'] },
    },
  },
  async run(args, ctx) {
    let ops: PatchOp[];
    try {
      ops = parsePatch(str(args.patch ?? args.input, 'patch'));
    } catch (e) {
      return fail(`Malformed patch: ${(e as Error).message}.`);
    }
    const done: string[] = [];
    for (const op of ops) {
      if (op.kind === 'delete') return fail(`Deleting files is not supported by apply_patch (${op.path}); use shell_run.${done.length ? ` Already applied: ${done.join('; ')}` : ''}`);
      const p = resolvePath(op.path);
      let r: ToolResult;
      if (op.kind === 'add') {
        if (fs.existsSync(p)) return fail(`${op.path} already exists; use "*** Update File".${done.length ? ` Already applied: ${done.join('; ')}` : ''}`);
        r = await write_file.run({ path: op.path, content: op.lines!.join('\n') + '\n' }, ctx);
      } else {
        if (!fs.existsSync(p)) return fail(`${op.path} does not exist; use "*** Add File".`);
        let next: string;
        try {
          next = applyHunks(fs.readFileSync(p, 'utf8'), op.hunks ?? []);
        } catch (e) {
          return fail(`${op.path}: ${(e as Error).message}${done.length ? ` Already applied: ${done.join('; ')}` : ''}`);
        }
        r = await write_file.run({ path: op.path, content: next }, ctx);
      }
      if (!r.ok) return fail(`${op.path}: ${r.content}${done.length ? ` Already applied: ${done.join('; ')}` : ''}`);
      done.push(`${op.kind === 'add' ? 'added' : 'updated'} ${op.path}`);
    }
    return ok(`Patch applied: ${done.join('; ')}.`);
  },
};

// ---------- Claude-Code-style single editor ----------

export const str_replace_editor: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'str_replace_editor',
      description:
        'View and edit files. command "view": show a file with line numbers (view_range [start, end] optional). "create": new file with file_text. "str_replace": replace old_str (must be unique) with new_str. "insert": add new_str after line insert_line (0 = top).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert'] },
          path: { type: 'string' },
          file_text: { type: 'string' },
          old_str: { type: 'string' },
          new_str: { type: 'string' },
          insert_line: { type: 'integer' },
          view_range: { type: 'array', items: { type: 'integer' } },
        },
        required: ['command', 'path'],
      },
    },
  },
  async run(args, ctx: ToolContext) {
    const cmd = str(args.command, 'command');
    const p = str(args.path, 'path');
    switch (cmd) {
      case 'view': {
        const vr = Array.isArray(args.view_range) ? (args.view_range as unknown[]).map(Number) : [];
        return read_file.run({ path: p, ...(vr[0] ? { start_line: vr[0] } : {}), ...(vr[1] && vr[1] > 0 ? { end_line: vr[1] } : {}) }, ctx);
      }
      case 'create':
        return write_file.run({ path: p, content: str(args.file_text ?? args.content, 'file_text') }, ctx);
      case 'str_replace':
        return edit_file.run({ path: p, old_string: str(args.old_str, 'old_str'), new_string: optStr(args.new_str) ?? '' }, ctx);
      case 'insert': {
        const at = optNum(args.insert_line);
        if (at === undefined || at < 0) return fail('insert_line must be 0 (top) or a line number.');
        const abs = resolvePath(p);
        const text = fs.readFileSync(abs, 'utf8');
        const hadNewline = text.endsWith('\n');
        const lines = (hadNewline ? text.slice(0, -1) : text).split('\n');
        if (at > lines.length) return fail(`insert_line ${at} is past the end (${lines.length} lines).`);
        const add = (optStr(args.new_str) ?? '').replace(/\n$/, '').split('\n');
        const next = [...lines.slice(0, at), ...add, ...lines.slice(at)].join('\n') + (hadNewline || !text ? '\n' : '');
        return write_file.run({ path: p, content: next }, ctx);
      }
      default:
        return fail('command must be view, create, str_replace or insert.');
    }
  },
};
