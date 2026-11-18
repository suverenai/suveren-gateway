/**
 * Recovery with the recovery code, replacing the recovery code, and cancelling a request
 * for a new identity (device-keys plan 10, 3.2, DEC-15, DEC-37; step 7, gateway side). API
 * only, no screens. Mounted at /auth with the other device routes, behind
 * SUVEREN_DEVICE_KEYS=on:
 *
 *   POST /auth/device/recover/start          { code, label?, checkKey? } -> the address to open in the SYSTEM BROWSER,
 *                                            the confirmation code to compare, and the devices this removes
 *   GET  /auth/device/recover/status         ?recoveryId -> waiting | authorised | failed | expired
 *   POST /auth/device/recover/finish         { recoveryId } -> verify the chain, store it, sign in
 *   POST /auth/device/recover/cancel         drop a started recovery or rotation
 *   POST /auth/device/rotate-root/start      {} -> a NEW recovery code, shown once
 *   POST /auth/device/rotate-root/submit     { rotateId, oldCode, newCode } -> same hand-off as recover
 *   GET  /auth/device/rotate-root/status     ?recoveryId
 *   POST /auth/device/rotate-root/finish     { recoveryId } -> check the chain, move the stored head
 *   POST /auth/device/identity-reset/cancel  { requestId } -> a signed cancel of the pending request for a new identity
 *   GET  /recover/callback                   the system browser's way back (no page session; `state` authorises it)
 *
 * Every /auth/device route sits behind the page session (cookie AND header token, Origin and
 * Host), checked by the router itself: a path that reaches a handler has passed it, however it
 * was written. The recovery code is read here from the request and handed on; it is never
 * logged and never put in an answer. Codes are neutral; the messages are placeholders. The
 * words the person reads are the maintainer's (O19).
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Vault } from '../lib/vault';
import { parseCookie, SESSION_COOKIE, checkOriginAndHost } from '../lib/page-session';
import { pageSessionVerdict, type PageSessionDeps } from '../middleware/auth';
import { SetupRefusal } from '../lib/device-setup';
import type { DeviceRecovery } from '../lib/device-recovery';
import { DEVICE_MESSAGES } from './device-setup';

/** Placeholder messages, by code (O19). */
export const RECOVERY_MESSAGES: Record<string, string> = {
  recovery_code_invalid: 'That is not a recovery code.',
  recovery_code_unknown: 'No account belongs to this recovery code.',
  recovery_code_wrong: 'This is not the current recovery code of this account.',
  recovery_pending: 'A recovery was started and not finished.',
  recovery_unknown: 'No such recovery.',
  recovery_not_done: 'The Authority Server does not hold the new entry yet.',
  recovery_refused: 'The Authority Server refused.',
  device_key_in_chain: 'This computer was part of that chain before.',
  entry_invalid: 'The entry is not valid.',
  chain_moved: 'The chain changed meanwhile. Start again.',
  handoff_not_started: 'The browser step was not started.',
  handoff_refused: 'The browser step was refused.',
  handoff_failed: 'The browser step failed.',
  handoff_timeout: 'The browser did not come back.',
  rotate_unknown: 'No such new code.',
  rotate_expired: 'The new code was not used in time. Make another.',
  new_code_mismatch: 'The new code typed again is not the one shown.',
  granting_device_required: 'This computer needs its check key to replace the recovery code.',
  check_unavailable: 'This computer\'s check key is not available.',
  not_signed_in: 'This computer is not signed in to the Authority Server.',
  reset_unknown: 'No such request for a new identity.',
  cancel_refused: 'The Authority Server refused the cancel.',
  connect_callback_done: 'You can close this tab.',
  connect_callback_unknown: 'Nothing to continue.',
};

const MESSAGES = { ...DEVICE_MESSAGES, ...RECOVERY_MESSAGES };

function fail(res: Response, status: number, code: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error: code, code, message: MESSAGES[code] ?? code, ...extra });
}

export interface DeviceRecoveryRouterDeps {
  vault: Vault;
  pageSession: PageSessionDeps;
  recovery: DeviceRecovery;
}

