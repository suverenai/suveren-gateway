/**
 * Unlock-password routes (API only; no screens). Mounted at /auth.
 *
 *   GET  /auth/password/status   is a password set (no secrets)
 *   POST /auth/password/set      move a vault made by an older gateway to a password
 *   POST /auth/unlock            unlock with the password -> page session
 *   POST /auth/password/change   re-wrap the vault key under a new password
 *   POST /auth/confirm/request   the gateway builds a request for ONE exact change to a connector login
 *   POST /auth/confirm           the person confirms that request (password path)
 *
 * Errors carry a neutral `code` and a short placeholder `message`; the words
 * the person reads are Andreas's (O19).
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Vault, McpRekeyClient } from '../lib/vault';
import { sessionCookieHeader, checkOriginAndHost, parseCookie, SESSION_COOKIE } from '../lib/page-session';
import type { UnlockLimiter } from '../lib/unlock-limiter';
import type { ChangeConfirmations } from '../lib/change-confirmation';
import { pageSessionVerdict, type PageSessionDeps } from '../middleware/auth';

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 256;

/** Placeholder messages, by code. Wording is Andreas's (O19). */
export const PASSWORD_MESSAGES: Record<string, string> = {
  origin_refused: 'Request refused.',
  not_local: 'A password needs the gateway to listen on this computer only.',
  no_password: 'No password is set.',
  password_exists: 'A password is already set.',
  password_invalid: 'The password is not acceptable.',
  wrong_password: 'Wrong password.',
  too_many_attempts: 'Too many attempts. Try again later.',
  not_signed_in: 'Not signed in.',
  rekey_incomplete: 'Not finished.',
  check_key_required: 'This computer confirms with its check key.',
  bad_request: 'Bad request.',
  unauthorized: 'Unauthorized.',
};

export interface PasswordRouterDeps {
  vault: Vault;
  pageSession: PageSessionDeps;
  limiter: UnlockLimiter;
  confirmations: ChangeConfirmations;
  /**
   * Does this computer have a check key (Touch ID, Windows Hello, a security
   * key)? Nothing provides one before step 5a, so today it is always false.
   * Where one exists the password is not accepted as a confirmation.
   */
  hasCheckKey: () => boolean;
  /** The MCP server, for the move to a fresh vault key. */
  mcp?: McpRekeyClient;
  /**
   * Called after a successful unlock, once the answer is sent: a gateway that
   * set up device keys signs in to the Authority Server by its device key
   * (lib/device-signin.ts). Unset where device keys are not set up.
   */
  afterUnlock?: () => void;
}

function fail(res: Response, status: number, code: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error: code, code, message: PASSWORD_MESSAGES[code] ?? code, ...extra });
}

function passwordIn(body: unknown, field: string): string | null {
  const v = (body as Record<string, unknown> | undefined)?.[field];
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_PASSWORD_LENGTH ? v : null;
}

