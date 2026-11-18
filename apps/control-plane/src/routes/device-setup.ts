/**
 * Device-key set-up and sign-in (device-keys plan step 6). API only, no screens.
 * Mounted at /auth, behind SUVEREN_DEVICE_KEYS=on, on a vault that has an
 * unlock password:
 *
 *   GET  /auth/device/status                 set up? signed in? (no secrets)
 *   POST /auth/device/setup/start            { label? } -> the recovery code, ONCE, and the setup id
 *   POST /auth/device/setup/cancel           drop a started set-up
 *   POST /auth/device/setup/connect          { setupId } -> the address to open in the system browser (Connect)
 *   GET  /auth/device/setup/connect/status   ?setupId -> waiting | ready | failed | expired
 *   POST /auth/device/setup/finish           { setupId, enrolmentCode? } -> genesis, chain stored, signed in
 *   POST /auth/device/signin                 sign in by device key now
 *   GET  /connect/callback                   the system browser's way back (no page session; `state` authorises it)
 *
 * Every /auth/device route sits behind the page session (cookie AND header token,
 * Origin and Host), checked by the router itself: a path that reaches a handler
 * has passed it, however the path was written. Every code is neutral; the
 * messages are placeholders. The words the person reads are the maintainer's (O19, O26).
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Vault } from '../lib/vault';
import { parseCookie, SESSION_COOKIE, checkOriginAndHost } from '../lib/page-session';
import { pageSessionVerdict, type PageSessionDeps } from '../middleware/auth';
import { DeviceSetup, SetupRefusal } from '../lib/device-setup';
import type { DeviceSignin } from '../lib/device-signin';

/** Placeholder messages, by code. Wording is the maintainer's (O19, O26). */
export const DEVICE_MESSAGES: Record<string, string> = {
  // the page session (middleware/auth.ts)
  unauthorized: 'Unauthorized.',
  origin_refused: 'Request refused.',
  not_local: 'Device keys need the gateway to listen on this computer only.',
  // set-up
  locked: 'The gateway is locked.',
  password_required: 'Set an unlock password first.',
  rekey_pending: 'Not finished.',
  already_set_up: 'Device keys are already set up on this computer.',
  setup_busy: 'Another set-up step is running.',
  setup_pending: 'A set-up was started and not finished.',
  setup_unknown: 'No such set-up.',
  label_invalid: 'The name is not acceptable.',
  bad_request: 'Bad request.',
  enrolment_code_missing: 'An enrolment code is needed.',
  enrolment_code_invalid: 'The enrolment code is not acceptable.',
  setup_refused: 'The Authority Server refused.',
  head_mismatch: 'The Authority Server answered with a chain that is not ours.',
  // Connect
  connect_not_started: 'Connect was not started.',
  connect_other_session: 'Connect was started in another window.',
  connect_port_unsupported: 'Connect cannot use this port.',
  connect_refused: 'Connect was refused.',
  connect_timeout: 'Connect did not come back.',
  connect_failed: 'Connect failed.',
  connect_callback_done: 'You can close this tab.',
  connect_callback_unknown: 'Nothing to connect.',
  // the Authority Server
  as_unreachable: 'The Authority Server could not be reached.',
  as_unverified: 'The Authority Server could not be verified.',
  as_key_mismatch: 'The Authority Server is not the one this gateway was paired with.',
  as_tls_mismatch: 'The Authority Server connection did not match its pin.',
  as_error: 'The Authority Server had an error.',
  as_answer_invalid: 'The Authority Server answered with something unexpected.',
  // sign-in
  not_set_up: 'Device keys are not set up.',
  chain_unreadable: 'The stored device chain cannot be read.',
  key_mismatch: 'This computer\'s key does not match the stored chain.',
  key_missing: 'This computer has no device key.',
  as_url_mismatch: 'The device chain was made on another Authority Server.',
  connect_loopback_unsupported: 'Connect needs the gateway to listen on 127.0.0.1.',
  aud_mismatch: 'The Authority Server named another key.',
  rate_limited: 'Too many attempts. Try again later.',
  signin_refused: 'The sign-in was refused.',
  chain_invalid: 'The device chain is not valid.',
  chain_rollback: 'The chain is shorter than the one this computer verified.',
  chain_fork: 'The chain differs from the one this computer verified.',
  device_removed: 'This computer was removed from the chain.',
  establish_failed: 'The sign-in could not be completed.',
  rekey_incomplete: 'Not finished.',
  signin_failed: 'The sign-in failed.',
  use_device_signin: 'This gateway signs in with its device key.',
};

