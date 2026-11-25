/**
 * Auth middleware.
 *
 * A gateway WITHOUT an unlock password (every gateway today) checks the
 * X-API-Key header against the vault's stored hash on every request, exactly
 * as before; no cookies are used.
 *
 * A gateway WHOSE VAULT HAS A PASSWORD checks the page session instead
 * (lib/page-session.ts): a host-only cookie AND a header token, a matching
 * Origin and Host, the idle and 12-hour limits. The account key is then no
 * longer a credential for this gateway's own routes.
 */

import type { Request, Response, NextFunction } from 'express';
import type { Vault } from '../lib/vault';
import {
  type PageSessions, SESSION_COOKIE, SESSION_HEADER,
  classifyRequest, checkOriginAndHost, parseCookie,
} from '../lib/page-session';

export interface PageSessionDeps {
  sessions: PageSessions;
  /** False when the control plane listens on more than this machine. */
  listensOnLoopbackOnly: boolean;
}

export type SessionVerdict = { ok: true } | { ok: false; status: number; code: string };

/**
 * Is this request inside a valid page session? Neutral codes only; what the
 * person reads for each is the maintainer's to decide (O19).
 */
export function pageSessionVerdict(vault: Vault, deps: PageSessionDeps | undefined, req: Request): SessionVerdict {
  if (!deps) return { ok: false, status: 401, code: 'session_missing' }; // fail closed
  if (!deps.listensOnLoopbackOnly) return { ok: false, status: 403, code: 'not_local' };
  if (!checkOriginAndHost(req.method, req.headers.host, req.headers.origin)) {
    return { ok: false, status: 403, code: 'origin_refused' };
  }
  if (!vault.isUnlocked()) return { ok: false, status: 401, code: 'locked' };
  const path = (req.originalUrl ?? req.url).split('?')[0];
  const cookie = parseCookie(req.headers.cookie, SESSION_COOKIE);
  const hdr = req.headers[SESSION_HEADER];
  const token = typeof hdr === 'string' ? hdr : undefined;
  const r = deps.sessions.validate(cookie, token, classifyRequest(req.method, path) === 'use');
  if (!r.ok) return { ok: false, status: 401, code: r.reason };
  return { ok: true };
}

/**
 * A request that cannot carry the header token (OAuth /start, opened by the
 * page in a new window). The cookie, the Origin and Host rules and the time
 * limits still hold; what stands in for the header is a one-time ticket that
 * only a request WITH the header could obtain, bound to this session.
 */
export function pageSessionCookieVerdict(vault: Vault, deps: PageSessionDeps | undefined, req: Request): SessionVerdict {
  if (!deps) return { ok: false, status: 401, code: 'session_missing' };
  if (!deps.listensOnLoopbackOnly) return { ok: false, status: 403, code: 'not_local' };
  if (!checkOriginAndHost(req.method, req.headers.host, req.headers.origin)) return { ok: false, status: 403, code: 'origin_refused' };
  if (!vault.isUnlocked()) return { ok: false, status: 401, code: 'locked' };
  const r = deps.sessions.validateCookie(parseCookie(req.headers.cookie, SESSION_COOKIE), true);
  return r.ok ? { ok: true } : { ok: false, status: 401, code: r.reason };
}

function refuse(res: Response, v: { status: number; code: string }): void {
  res.status(v.status).json({ error: 'Unauthorized', code: v.code });
}

export function requireAuth(vault: Vault, pageSession?: PageSessionDeps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (vault.hasPassword()) {
      const v = pageSessionVerdict(vault, pageSession, req);
      if (!v.ok) { refuse(res, v); return; }
      next();
      return;
    }
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (!apiKey || !vault.isUnlocked() || !vault.validateApiKey(apiKey)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}

/**
 * Variant of requireAuth that also accepts the API key via the `?key=` query
 * parameter. Used for the SSE /events route — native EventSource cannot send
 * custom headers, so we have to allow the key through the URL. Localhost-only
 * gateway architecture means the key isn't crossing untrusted networks.
 *
 * With a vault password the query key is NOT accepted: the stream needs the
 * page session like every other route (cookie and header token), so the page
 * has to read the stream with a fetch that can send the header. A stream is
 * passive and never keeps a session open.
 */
export function requireAuthQueryOrHeader(vault: Vault, pageSession?: PageSessionDeps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (vault.hasPassword()) {
      const v = pageSessionVerdict(vault, pageSession, req);
      if (!v.ok) { refuse(res, v); return; }
      next();
      return;
    }
    const headerKey = req.headers['x-api-key'] as string | undefined;
    const queryKey = typeof req.query.key === 'string' ? req.query.key : undefined;
    const apiKey = headerKey ?? queryKey;
    if (!apiKey || !vault.isUnlocked() || !vault.validateApiKey(apiKey)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}

/**
 * In front of a route that has no account-key check today (OAuth /start). On a
 * gateway whose vault has no password it does nothing; with one the request
 * needs the page session.
 */
export function requirePageSessionIfPassword(vault: Vault, pageSession?: PageSessionDeps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!vault.hasPassword()) { next(); return; }
    const v = pageSessionVerdict(vault, pageSession, req);
    if (!v.ok) { refuse(res, v); return; }
    next();
  };
}

/**
 * After the auth check on a long-lived stream: close it when its page session
 * ends (idle, 12 hours, lock, sign-out), instead of letting it outlive it.
 * Does nothing for a vault without a password.
 */
export function closeStreamWhenSessionEnds(vault: Vault, pageSession?: PageSessionDeps, checkEveryMs = 15_000) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const cookie = parseCookie(req.headers.cookie, SESSION_COOKIE);
    if (!pageSession || !vault.hasPassword() || !cookie) { next(); return; }
    const stopWatching = pageSession.sessions.watch(cookie, () => { if (!res.writableEnded) res.end(); });
    // Limits are found lazily on a request; a stream makes none, so look.
    const timer = setInterval(() => pageSession.sessions.expireDue(), checkEveryMs);
    timer.unref?.();
    res.on('close', () => { clearInterval(timer); stopWatching(); });
    next();
  };
}