export function createPasswordRouter(deps: PasswordRouterDeps): Router {
  const { vault, pageSession, limiter, confirmations, hasCheckKey, mcp, afterUnlock } = deps;
  const { sessions } = pageSession;
  const router = Router();

  const sameOrigin = (req: Request, res: Response, next: NextFunction): void => {
    if (!checkOriginAndHost(req.method, req.headers.host, req.headers.origin)) { fail(res, 403, 'origin_refused'); return; }
    if (!pageSession.listensOnLoopbackOnly) { fail(res, 403, 'not_local'); return; }
    next();
  };

  const withSession = (req: Request, res: Response, next: NextFunction): void => {
    const v = pageSessionVerdict(vault, pageSession, req);
    if (!v.ok) { fail(res, v.status, v.code === 'origin_refused' || v.code === 'not_local' ? v.code : 'unauthorized', { reason: v.code }); return; }
    next();
  };

  const startSession = (res: Response): { sessionToken: string } => {
    const s = sessions.open();
    res.setHeader('Set-Cookie', sessionCookieHeader(s.cookie));
    return { sessionToken: s.token };
  };

  router.get('/password/status', (_req, res) => {
    res.json({ passwordSet: vault.hasPassword() });
  });

  /**
   * Set the password on a vault that has none. The caller proves who they are
   * the way they do today: the account key, on a vault it unlocked. Nothing
   * sealed is touched; the same key is wrapped. Opens the first page session.
   */
  router.post('/password/set', sameOrigin, async (req, res) => {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (!apiKey || !vault.isUnlocked() || !vault.validateApiKey(apiKey)) { fail(res, 401, 'unauthorized'); return; }
    if (vault.hasPassword()) { fail(res, 409, 'password_exists'); return; }
    const password = passwordIn(req.body, 'password');
    if (!password || password.length < MIN_PASSWORD_LENGTH) { fail(res, 400, 'password_invalid', { minLength: MIN_PASSWORD_LENGTH }); return; }
    const accountId = vault.getSessionUser()?.id;
    if (!accountId) { fail(res, 409, 'not_signed_in'); return; }
    let moved;
    try {
      moved = await vault.setPassword(password, accountId, mcp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'A password is already set') { fail(res, 409, 'password_exists'); return; }
      console.error('[Control Plane] Setting the unlock password failed:', msg);
      fail(res, 500, 'bad_request');
      return;
    }
    // The password is set. If the MCP server has not confirmed the move to the
    // new key, the marker stays and the retry (background, unlock, login) finishes it.
    if (moved.outcome !== 'done') { res.status(202).json({ ok: true, rekeyPending: true, ...startSession(res) }); return; }
    res.json({ ok: true, ...startSession(res) });
  });

  router.post('/unlock', sameOrigin, async (req, res) => {
    if (!vault.hasPassword()) { fail(res, 409, 'no_password'); return; }
    const password = passwordIn(req.body, 'password');
    if (!password) { fail(res, 400, 'bad_request'); return; }
    const attempt = limiter.begin();
    if (!attempt.allowed) {
      res.setHeader('Retry-After', String(attempt.retryAfterSeconds));
      fail(res, 429, 'too_many_attempts', { retryAfterSeconds: attempt.retryAfterSeconds });
      return;
    }
    const ok = vault.isUnlocked() ? await vault.verifyPassword(password) : await vault.unlockWithPassword(password);
    if (!ok) { fail(res, 401, 'wrong_password'); return; }
    limiter.succeed();
    // A move to a fresh key that did not finish (a crash, the MCP server away)
    // is completed before anything else uses the vault.
    let rekeyPending = false;
    if (vault.hasPendingRekey()) {
      const moved = await vault.reconcileRekey(mcp);
      if (moved.outcome === 'locked') { fail(res, 503, 'rekey_incomplete'); return; }
      rekeyPending = moved.outcome === 'pending';
    }
    res.json({ ok: true, ...(rekeyPending ? { rekeyPending } : {}), ...startSession(res) });
    afterUnlock?.();
  });

  router.post('/password/change', sameOrigin, withSession, async (req, res) => {
    const current = passwordIn(req.body, 'currentPassword');
    const next = passwordIn(req.body, 'newPassword');
    if (!current || !next || next.length < MIN_PASSWORD_LENGTH) { fail(res, 400, 'password_invalid', { minLength: MIN_PASSWORD_LENGTH }); return; }
    const attempt = limiter.begin();
    if (!attempt.allowed) {
      res.setHeader('Retry-After', String(attempt.retryAfterSeconds));
      fail(res, 429, 'too_many_attempts', { retryAfterSeconds: attempt.retryAfterSeconds });
      return;
    }
    if (!(await vault.changePassword(current, next))) { fail(res, 401, 'wrong_password'); return; }
    limiter.succeed();
    res.json({ ok: true });
  });

  const sessionIdOf = (req: Request): string => pageSession.sessions.idOf(parseCookie(req.headers.cookie, SESSION_COOKIE)) ?? '';

  /**
   * The gateway builds the change request for one exact change. The change is
   * what the caller is about to send (for a login: the fields), not a name:
   * the confirmation only works for a request that hashes the same.
   */
  router.post('/confirm/request', sameOrigin, withSession, (req, res) => {
    const { kind, name, change } = (req.body ?? {}) as { kind?: unknown; name?: unknown; change?: unknown };
    if ((kind !== 'replace' && kind !== 'remove') || typeof name !== 'string' || !name) { fail(res, 400, 'bad_request'); return; }
    res.json({ ok: true, request: confirmations.request(sessionIdOf(req), kind, name, change ?? null) });
  });

  /**
   * Password path: the person confirms a request with the unlock password.
   * Refused where the computer has a check key: that key confirms instead, and
   * the password is never a confirmation there (DEC-47).
   */
  router.post('/confirm', sameOrigin, withSession, async (req, res) => {
    if (hasCheckKey()) { fail(res, 409, 'check_key_required'); return; }
    const requestId = (req.body as { request_id?: unknown })?.request_id;
    const password = passwordIn(req.body, 'password');
    if (typeof requestId !== 'string' || !requestId || !password) { fail(res, 400, 'bad_request'); return; }
    const attempt = limiter.begin();
    if (!attempt.allowed) {
      res.setHeader('Retry-After', String(attempt.retryAfterSeconds));
      fail(res, 429, 'too_many_attempts', { retryAfterSeconds: attempt.retryAfterSeconds });
      return;
    }
    if (!(await vault.verifyPassword(password))) { fail(res, 401, 'wrong_password'); return; }
    limiter.succeed();
    if (!confirmations.confirm(sessionIdOf(req), requestId)) { fail(res, 404, 'bad_request'); return; }
    res.json({ ok: true, confirmation: requestId });
  });

  return router;
}
