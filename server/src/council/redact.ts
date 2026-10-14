// Removes credentials from text before it is sent to a cloud council member.
// Deterministic and regex-only: every pattern is compiled once at load time.

export interface Redaction {
  text: string;
  count: number;
  /** Distinct kinds found, in order of first appearance (e.g. 'anthropic-key', 'private-key'). */
  kinds: string[];
}

interface Rule {
  kind: string | ((groups: string[]) => string);
  re: RegExp;
  /** Capture group holding the secret; 0 = the whole match. When set, group 1 must be the full text before it (kept). */
  group?: number;
  /** Skip matches whose secret looks like a placeholder or ordinary code. */
  accept?: (secret: string, groups: string[]) => boolean;
}

const MARKER = /\[REDACTED:[a-z-]+\]/;

// Placeholders and code expressions that are not secrets.
const PLACEHOLDER =
  /^(?:\$\{|\$[A-Za-z_]|%[A-Za-z_]|\{\{|<[^>]*>$|process\.env|os\.environ|import\.meta|env\(|getenv)|your[-_ ]?|[-_]here\b|example|changeme|change[-_]me|placeholder|dummy|redacted|sample|x{4,}|\*{3,}|\.{3}|^(.)\1+$/i;

// Vendor-format keys: only obvious template text is skipped, real keys are random.
const VENDOR_PLACEHOLDER = /your[-_]|placeholder|example|x{5,}|\.{3}|\[REDACTED/i;

const vendor = (s: string) => !VENDOR_PLACEHOLDER.test(s);

/** A value that looks like a credential rather than a word, number or identifier. */
function looksSecret(v: string): boolean {
  if (v.length < 12 || PLACEHOLDER.test(v) || MARKER.test(v)) return false;
  if (/^\d+$/.test(v)) return false; // plain numbers (limits, ids, timestamps)
  if (/[()]/.test(v)) return false; // function calls
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v)) return false; // a.b.c member paths
  const digit = /\d/.test(v);
  const mixed = /[a-z]/.test(v) && /[A-Z]/.test(v);
  return digit || (mixed && v.length >= 20);
}

// Key names in generic assignments. Ordinary code like maxTokens, tokenizer or SECRET_NAME is skipped.
const SECRET_NAME = /(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|passwd|pwd|access[_-]?key|private[_-]?key|auth[_-]?key|credential)/i;
const NOT_SECRET_PARTS = new Set(['tokens', 'tokenizer', 'count', 'limit', 'length', 'len', 'size', 'max', 'min', 'usage', 'type', 'name', 'path', 'file', 'url', 'uri', 'ttl', 'expiry', 'expires', 'header', 'endpoint', 'id']);

/** Split API_KEY_NAME / apiKeyName / api-key.name into lower-case words. */
const nameParts = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const secretName = (name: string) => SECRET_NAME.test(name) && !nameParts(name).some((p) => NOT_SECRET_PARTS.has(p));

function genericKind(name: string): string {
  if (/passw|passwd|pwd/i.test(name)) return 'password';
  if (/key/i.test(name)) return 'api-key';
  if (/token/i.test(name)) return 'token';
  return 'secret';
}

const RULES: Rule[] = [
  // PEM private keys, including a block cut off by truncation.
  { kind: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|$)/g },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, accept: vendor },
  { kind: 'openai-key', re: /\bsk-(?:proj-|svcacct-|admin-)?(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g, accept: vendor },
  { kind: 'stripe-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g, accept: vendor },
  { kind: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, accept: vendor },
  { kind: 'github-token', re: /\b(?:gh[posur]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g, accept: vendor },
  { kind: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, accept: vendor },
  { kind: 'aws-key-id', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, accept: vendor },
  { kind: 'aws-secret', re: /(aws_secret_access_key["']?\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi, group: 2 },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'bearer-token', re: /(\bBearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/g, group: 2, accept: (s) => !PLACEHOLDER.test(s) && !MARKER.test(s) },
  // scheme://user:password@host — only the password goes.
  { kind: 'url-password', re: /((?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(?=@)/gi, group: 2, accept: (s) => s.length >= 3 && !PLACEHOLDER.test(s) && !MARKER.test(s) && !/^(?:pass(?:word)?|pwd|secret)$/i.test(s) },
  // NAME = value / "name": "value" / name: 'value'
  {
    kind: (g) => genericKind(g[2] ?? ''),
    re: /((?<![A-Za-z0-9_.-])["']?([A-Za-z0-9_.-]{0,48}?(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|passwd|pwd|access[_-]?key|private[_-]?key|auth[_-]?key|credential)[A-Za-z0-9_]{0,48})["']?\s*(?::|=|:=)\s*(["'`]?))([^\s"'`,;]{12,})(?=\3)/gi,
    group: 4,
    accept: (s, g) => secretName(g[2] ?? '') && looksSecret(s),
  },
];

/** Replace credentials with [REDACTED:<kind>]. Safe to call on already-redacted text. */
export function redactSecrets(text: string): Redaction {
  let count = 0;
  const kinds: string[] = [];
  let out = text;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (...args: unknown[]) => {
      const match = args[0] as string;
      const groups = args.slice(0, args.findIndex((a) => typeof a === 'number')) as string[];
      const gi = rule.group ?? 0;
      const secret = groups[gi] ?? match;
      if (!secret || (rule.accept && !rule.accept(secret, groups))) return match;
      const kind = typeof rule.kind === 'function' ? rule.kind(groups) : rule.kind;
      count++;
      if (!kinds.includes(kind)) kinds.push(kind);
      const marker = `[REDACTED:${kind}]`;
      if (gi === 0) return marker;
      const prefix = groups[1] ?? '';
      return `${prefix}${marker}${match.slice(prefix.length + secret.length)}`;
    });
  }
  return { text: out, count, kinds };
}

/** Count [REDACTED:<kind>] markers already in a text (e.g. a diff redacted upstream). */
export function existingRedactions(text: string): { count: number; kinds: string[] } {
  const kinds: string[] = [];
  let count = 0;
  for (const m of text.matchAll(/\[REDACTED:([a-z-]+)\]/g)) {
    count++;
    if (!kinds.includes(m[1])) kinds.push(m[1]);
  }
  return { count, kinds };
}

/** "api key, private key" for notes and chips. */
export function describeKinds(kinds: string[]): string {
  return kinds.map((k) => k.replace(/-/g, ' ')).join(', ');
}
