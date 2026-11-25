/**
 * Unlock by Touch ID and this computer's check key (device-keys plan 5a; DEC-38, DEC-47). API only,
 * no screens. Mounted at /auth, behind SUVEREN_DEVICE_KEYS=on, and only where the control plane
 * was given the native helper (lib/platform-helper.ts):
 *
 *   GET  /auth/platform/status         is unlock by Touch ID enabled (no page session, starts nothing)
 *   POST /auth/unlock/platform         unlock the vault with a touch and open a page session (PLATFORM_UNLOCK_OPENS_PAGE_SESSION, DEC-92)
 *   GET  /auth/platform/capabilities   what this computer can do (page session; starts the helper, no touch)
 *   POST /auth/platform/enable         { password } turn unlock by Touch ID on (page session; the password, a fresh check where there is
 *                                      a check key, and one touch for the test unwrap)
 *   POST /auth/platform/disable        { password } turn it off AND re-key the vault key (page session; the password, a fresh check)
 *   POST /auth/platform/check-key/reset  { password, recoveryCode } clear a check key the helper reported invalid (page session)
 *   POST /auth/confirm/check           confirm ONE change request with the check key (page session; one touch)
 *
 * Every code is neutral; the messages are placeholders. The words the person reads are the maintainer's (O19).
 * No response and no log line carries a key, a wrap, a key blob or the helper's own message.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Vault } from '../lib/vault';
import { PlatformUnlockError } from '../lib/vault';
import { sessionCookieHeader, checkOriginAndHost, parseCookie, SESSION_COOKIE } from '../lib/page-session';
import type { UnlockLimiter } from '../lib/unlock-limiter';
import { type ChangeConfirmations, canonicalJson } from '../lib/change-confirmation';
import type { McpRekeyClient } from '../lib/vault';
import type { DeviceChainStore } from '../lib/device-chain-store';
import { deviceKeys } from '../lib/device-keys-lazy';
import { pageSessionVerdict, type PageSessionDeps } from '../middleware/auth';
import type { PlatformHelper } from '../lib/platform-helper';
import { CheckError, type CheckKeyStore, type PlatformChecks } from '../lib/platform-checks';

/**
 * Does a Touch ID unlock also open a PAGE SESSION (the browser's way into the gateway's own routes)? YES.
 *
 * Decided by the maintainer on 2026-11-20 (DEC-92, after testing on the dev lane): Touch ID opens the gateway page
 * too, not only the vault. Risk accepted: the page session is what an AI that drives the page would use, and a Touch
 * ID prompt can be confirmed out of habit by a person while an AI-driven page asks for it. Until then (S1 to S3,
 * O29) the password was the only way to a session. A session opened by a touch has exactly the limits of a password
 * session (DEC-47: one hour without use, 12 hours after the last check, restart, lock, sleep, user switch). On an
 * already unlocked vault a touch verifies the key and opens a session, the way the password does.
 * With `false` (tests only, through `opensPageSession`) a touch opens the vault and the page needs the password.
 */
export const PLATFORM_UNLOCK_OPENS_PAGE_SESSION = true;

/** Placeholder messages, by code. Wording is the maintainer's (O19). */
export const PLATFORM_MESSAGES: Record<string, string> = {
  origin_refused: 'Request refused.',
  not_local: 'This needs the gateway to listen on this computer only.',
  unauthorized: 'Unauthorized.',
  no_password: 'No password is set.',
  locked: 'The gateway is locked.',
  already_unlocked: 'The gateway is already unlocked.',
  already_enabled: 'Unlock by Touch ID is already on.',
  not_enabled: 'Unlock by Touch ID is not on.',
  rekey_pending: 'Not finished.',
  busy: 'Another Touch ID step is running.',
  vault_changed: 'The vault changed meanwhile. Try again.',
  wrap_mismatch: 'Touch ID did not open this vault. Use the password.',
  too_many_attempts: 'Too many attempts. Try again later.',
  wrong_password: 'Wrong password.',
  wrong_recovery_code: 'That is not this account\'s recovery code.',
  key_not_reported_invalid: 'The check key still works, or was not tried. Nothing was cleared.',
  no_check_key: 'This computer has no check key.',
  cancelled: 'Cancelled.',
  not_recognised: 'Not recognised.',
  biometry_locked: 'Touch ID is locked. Use the Mac password or the unlock password.',
  no_biometry: 'This computer has no Touch ID.',
  interaction_required: 'A touch is needed.',
  key_invalid: 'The key does not work here any more. Use the password.',
  helper_failed: 'The helper did not work. Use the password.',
  helper_unavailable: 'No Touch ID helper is available here.',
  check_invalid: 'The helper answered with something that is not a valid check.',
  request_unknown: 'No such open request.',
  bad_request: 'Bad request.',
};

