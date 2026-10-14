import type { IncomingMessage } from 'node:http';

/**
 * LocalDex can read files and run commands, so only the user's own browser tab may talk to it.
 *
 * Two attacks this blocks (any website you visit could otherwise try them against localhost):
 *  - Cross-site requests / WebSocket hijacking: the browser always sends an Origin header, so we reject foreign origins.
 *  - DNS rebinding: a hostile domain re-points to 127.0.0.1; its requests carry a foreign Host header, so we reject those.
 * Non-browser clients (curl, scripts) send no Origin and are allowed, but still need a local Host.
 */

/** Interface to listen on. Default is loopback only; set LOCALDEX_HOST=0.0.0.0 to expose on your LAN (not recommended). */
export const BIND_HOST = process.env.LOCALDEX_HOST || '127.0.0.1';

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const extra = new Set(
  (process.env.LOCALDEX_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1); // [::1]:7331
  return h.split(':')[0];
}

export function isAllowedHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const name = hostnameOf(host);
  return LOCAL.has(name) || extra.has(name);
}

/** Missing Origin = not a browser (allowed). Present Origin must be a local page. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (origin === 'null') return false;
  try {
    const name = hostnameOf(new URL(origin).host);
    return LOCAL.has(name) || extra.has(name);
  } catch {
    return false;
  }
}

export function checkRequest(host: string | undefined, origin: string | undefined, secFetchSite?: string): string | null {
  if (!isAllowedHostHeader(host)) return 'Host not allowed';
  if (!isAllowedOrigin(origin)) return 'Origin not allowed';
  if (secFetchSite === 'cross-site') return 'Cross-site request blocked';
  return null;
}

export function checkUpgrade(req: IncomingMessage): string | null {
  return checkRequest(req.headers.host, req.headers.origin as string | undefined, req.headers['sec-fetch-site'] as string | undefined);
}
