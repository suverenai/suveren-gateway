/**
 * One-time start access (DEC-93). Mounted at /auth, behind SUVEREN_DEVICE_KEYS=on:
 *
 *   GET  /auth/start/status            { available } — may this gateway start its set-up without a sign-in? (no session)
 *   POST /auth/start/open              opens a START session (own cookie + header token), only while unclaimed
 *   POST /auth/start/connect           -> the address to open in the system browser (start session)
 *   GET  /auth/start/connect/status    waiting | ready (+ the account) | failed | expired (start session)
 *   POST /auth/start/password          { password } -> the vault, bound to the connected account; the first PAGE session
 *
 * The start session is not a page session: another cookie name, another header, another store. It opens nothing
 * but the four routes above; every other route of this gateway refuses it (it never passes pageSessionVerdict).
 * Every request is checked for Origin and Host, and the control plane must listen on this computer only.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { checkOriginAndHost, parseCookie, sessionCookieHeader } from '../lib/page-session';
import type { PageSessionDeps } from '../middleware/auth';
import { FirstStart, START_COOKIE, START_HEADER } from '../lib/first-start';
import { SetupRefusal } from '../lib/device-setup';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from './password';
import { DEVICE_MESSAGES } from './device-setup';

export const START_MESSAGES: Record<string, string> = {
  start_unavailable: 'This gateway is already set up or connected.',
  connect_not_ready: 'Connect first.',
  password_invalid: 'The password is not acceptable.',
  password_exists: 'A password is already set.',
};

function fail(res: Response, status: number, code: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error: code, code, message: START_MESSAGES[code] ?? DEVICE_MESSAGES[code] ?? code, ...extra });
}

/** `Set-Cookie` for the start session: like the page session's, under its own name. */
function startCookieHeader(cookie: string): string {
  return `${START_COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Strict`;
}
const START_COOKIE_CLEAR = `${START_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

export function createFirstStartRouter(deps: { firstStart: FirstStart; pageSession: PageSessionDeps; afterPassword?: () => void }): Router {
  const { firstStart, pageSession } = deps;
  const router = Router();
  const api = Router();

  const local = (req: Request, res: Response, next: NextFunction): void => {
    if (!pageSession.listensOnLoopbackOnly) { fail(res, 403, 'not_local'); return; }
    if (!checkOriginAndHost(req.method, req.headers.host, req.headers.origin)) { fail(res, 403, 'origin_refused'); return; }
    next();
  };
  api.use(local);

  const sessionOf = (req: Request): string | null => {
    const hdr = req.headers[START_HEADER];
    return firstStart.sessionIdFor(parseCookie(req.headers.cookie, START_COOKIE), typeof hdr === 'string' ? hdr : undefined);
  };
  const withStart = (req: Request, res: Response, next: NextFunction): void => {
    const id = sessionOf(req);
    if (!id) { fail(res, 401, 'unauthorized'); return; }
    (req as Request & { startSessionId?: string }).startSessionId = id;
    next();
  };
  const idOf = (req: Request): string => (req as Request & { startSessionId?: string }).startSessionId ?? '';

  const run = (handler: (req: Request, res: Response) => Promise<void> | void) => async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof SetupRefusal) { fail(res, err.status, err.code, err.extra); return; }
      console.error('[Control Plane] First-start error:', err instanceof Error ? err.name : 'error');
      fail(res, 500, 'bad_request');
    }
  };

  api.get('/status', run((_req, res) => { res.json({ available: firstStart.available() }); }));

  api.post('/open', run((_req, res) => {
    const s = firstStart.open();
    res.setHeader('Set-Cookie', startCookieHeader(s.cookie));
    res.json({ ok: true, startToken: s.token });
  }));

  api.post('/connect', withStart, run(async (req, res) => {
    const out = await firstStart.connectStart(req.socket.localPort ?? 0, idOf(req), req.socket.localAddress);
    res.json({ ok: true, ...out });
  }));

  api.get('/connect/status', withStart, run((req, res) => {
    res.json({ ok: true, ...firstStart.connectStatus(idOf(req)) });
  }));

  api.post('/password', withStart, run(async (req, res) => {
    const password = (req.body as { password?: unknown } | undefined)?.password;
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      fail(res, 400, 'password_invalid', { minLength: MIN_PASSWORD_LENGTH });
      return;
    }
    const { account } = await firstStart.setPassword(password, idOf(req));
    // The first page session, the way the password route opens one; the start cookie is cleared with it.
    const s = pageSession.sessions.open();
    res.setHeader('Set-Cookie', [sessionCookieHeader(s.cookie), START_COOKIE_CLEAR]);
    res.json({ ok: true, sessionToken: s.token, account });
    deps.afterPassword?.();
  }));

  router.use('/start', api);
  return router;
}