const HELPER_STATUS: Record<string, number> = {
  user_cancelled: 409, auth_failed: 401, check_invalid: 502, biometry_locked: 409, no_biometry: 409, interaction_required: 409,
  key_invalid: 409, unwrap_failed: 409, no_secure_hardware: 409,
};
const HELPER_CODE: Record<string, string> = {
  user_cancelled: 'cancelled', check_invalid: 'check_invalid', auth_failed: 'not_recognised', biometry_locked: 'biometry_locked', no_biometry: 'no_biometry',
  interaction_required: 'interaction_required', key_invalid: 'key_invalid', unwrap_failed: 'wrap_mismatch', no_secure_hardware: 'helper_unavailable',
};

/** Why there is no usable helper here (lib/platform-helper.ts HelperUnavailable): the password path is the answer. */
const UNAVAILABLE = new Set(['unsupported_platform', 'unsupported_arch', 'helper_not_installed', 'helper_modified', 'caller_refused']);

function fail(res: Response, status: number, code: string, extra: Record<string, unknown> = {}): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ error: code, code, message: PLATFORM_MESSAGES[code] ?? code, ...extra });
}

/** The vault's refusal as a response. A helper failure keeps only the helper's CODE. */
function refusal(res: Response, err: unknown): void {
  if (err instanceof PlatformUnlockError || err instanceof CheckError) {
    const code = err.code;
    const h = err.helperCode;
    if (code === 'helper_failed' && h) {
      if (UNAVAILABLE.has(h)) { fail(res, 409, 'helper_unavailable', { reason: h }); return; }
      const mapped = HELPER_CODE[h];
      if (mapped) { fail(res, HELPER_STATUS[h] ?? 409, mapped); return; }
      fail(res, 502, 'helper_failed', { helperCode: h });
      return;
    }
    const status: Record<string, number> = {
      locked: 401, no_password: 409, already_unlocked: 409, already_enabled: 409, not_enabled: 409, rekey_pending: 409,
      busy: 409, vault_changed: 409, wrap_mismatch: 409, no_helper: 409, check_invalid: 502, wrong_password: 401, no_check_key: 409, wrong_recovery_code: 401, key_not_reported_invalid: 409, bad_request: 400,
    };
    fail(res, status[code] ?? 409, code === 'no_helper' ? 'helper_unavailable' : code, err instanceof CheckError && !PLATFORM_MESSAGES[code] ? { reason: code } : {});
    return;
  }
  console.error('[Control Plane] Touch ID step failed:', err instanceof Error ? err.name : 'error');
  fail(res, 500, 'bad_request');
}

export interface PlatformRouterDeps {
  vault: Vault;
  pageSession: PageSessionDeps;
  /** Its own limiter: a program that spams the prompt must not lock the password out. */
  limiter: UnlockLimiter;
  confirmations: ChangeConfirmations;
  host: PlatformHelper;
  checks: PlatformChecks;
  checkStore: CheckKeyStore;
  /** After a successful unlock, once the answer is sent (the sign-in by device key). */
  afterUnlock?: () => void;
  /** The password's limiter (turning Touch ID unlock on or off, clearing a check key, all take the password). */
  passwordLimiter: UnlockLimiter;
  chain: DeviceChainStore;
  mcp?: McpRekeyClient;
  /** Default PLATFORM_UNLOCK_OPENS_PAGE_SESSION. Tests set it to see the other branch. */
  opensPageSession?: boolean;
}

