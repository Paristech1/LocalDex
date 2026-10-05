import { spawn } from 'node:child_process';
import { rgPath } from '@vscode/ripgrep';
import { resolvePath, defaultCwd } from './permissions.js';
import { fail, ok, optBool, optNum, optStr, str, truncate, type ToolDef } from './types.js';

export const grep: ToolDef = {
  schema: {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents with a regex (ripgrep). Returns file:line:text matches.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression.' },
          path: { type: 'string', description: 'File or directory to search (default: approved folder).' },
          glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts".' },
          case_insensitive: { type: 'boolean' },
          max_results: { type: 'integer', description: 'Default 200.' },
        },
        required: ['pattern'],
      },
    },
  },
  async run(args, ctx) {
    const pattern = str(args.pattern, 'pattern');
    const target = resolvePath(optStr(args.path) ?? defaultCwd());
    const max = optNum(args.max_results) ?? 200;
    const rgArgs = ['--line-number', '--no-heading', '--color=never', '--max-count', '500', '-g', '!node_modules', '-g', '!.git', '-g', '!dist'];
    if (optBool(args.case_insensitive)) rgArgs.push('-i');
    const g = optStr(args.glob);
    if (g) rgArgs.push('-g', g);
    rgArgs.push('-e', pattern, target);

    return new Promise((resolve) => {
      const child = spawn(rgPath, rgArgs, { signal: ctx.signal });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => {
        out += d.toString();
        if (out.length > 2_000_000) child.kill();
      });
      child.stderr.on('data', (d) => (err += d.toString()));
      child.on('error', (e) => resolve(fail(`ripgrep failed: ${e.message}`)));
      child.on('close', (code) => {
        if (code === 1) return resolve(ok(`No matches for /${pattern}/ in ${target}.`));
        if (code !== 0 && code !== null && !out) return resolve(fail(`ripgrep exited ${code}: ${err.trim()}`));
        const lines = out.trimEnd().split('\n');
        const shown = lines.slice(0, max);
        const header = `${lines.length} match(es)${lines.length > max ? `, showing ${max}` : ''}\n`;
        resolve(ok(header + truncate(shown.join('\n'))));
      });
    });
  },
};
