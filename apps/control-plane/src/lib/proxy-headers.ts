/**
 * What the /api proxy may send on to the Authority Server. The page session's
 * two secrets (cookie value and header token) and the change confirmation are
 * the gateway's own: the Authority Server must never see them. The browser's
 * Cookie header is never forwarded either: it holds the page session cookie
 * (and anything else on this host); the server-side AS session cookie replaces
 * it, or there is no Cookie at all.
 */

export const NEVER_FORWARD_HEADERS = ['x-suveren-session', 'x-suveren-confirmation'] as const;

interface HeaderSetter {
  setHeader(name: string, value: string): unknown;
  removeHeader(name: string): unknown;
}

export function scrubProxyRequest(proxyReq: HeaderSetter, asSessionCookie: string | null): void {
  for (const h of NEVER_FORWARD_HEADERS) proxyReq.removeHeader(h);
  if (asSessionCookie) proxyReq.setHeader('Cookie', asSessionCookie);
  else proxyReq.removeHeader('Cookie');
}
