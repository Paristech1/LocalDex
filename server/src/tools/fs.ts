import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import fg from 'fast-glob';
import { resolvePath, defaultCwd } from './permissions.js';
import { fail, ok, optNum, optStr, str, truncate, type ToolDef } from './types.js';
import { describeText, describeTextLine, fixDoubleEscapedText } from '../jsonRepair.js';
import { inlineBudgetChars } from '../spill.js';
import { editRefusal, fingerprint, recordRead } from './readTracker.js';

export const read_file: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a text file. Returns the content with line numbers. Use start_line/end_line for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path or path relative to the approved folder.' },
          start_line: { type: 'integer', description: '1-based first line to return (optional).' },
          end_line: { type: 'integer', description: '1-based last line to return (optional).' },
        },
        required: ['path'],
      },
    },
  },
  async run(args, ctx) {
    // Saved tool output (LocalDex's spill folder) may be read back; everything else must be in an approved folder.
    const p = resolvePath(str(args.path, 'path'), { read: true });
    const stat = await fs.stat(p).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
      return null;
    });
    if (!stat) {
      // Reading a path that doesn't exist is how the agent earns the right to create it.
      recordRead(ctx.sessionId, ctx.agent, p, null);
      return fail(`${p} does not exist. You may create it with write_file.`);
    }
    if (stat.isDirectory()) return fail(`"${p}" is a directory. Use list_dir.`);
    if (stat.size > 5_000_000) return fail(`File is too large (${stat.size} bytes).`);
    const raw = await fs.readFile(p, 'utf8');
    recordRead(ctx.sessionId, ctx.agent, p, { mtimeMs: stat.mtimeMs, size: stat.size, sha1: createHash('sha1').update(raw).digest('hex') });
    const lines = raw.endsWith('\n') ? raw.slice(0, -1).split('\n') : raw.split('\n');
    const start = Math.max(1, optNum(args.start_line) ?? 1);
    let end = Math.min(lines.length, optNum(args.end_line) ?? lines.length);
    const width = String(end).length;
    // Only as much as the model's context window takes: cut at a line boundary and say where to continue.
    const budget = inlineBudgetChars(ctx?.model ?? null);
    let used = 0;
    let cut = false;
    const shown: string[] = [];
    for (let i = start - 1; i < end; i++) {
      const line = `${String(i + 1).padStart(width)}| ${lines[i]}`;
      if (shown.length && used + line.length + 1 > budget) {
        cut = true;
        end = i;
        break;
      }
      shown.push(line.length > budget ? `${line.slice(0, budget)}… [line cut, ${line.length} chars]` : line);
      used += line.length + 1;
    }
    const body = shown.join('\n');
    // Same line count as write_file/edit_file and `wc -l` users expect: a final newline does not start a new line.
    const total = describeText(raw).lines;
    const header = `${p} (${describeTextLine(raw)}${start > 1 || end < total ? `, showing ${start}-${Math.min(end, total)}` : ''})\n`;
    const more = cut ? `\n\n[Stopped at line ${end} to fit the context window; ${total - end} more lines. Call read_file with start_line=${end + 1} to continue, or grep for what you need.]` : '';
    return ok(header + truncate(body) + more);
  },
};

export const write_file: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file with the given content. Creates parent directories.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  async run(args, ctx) {
    const p = resolvePath(str(args.path, 'path'));
    const repaired = fixDoubleEscapedText(str(args.content, 'content'), p);
    const content = repaired.text;
    const refused = await editRefusal(ctx.sessionId, ctx.agent, p);
    if (refused) return fail(refused);
    await fs.mkdir(path.dirname(p), { recursive: true });
    const existed = await fs
      .access(p)
      .then(() => true)
      .catch(() => false);
    await fs.writeFile(p, content, 'utf8');
    recordRead(ctx.sessionId, ctx.agent, p, await fingerprint(p));
    const note = repaired.fixed
      ? ` LocalDex turned ${repaired.fixed} literal "\\n" sequence(s) into real line breaks (the content looked double-escaped). Send real newlines in JSON as \\n, not \\\\n.`
      : '';
    return ok(`${existed ? 'Overwrote' : 'Created'} ${p} (${describeTextLine(content)}).${note}`);
  },
};

export const edit_file: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Edit a file by replacing an exact string. old_string must appear exactly once unless replace_all is true. Include enough surrounding context to be unique.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string', description: 'Exact text to find.' },
          new_string: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  async run(args, ctx) {
    const p = resolvePath(str(args.path, 'path'));
    const oldStr = str(args.old_string, 'old_string');
    const newStr = str(args.new_string, 'new_string');
    const replaceAll = args.replace_all === true || args.replace_all === 'true';
    if (oldStr === '') return fail('old_string must not be empty.');
    const refused = await editRefusal(ctx.sessionId, ctx.agent, p);
    if (refused) return fail(refused);
    const content = await fs.readFile(p, 'utf8');
    const count = content.split(oldStr).length - 1;
    if (count === 0) return fail(`old_string not found in ${p}. Read the file and copy the text exactly.`);
    if (count > 1 && !replaceAll) {
      return fail(`old_string appears ${count} times in ${p}. Add more context or set replace_all=true.`);
    }
    // Same double-escape repair as write_file, but only when the file itself uses real line breaks.
    const repaired = content.includes('\n') ? fixDoubleEscapedText(newStr, p) : { text: newStr, fixed: 0 };
    const replacement = repaired.text;
    const updated = replaceAll ? content.split(oldStr).join(replacement) : content.replace(oldStr, () => replacement);
    await fs.writeFile(p, updated, 'utf8');
    recordRead(ctx.sessionId, ctx.agent, p, await fingerprint(p));
    const note = repaired.fixed ? ` (turned ${repaired.fixed} literal "\\n" into real line breaks)` : '';
    return ok(`Edited ${p}: replaced ${replaceAll ? count : 1} occurrence(s)${note}. File now: ${describeTextLine(updated)}.`);
  },
};

export const list_dir: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and folders in a directory (non-recursive). Defaults to the approved folder.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    },
  },
  async run(args) {
    const p = resolvePath(optStr(args.path) ?? defaultCwd());
    const entries = await fs.readdir(p, { withFileTypes: true });
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const lines = await Promise.all(
      entries
        .filter((e) => e.name !== 'node_modules' && e.name !== '.git')
        .map(async (e) => {
          if (e.isDirectory()) return `${e.name}/`;
          try {
            const s = await fs.stat(path.join(p, e.name));
            return `${e.name}  (${formatSize(s.size)})`;
          } catch {
            return e.name;
          }
        }),
    );
    return ok(`${p}\n${lines.join('\n') || '(empty)'}`);
  },
};

export const glob: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files by glob pattern (e.g. "src/**/*.ts"). Ignores node_modules and .git.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Directory to search in (default: approved folder).' },
        },
        required: ['pattern'],
      },
    },
  },
  async run(args) {
    const cwd = resolvePath(optStr(args.path) ?? defaultCwd());
    const matches = await fg(str(args.pattern, 'pattern'), {
      cwd,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
      dot: true,
      onlyFiles: true,
      suppressErrors: true,
    });
    matches.sort();
    const shown = matches.slice(0, 500);
    return ok(
      `${matches.length} match(es) in ${cwd}${matches.length > 500 ? ' (showing 500)' : ''}\n${shown.join('\n')}`,
    );
  },
};

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
