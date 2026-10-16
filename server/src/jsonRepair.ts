/**
 * Lenient JSON parsing for tool calls written by small local models.
 *
 * Repairs, in order, until one parses:
 *  1. as-is
 *  2. Gemma-style string tokens (<|"|>) turned back into quotes
 *  3. raw newlines / tabs / carriage returns inside strings escaped (the most common failure)
 *  4. trailing commas removed
 *  5. smart quotes used as JSON quotes replaced
 */
export function parseLenientJson(raw: string): unknown {
  const attempts = candidates(raw);
  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch {
      /* next */
    }
  }
  return undefined;
}

function candidates(raw: string): string[] {
  const out: string[] = [raw];
  let s = raw.replace(/<\|"\|>/g, '"');
  out.push(s);
  s = escapeControlCharsInStrings(s);
  out.push(s);
  s = s.replace(/,\s*([}\]])/g, '$1');
  out.push(s);
  out.push(s.replace(/[“”]/g, '"'));
  out.push(balanceBrackets(s.replace(/[“”]/g, '"')));
  return [...new Set(out)];
}

/**
 * Fix unbalanced brackets: Gemma often ends a call with one `}` too many (`}}}`) or forgets one.
 * Closers with no matching opener are dropped, and missing closers are appended. Strings are respected.
 */
export function balanceBrackets(s: string): string {
  const stack: string[] = [];
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += s[i + 1] ?? '';
        i++;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack[stack.length - 1] === ch) stack.pop();
      else continue; // stray closer: drop it
    }
    out += ch;
  }
  if (inString) out += '"';
  return out + stack.reverse().join('');
}

/** Escape raw control characters that appear inside JSON string literals (outside strings they are just whitespace). */
export function escapeControlCharsInStrings(s: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') {
        out += ch + (s[i + 1] ?? '');
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      else if (ch === '\n') {
        out += '\\n';
        continue;
      } else if (ch === '\r') {
        out += '\\r';
        continue;
      } else if (ch === '\t') {
        out += '\\t';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/**
 * Small models sometimes double-escape file content, so a write meant to contain three lines arrives as one line
 * with literal backslash-n sequences ("one\\ntwo"). Turn those back into real newlines when it is unambiguous:
 * the text has no real newlines, has literal \n sequences, none of them sit inside a quoted string (where "\n" can
 * be legitimate source code), and the file is not JSON.
 */
export function fixDoubleEscapedText(content: string, filePath: string): { text: string; fixed: number } {
  if (content.includes('\n')) return { text: content, fixed: 0 };
  const matches = content.match(/\\n/g);
  if (!matches) return { text: content, fixed: 0 };
  if (/\.(json|jsonc|ndjson)$/i.test(filePath)) return { text: content, fixed: 0 };
  const t = content.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) return { text: content, fixed: 0 };
  if (!allOutsideQuotes(content, '\\n')) return { text: content, fixed: 0 };
  const text = content.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  return { text, fixed: matches.length };
}

function allOutsideQuotes(s: string, needle: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (s.startsWith(needle, i)) return false;
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      // An apostrophe inside a word ("don't") is not a quote.
      if (ch === "'" && /\w/.test(s[i - 1] ?? '') && /\w/.test(s[i + 1] ?? '')) continue;
      quote = ch;
    }
  }
  return true;
}

/** Line facts in `wc -l` terms, so the model is never told "3 lines" when `wc -l` will print 2. */
export function describeText(content: string): { lines: number; wcLines: number; bytes: number; trailingNewline: boolean } {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (content === '') return { lines: 0, wcLines: 0, bytes, trailingNewline: false };
  const wcLines = (content.match(/\n/g) ?? []).length;
  const trailingNewline = content.endsWith('\n');
  return { lines: trailingNewline ? wcLines : wcLines + 1, wcLines, bytes, trailingNewline };
}

/** One-line human/model-readable description, e.g. "3 lines, 14 bytes" or "3 lines, 13 bytes; no newline at end, so `wc -l` reports 2". */
export function describeTextLine(content: string): string {
  const d = describeText(content);
  const base = `${d.lines} line${d.lines === 1 ? '' : 's'}, ${d.bytes} bytes`;
  if (d.lines > 0 && !d.trailingNewline) return `${base}; no newline at end, so \`wc -l\` reports ${d.wcLines}`;
  return base;
}