export function createDeviceRecoveryRouter(deps: DeviceRecoveryRouterDeps): Router {
  const { vault, pageSession, recovery } = deps;
  const router = Router();
  const api = Router();

  /** The page session, every time, for every handler below. */
  const guard = (req: Request, res: Response, next: NextFunction): void => {
    const v = pageSessionVerdict(vault, pageSession, req);
    if (!v.ok) { fail(res, v.status, v.code === 'origin_refused' || v.code === 'not_local' ? v.code : 'unauthorized', { reason: v.code }); return; }
    if (!vault.hasPassword()) { fail(res, 409, 'password_required'); return; }
    next();
  };
  api.use(guard);

  const sessionIdOf = (req: Request): string => pageSession.sessions.idOf(parseCookie(req.headers.cookie, SESSION_COOKIE)) ?? '';
  const run = (handler: (req: Request, res: Response) => Promise<void> | void) => async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof SetupRefusal) { fail(res, err.status, err.code, err.extra); return; }
      // The name only: a message could carry anything.
      console.error('[Control Plane] Device recovery error:', err instanceof Error ? err.name : 'error');
      fail(res, 500, 'bad_request');
    }
  };
  const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {});
  const noStore = (res: Response): void => { res.setHeader('Cache-Control', 'no-store'); };

  api.post('/recover/start', run(async (req, res) => {
    const b = body(req);
    const out = await recovery.recoverStart({
      code: b.code, label: b.label, checkKey: b.checkKey,
      port: req.socket.localPort ?? 0, sessionId: sessionIdOf(req), localAddress: req.socket.localAddress,
    });
    delete b.code; // the text of the code is not kept by the request object
    noStore(res);
    res.json({ ok: true, ...out });
  }));

  api.get('/recover/status', run((req, res) => {
    noStore(res);
    res.json({ ok: true, ...recovery.handoffStatus(req.query.recoveryId, sessionIdOf(req)) });
  }));

  api.post('/recover/finish', run(async (req, res) => {
    const done = await recovery.recoverFinish({ recoveryId: body(req).recoveryId });
    noStore(res);
    res.json({ ok: true, ...done });
  }));

  api.post('/recover/cancel', run((_req, res) => {
    recovery.cancel();
    res.json({ ok: true });
  }));

  api.post('/rotate-root/start', run(async (_req, res) => {
    const out = await recovery.rotateStart();
    // The one place the new recovery code is ever sent. It must not be cached or kept by anything between.
    noStore(res);
    res.json({ ok: true, ...out });
  }));

  api.post('/rotate-root/submit', run(async (req, res) => {
    const b = body(req);
    const out = await recovery.rotateSubmit({
      rotateId: b.rotateId, oldCode: b.oldCode, newCode: b.newCode,
      port: req.socket.localPort ?? 0, sessionId: sessionIdOf(req), localAddress: req.socket.localAddress,
    });
    delete b.oldCode; delete b.newCode;
    noStore(res);
    res.json({ ok: true, ...out });
  }));

  api.get('/rotate-root/status', run((req, res) => {
    noStore(res);
    res.json({ ok: true, ...recovery.handoffStatus(req.query.recoveryId, sessionIdOf(req)) });
  }));

  api.post('/rotate-root/finish', run(async (req, res) => {
    const done = await recovery.rotateFinish({ recoveryId: body(req).recoveryId });
    noStore(res);
    res.json({ ok: true, ...done });
  }));

  api.post('/identity-reset/cancel', run(async (req, res) => {
    const done = await recovery.cancelIdentityReset({ requestId: body(req).requestId });
    noStore(res);
    res.json({ ok: true, ...done });
  }));

  router.use('/device', api);
  return router;
}

/**
 * The system browser's way back from suveren.ai. No page session: a redirect that crosses
 * sites carries no SameSite=Strict cookie. What authorises it is `state` (random, kept only
 * inside DeviceRecovery, tied to the page session that started the hand-off, single-use, ten
 * minutes), checked where the work happens, not by this path. The answer says nothing about
 * the account; the page reads the outcome with its own session.
 */
export function createRecoveryCallbackRouter(deps: { pageSession: PageSessionDeps; recovery: DeviceRecovery }): Router {
  const router = Router();
  const one = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  router.get('/callback', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    if (!deps.pageSession.listensOnLoopbackOnly || !checkOriginAndHost('GET', req.headers.host, req.headers.origin)) {
      res.status(403).type('text/plain').send(MESSAGES.origin_refused);
      return;
    }
    const outcome = await deps.recovery.callback({ state: one(req.query.state), code: one(req.query.code), error: one(req.query.error) });
    res.status(outcome === 'accepted' ? 200 : 400)
      .type('text/plain')
      .send(outcome === 'accepted' ? MESSAGES.connect_callback_done : MESSAGES.connect_callback_unknown);
  });
  return router;
}
