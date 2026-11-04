/**
 * Small HTML → Markdown converter for web_fetch (A1). Pattern from DeepSeek Harness `web/tool-web` (turndown + GFM),
 * reimplemented without a DOM dependency: enough for docs pages, READMEs and articles; anything exotic degrades to
 * plain text. Scripts, styles, navigation and forms are dropped.
 */

const DROP = /<(script|style|noscript|svg|canvas|iframe|template|nav|header|footer|aside|form|button|select|option|textarea|input)\b[\s\S]*?<\/\1\s*>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', middot: '·', bull: '•', times: '×' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : '';
}

function resolve(href: string, base?: string): string {
  if (!base) return href;
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

export function htmlTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

/** Convert an HTML document (or fragment) to Markdown. `base` makes relative links absolute. */
export function htmlToMarkdown(html: string, base?: string): string {
  let s = html.replace(COMMENTS, '').replace(DROP, '');
  // Prefer <main> / <article> when present: that is the content, the rest is chrome.
  const main = s.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/i);
  if (main && main[2].replace(/<[^>]+>/g, '').trim().length > 200) s = main[2];
  // Drop <head> wholesale.
  s = s.replace(/<head\b[\s\S]*?<\/head\s*>/i, '');

  // Code blocks first, so nothing inside them is touched.
  const blocks: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m, inner: string) => {
    const lang = (inner.match(/<code\b[^>]*class\s*=\s*["'][^"']*(?:language|lang)-([\w+-]+)/i) ?? [])[1] ?? '';
    const code = decodeEntities(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\n$/, '');
    blocks.push(`\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`);
    return `\u0000${blocks.length - 1}\u0000`;
  });

  // Tables → GFM when they are simple (no nested tables).
  s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi, (_m, inner: string) => {
    if (/<table\b/i.test(inner)) return inner;
    const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((r) =>
      [...r[1].matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map((c) => inlineToText(c[2]).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()),
    );
    if (!rows.length) return '';
    const width = Math.max(...rows.map((r) => r.length));
    const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
    return `\n\n${line(rows[0])}\n${line(Array(width).fill('---'))}\n${rows.slice(1).map(line).join('\n')}\n\n`;
  });

  // Block structure.
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, n: string, t: string) => `\n\n${'#'.repeat(Number(n))} ${inlineToText(t).trim()}\n\n`);
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (_m, t: string) => `\n- ${inlineToText(t).trim().replace(/\n+/g, '\n  ')}`);
  s = s.replace(/<\/?(ul|ol|dl)\b[^>]*>/gi, '\n\n');
  s = s.replace(/<dt\b[^>]*>([\s\S]*?)<\/dt\s*>/gi, (_m, t: string) => `\n**${inlineToText(t).trim()}**`);
  s = s.replace(/<dd\b[^>]*>([\s\S]*?)<\/dd\s*>/gi, (_m, t: string) => `\n: ${inlineToText(t).trim()}`);
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi, (_m, t: string) => `\n\n${inlineToText(t).trim().split('\n').map((l) => `> ${l}`).join('\n')}\n\n`);
  s = s.replace(/<hr\b[^>]*\/?>/gi, '\n\n---\n\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/?(p|div|section|article|main|body|html|figure|figcaption|details|summary|tr|thead|tbody|tfoot|address|center)\b[^>]*>/gi, '\n\n');

  s = inlineToText(s);
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)]);

  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  function inlineToText(t: string): string {
    let x = t;
    x = x.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_m, tag: string, text: string) => {
      const href = attr(`<a${tag}>`, 'href');
      const label = inlineToText(text).trim() || href;
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return label;
      return `[${label}](${resolve(href, base)})`;
    });
    x = x.replace(/<img\b([^>]*)\/?>/gi, (_m, tag: string) => {
      const alt = attr(`<img${tag}>`, 'alt');
      const src = attr(`<img${tag}>`, 'src');
      return src ? `![${alt}](${resolve(src, base)})` : alt;
    });
    x = x.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, c: string) => `**${c.trim()}**`);
    x = x.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, c: string) => `*${c.trim()}*`);
    x = x.replace(/<(code|kbd|samp|tt)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, c: string) => `\`${decodeEntities(c.replace(/<[^>]+>/g, ''))}\``);
    x = x.replace(/<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, c: string) => `~~${c.trim()}~~`);
    x = x.replace(/<[^>]+>/g, '');
    return decodeEntities(x).replace(/[ \t]+/g, ' ');
  }
}
