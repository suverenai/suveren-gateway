/**
 * The phone path of a confirmation for a change to a connector login (device-keys plan 7; lib/phone-confirmation.ts), for the page:
 *
 *   POST   /auth/confirm/phone      { request_id }  send the request the page asked for (/auth/confirm/request) to the person's phones
 *   GET    /auth/confirm/phone/:id                  waiting | confirmed | denied | expired | invalid
 *   DELETE /auth/confirm/phone/:id                  withdraw it (the person cancelled)
 *
 * The page session, every time, for every handler (a request id is only ever this session's). Only on a computer without its own
 * check key (DEC-47); there the page offers this first and the unlock password after it.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Vault } from '../lib/vault';
import { pageSessionVerdict, type PageSessionDeps } from '../middleware/auth';
import { SESSION_COOKIE, parseCookie } from '../lib/page-session';
import { PhoneConfirmRefusal, type PhoneConfirmations } from '../lib/phone-confirmation';

function fail(res: Response, status: number, code: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error: code, code, message: code, ...extra });
}

const REQUEST_ID = /^[A-Za-z0-9_-]{22}$/;

export interface ConfirmPhoneRouterDeps {
  vault: Vault;
  pageSession: PageSessionDeps;
  phone: PhoneConfirmations;
}

export function createConfirmPhoneRouter(deps: ConfirmPhoneRouterDeps): Router {
  const { vault, pageSession, phone } = deps;
  const router = Router();
  const api = Router();

  api.use((req: Request, res: Response, next: NextFunction): void => {
    const v = pageSessionVerdict(vault, pageSession, req);
    if (!v.ok) { fail(res, v.status, v.code === 'origin_refused' || v.code === 'not_local' ? v.code : 'unauthorized', { reason: v.code }); return; }
    if (!vault.hasPassword()) { fail(res, 409, 'password_required'); return; }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const sessionIdOf = (req: Request): string => pageSession.sessions.idOf(parseCookie(req.headers.cookie, SESSION_COOKIE)) ?? '';
  const run = (handler: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof PhoneConfirmRefusal) { fail(res, err.status, err.code); return; }
      console.error('[Control Plane] Phone confirmation error:', err instanceof Error ? err.name : 'error');
      fail(res, 500, 'bad_request');
    }
  };
  const idOf = (v: unknown): string | null => (typeof v === 'string' && REQUEST_ID.test(v) ? v : null);

  api.post('/', run(async (req, res) => {
    const id = idOf((req.body as { request_id?: unknown } | undefined)?.request_id);
    if (!id) { fail(res, 400, 'bad_request'); return; }
    const sent = await phone.send(sessionIdOf(req), id);
    res.json({ ok: true, expiresAt: sent.expiresAt, phones: sent.phones });
  }));
  api.get('/:id', run(async (req, res) => {
    const id = idOf(req.params.id);
    if (!id) { fail(res, 400, 'bad_request'); return; }
    res.json({ ok: true, status: await phone.poll(sessionIdOf(req), id) });
  }));
  api.delete('/:id', run(async (req, res) => {
    const id = idOf(req.params.id);
    if (!id) { fail(res, 400, 'bad_request'); return; }
    await phone.cancel(sessionIdOf(req), id);
    res.json({ ok: true });
  }));

  router.use('/confirm/phone', api);
  return router;
}