const SIGNIN_STATUS: Record<string, number> = {
  locked: 401, not_set_up: 409, chain_unreadable: 500, key_mismatch: 409,
  as_unreachable: 502, as_unverified: 502, as_error: 502, as_answer_invalid: 502,
  as_key_mismatch: 409, as_tls_mismatch: 409, aud_mismatch: 502, rate_limited: 429,
  signin_refused: 403, head_mismatch: 502, key_missing: 409, as_url_mismatch: 409, chain_invalid: 409, chain_rollback: 409, chain_fork: 409, device_removed: 409,
};

function fail(res: Response, status: number, code: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error: code, code, message: DEVICE_MESSAGES[code] ?? code, ...extra });
}

export interface DeviceSetupRouterDeps {
  vault: Vault;
  pageSession: PageSessionDeps;
  setup: DeviceSetup;
  signin: DeviceSignin;
}

export function createDeviceSetupRouter(deps: DeviceSetupRouterDeps): Router {
  const { vault, pageSession, setup, signin } = deps;
  const router = Router();
  const api = Router();

  /** The page session, every time, for every handler below. A path cannot reach a handler without it. */
  const guard = (req: Request, res: Response, next: NextFunction): void => {
    const v = pageSessionVerdict(vault, pageSession, req);
    if (!v.ok) { fail(res, v.status, v.code === 'origin_refused' || v.code === 'not_local' ? v.code : 'unauthorized', { reason: v.code }); return; }
    // Device keys exist on a vault with a password only; the account key never reaches these.
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
      console.error('[Control Plane] Device set-up error:', err instanceof Error ? err.name : 'error');
      fail(res, 500, 'bad_request');
    }
  };

  api.get('/status', run((_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const s = setup.status();
    res.json({ ok: true, ...s, ...signin.status() });
  }));

  api.post('/setup/start', run(async (req, res) => {
    const label = (req.body as { label?: unknown } | undefined)?.label;
    const started = await setup.start({ label });
    // The one place the recovery code is ever sent. It must not be cached or kept by anything between.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...started });
  }));

  api.post('/setup/cancel', run((_req, res) => {
    setup.cancel();
    res.json({ ok: true });
  }));

  api.post('/setup/connect', run((req, res) => {
    const port = req.socket.localPort;
    const out = setup.connectStart((req.body as { setupId?: unknown } | undefined)?.setupId, port ?? 0, sessionIdOf(req), req.socket.localAddress);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...out });
  }));

  api.get('/setup/connect/status', run((req, res) => {
    const out = setup.connectStatus(req.query.setupId, sessionIdOf(req));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...out });
  }));

  api.post('/setup/finish', run(async (req, res) => {
    const b = (req.body ?? {}) as { setupId?: unknown; enrolmentCode?: unknown };
    const done = await setup.finish({ setupId: b.setupId, enrolmentCode: b.enrolmentCode, sessionId: sessionIdOf(req) });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...done });
  }));

  api.post('/signin', run(async (_req, res) => {
    const r = await signin.signIn();
    res.setHeader('Cache-Control', 'no-store');
    if (!r.ok) {
      fail(res, SIGNIN_STATUS[r.code] ?? 500, r.code, {
        ...(r.asCode ? { asCode: r.asCode } : {}),
        ...(r.retryAfterSeconds !== undefined ? { retryAfterSeconds: r.retryAfterSeconds } : {}),
      });
      return;
    }
    res.json({ ok: true, expiresAt: r.session.expiresAt });
  }));

  router.use('/device', api);
  return router;
}

/**
 * The system browser's way back from suveren.ai (Connect, RFC 8252). No page
 * session: a redirect that crosses sites carries no SameSite=Strict cookie.
 * What authorises it is `state` (random, kept only inside DeviceSetup, tied to
 * the page session that started Connect, single-use, ten minutes), checked
 * where the work happens, not by this path. The answer says nothing about the
 * account; the page reads the outcome with its own session.
 */
export function createConnectCallbackRouter(deps: { pageSession: PageSessionDeps; setup: DeviceSetup }): Router {
  const router = Router();
  const one = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  router.get('/callback', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    if (!deps.pageSession.listensOnLoopbackOnly || !checkOriginAndHost('GET', req.headers.host, req.headers.origin)) {
      res.status(403).type('text/plain').send(DEVICE_MESSAGES.origin_refused);
      return;
    }
    const outcome = await deps.setup.connectCallback({
      state: one(req.query.state), code: one(req.query.code), error: one(req.query.error),
    });
    res.status(outcome === 'accepted' ? 200 : 400)
      .type('text/plain')
      .send(outcome === 'accepted' ? DEVICE_MESSAGES.connect_callback_done : DEVICE_MESSAGES.connect_callback_unknown);
  });
  return router;
}