export function createPlatformRouter(deps: PlatformRouterDeps): Router {
  const { vault, pageSession, limiter, confirmations, host, checks, checkStore, afterUnlock, passwordLimiter, chain, mcp } = deps;
  const opensSession = deps.opensPageSession ?? PLATFORM_UNLOCK_OPENS_PAGE_SESSION;
  const router = Router();

  const sameOrigin = (req: Request, res: Response, next: NextFunction): void => {
    if (!checkOriginAndHost(req.method, req.headers.host, req.headers.origin)) { fail(res, 403, 'origin_refused'); return; }
    if (!pageSession.listensOnLoopbackOnly) { fail(res, 403, 'not_local'); return; }
    next();
  };
  const withSession = (req: Request, res: Response, next: NextFunction): void => {
    const v = pageSessionVerdict(vault, pageSession, req);
    if (!v.ok) { fail(res, v.status, v.code === 'origin_refused' || v.code === 'not_local' ? v.code : 'unauthorized', { reason: v.code }); return; }
    if (!vault.hasPassword()) { fail(res, 409, 'no_password'); return; }
    next();
  };
  const sessionIdOf = (req: Request): string => pageSession.sessions.idOf(parseCookie(req.headers.cookie, SESSION_COOKIE)) ?? '';

  router.get('/platform/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, unlockEnabled: vault.hasPlatformUnlock() });
  });

  router.post('/unlock/platform', sameOrigin, async (_req, res) => {
    if (!vault.hasPassword()) { fail(res, 409, 'no_password'); return; }
    const already = vault.isUnlocked();
    // Unlocked already: a touch can only be asked for to open a page session, which it does not (see the constant).
    if (already && !opensSession) { fail(res, 409, 'already_unlocked'); return; }
    const attempt = limiter.begin();
    if (!attempt.allowed) {
      res.setHeader('Retry-After', String(attempt.retryAfterSeconds));
      fail(res, 429, 'too_many_attempts', { retryAfterSeconds: attempt.retryAfterSeconds });
      return;
    }
    try {
      if (already) await vault.verifyWithPlatform();
      else await vault.unlockWithPlatform();
    } catch (err) {
      refusal(res, err);
      return;
    }
    limiter.succeed();
    res.setHeader('Cache-Control', 'no-store');
    if (opensSession) {
      const s = pageSession.sessions.open();
      res.setHeader('Set-Cookie', sessionCookieHeader(s.cookie));
      res.json({ ok: true, unlocked: true, sessionOpened: true, sessionToken: s.token });
    } else {
      // The vault is open (the agents continue); the page needs the unlock password for a session.
      res.json({ ok: true, unlocked: true, sessionOpened: false });
    }
    if (!already) afterUnlock?.();
  });

  router.get('/platform/capabilities', sameOrigin, withSession, async (_req, res) => {
    const s = await host.status();
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...s, unlockEnabled: vault.hasPlatformUnlock(), checkKey: checkStore.has() });
  });

  const withPassword = async (req: Request, res: Response, go: (password: string) => Promise<void>): Promise<void> => {
    const password = (req.body as { password?: unknown } | undefined)?.password;
    if (typeof password !== 'string' || !password || password.length > 256) { fail(res, 400, 'bad_request'); return; }
    const attempt = passwordLimiter.begin();
    if (!attempt.allowed) {
      res.setHeader('Retry-After', String(attempt.retryAfterSeconds));
      fail(res, 429, 'too_many_attempts', { retryAfterSeconds: attempt.retryAfterSeconds });
      return;
    }
    try {
      await go(password);
      passwordLimiter.succeed();
    } catch (err) {
      refusal(res, err);
    }
  };

  router.post('/platform/enable', sameOrigin, withSession, (req, res) => withPassword(req, res, async (password) => {
    const r = await vault.enablePlatformUnlock(password);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, backend: r.backend, policy: r.policy });
  }));

  router.post('/platform/disable', sameOrigin, withSession, (req, res) => withPassword(req, res, async (password) => {
    const moved = await vault.disablePlatformUnlock(password, mcp);
    res.setHeader('Cache-Control', 'no-store');
    // Like the move to a password: if the MCP server has not confirmed the new key, the marker stays and the retry finishes it.
    if (moved.outcome === 'locked') { fail(res, 503, 'rekey_pending'); return; }
    res.status(moved.outcome === 'done' ? 200 : 202).json({ ok: true, ...(moved.outcome === 'done' ? {} : { rekeyPending: true }) });
  }));

  /**
   * The way out of a fingerprint change (the helper said `key_invalid`): on THIS computer, with the unlock password
   * and the recovery code, the stale check key is cleared, so connector-login changes take the password again
   * (plan section 7: the password stands in only where the computer has no check key). Logged, with no secret.
   * Only after the helper really reported the key invalid (a working key is never dropped this way).
   * The device chain still names the old check key. A root-signed `set` that replaces it needs an email-link session
   * at the Authority Server (plan 3.2, DEC-15), which a program on 127.0.0.1 cannot present: NOT built here.
   */
  router.post('/platform/check-key/reset', sameOrigin, withSession, (req, res) => withPassword(req, res, async (password) => {
    const code = (req.body as { recoveryCode?: unknown } | undefined)?.recoveryCode;
    if (typeof code !== 'string' || !code || code.length > 128) throw new PlatformUnlockError('bad_request');
    if (!checkStore.has()) throw new PlatformUnlockError('no_check_key');
    if (!checks.invalidSeen) throw new PlatformUnlockError('key_not_reported_invalid');
    if (!(await vault.verifyPassword(password))) throw new PlatformUnlockError('wrong_password');
    const dk = await deviceKeys();
    let stored;
    try { stored = chain.read(); } catch { throw new PlatformUnlockError('bad_request'); }
    let did: string | null = null;
    try {
      if (await dk.isValidRecoveryCode(code)) {
        const root = await dk.rootKeyFromRecoveryCode(code);
        did = root.did;
        root.privateSeed.fill(0);
      }
    } catch { did = null; }
    if (!stored || did !== stored.rootDid) throw new PlatformUnlockError('wrong_recovery_code');
    checkStore.write(null);
    checks.invalidSeen = false;
    console.warn('[Control Plane] The check key of this computer was cleared at the person\'s request (the helper reported it invalid). Connector-login changes take the unlock password again; the device chain still names the old check key.');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, cleared: true, chainStillNamesCheckKey: true, replacement: 'needs_email_link' });
  }));

  /**
   * The computer's check over ONE change request: the check key signs the SHA-256 of the canonical JSON of the
   * request the gateway built (plan section 7, "Computer path"). One touch; the prompt says what kind of change
   * it is, from the object. The request is spent by the change itself (`ChangeConfirmations.consume`).
   * One prompt at a time: a second request while one is on screen is refused, not queued.
   */
  let prompting = false;
  router.post('/confirm/check', sameOrigin, withSession, async (req, res) => {
    const requestId = (req.body as { request_id?: unknown } | undefined)?.request_id;
    if (typeof requestId !== 'string' || !requestId || requestId.length > 64) { fail(res, 400, 'bad_request'); return; }
    if (prompting) { fail(res, 409, 'busy'); return; }
    prompting = true;
    try {
      let key;
      try { key = checkStore.read(); } catch { fail(res, 500, 'bad_request'); return; }
      if (!key) { fail(res, 409, 'no_check_key'); return; }
      const sessionId = sessionIdOf(req);
      const request = confirmations.openRequest(sessionId, requestId);
      if (!request) { fail(res, 404, 'request_unknown'); return; }
      try {
        await checks.sign(key, new TextEncoder().encode(canonicalJson(request)));
      } catch (err) {
        refusal(res, err);
        return;
      }
      if (!confirmations.confirm(sessionId, requestId, 'check')) { fail(res, 404, 'request_unknown'); return; }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, confirmation: requestId });
    } finally {
      prompting = false;
    }
  });

  return router;
}
