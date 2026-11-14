/**
 * One path, read one way — before any route sees the request.
 *
 * Express and the /api proxy (http-proxy-middleware) each read the path from
 * the raw request line, and they did not read it the same way. Express routes
 * on the raw text: `/api\as\pubkey` is not under `/api`, so the API-key guard
 * (`app.use('/api', authGuard)`) never ran. The proxy reads it with Node's
 * legacy `url.parse`, which turns `\` into `/`: `/api/as/pubkey` IS under
 * `/api`, so it forwarded the request to the Authority Server — with the
 * signed-in person's server-side session cookie attached. Anyone who could
 * reach the port could call the Authority Server as that person without the
 * API key (security review 2026-11, finding B).
 *
 * Two rules close it:
 * 1. `refuseAmbiguousPath` — refuse, for every route, a path that two parsers
 *    could read differently: any backslash (raw or `%5C`), and any path a
 *    WHATWG URL parser would rewrite (`//api/x`, dot segments, an
 *    absolute-form request target). A browser never sends such a path.
 * 2. `isApiPath` — the single rule for "is this an /api request", used both
 *    to decide whether to proxy and to guard what is proxied (index.ts).
 */

import type { Request, Response, NextFunction } from 'express';

/** The path part of a raw request target, without the query string. */
function rawPathOf(rawUrl: string): string {
  const q = rawUrl.indexOf('?');
  return q === -1 ? rawUrl : rawUrl.slice(0, q);
}

/** Why a raw request target is ambiguous, or null when it is not. */
export function ambiguousPathReason(rawUrl: string): string | null {
  const rawPath = rawPathOf(rawUrl);
  if (rawPath.includes('\\') || /%5c/i.test(rawPath)) return 'backslash in path';
  if (!rawPath.startsWith('/')) return 'not an origin-form path';
  let parsed: string;
  try {
    parsed = new URL(rawUrl, 'http://gateway.invalid').pathname;
  } catch {
    return 'unparseable path';
  }
  if (parsed !== rawPath) return 'path is not in normal form';
  return null;
}

export function refuseAmbiguousPath(req: Request, res: Response, next: NextFunction): void {
  // Mounted at the app root, before everything: req.url is the raw target.
  const reason = ambiguousPathReason(req.originalUrl ?? req.url);
  if (reason) {
    res.status(400).json({ error: 'Bad request path', reason });
    return;
  }
  next();
}

/** `/api` itself or anything below it — never `/apix`. */
export function isApiPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname === '/api' || pathname.startsWith('/api/');
}
