import fs from 'node:fs';
import { resolvePath } from './permissions.js';
import { fail, ok, optNum, optStr, str, type ToolDef } from './types.js';
import { columnFor, lspQuery, type LspOperation } from '../lsp.js';

const OPS: LspOperation[] = ['definition', 'references', 'implementation', 'hover'];

/** A3: read-only code navigation through a language server. Off by default (Settings → Capabilities). */
export const lsp: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'lsp',
      description:
        'Code navigation with a language server (read-only): where a symbol is defined, every place it is used, implementations, or its type/docs. Give the file, the 1-based line, and the symbol name on that line (or a 1-based character). Use it when grep would be ambiguous.',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: OPS },
          path: { type: 'string' },
          line: { type: 'integer', description: '1-based line number.' },
          symbol: { type: 'string', description: 'Name of the symbol on that line (preferred over character).' },
          character: { type: 'integer', description: '1-based column, if no symbol is given.' },
        },
        required: ['operation', 'path', 'line'],
      },
    },
  },
  async run(args) {
    const op = str(args.operation, 'operation') as LspOperation;
    if (!OPS.includes(op)) return fail(`operation must be one of: ${OPS.join(', ')}`);
    const file = resolvePath(str(args.path, 'path'));
    const line = optNum(args.line) ?? 0;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    if (line < 1 || line > lines.length) return fail(`line must be between 1 and ${lines.length}.`);
    const symbol = optStr(args.symbol);
    const col = columnFor(lines[line - 1], symbol, optNum(args.character));
    if (!col) return fail(symbol ? `"${symbol}" is not on line ${line}: ${lines[line - 1].trim().slice(0, 120)}` : 'Give a symbol name or a 1-based character.');
    try {
      return ok(await lspQuery(op, file, line, col));
    } catch (e) {
      return fail(`lsp ${op} failed: ${(e as Error).message}`);
    }
  },
};
