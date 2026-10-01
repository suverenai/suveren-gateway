/**
 * Auth routes — cookie-less API key authentication.
 *
 * Login: rate-limited, validates API key against SP, captures SP session cookie
 * server-side, derives vault key, pushes both to MCP. No cookies sent to browser.
 *
 * Logout: requires auth (prevents anonymous DoS).
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { configure, unconfigureSession, pushServiceCredentials, resyncGates, startPendingIntegrations, stopAndRemoveAllIntegrations } from '../lib/mcp-bridge';
import type { Vault } from '../lib/vault';
import { loadOrGenerateKeyPair, getPublicKey } from '../lib/e2e-key-manager';
import { clientVersionHeaders } from '../lib/client-version';
import { readPairing, writePairing, recordTlsPin, fingerprintOf } from '../lib/as-pairing';
import { verifyAsHoldsKey, AsChallengeUnreachableError, AsChallengeInvalidError, AsTlsMismatchError } from '../lib/as-challenge';
import { resolvePinTls } from '../lib/as-config';
import { fetchAs, type AsFetchPinning } from '../lib/as-tls-pin';

const DEFAULT_SP_URL = process.env.SUVEREN_AS_URL ?? 'https://www.suveren.ai';

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

export interface AuthRouterPairingOptions {
  /** The resolved Authority Server URL this process is using (as-config.ts). */
  asUrl: string;
  /** Where as-pairing.json lives. */
  dataDir: string;
}

interface AsKeyCheckResult {
  ok: boolean;
  publicKeyHex?: string;
  /**
   * The TLS SPKI pin now in EFFECT for this URL, when pin-tls is enabled —
   * whichever of "already pinned" or "just captured on this call" applies.
   * The caller persists it (writePairing / recordTlsPin, both no-ops when
   * already set) and reuses it to enforce pinning on every subsequent AS
   * call this request makes (the session POST, then onward).
   */
  tlsSpkiPinHex?: string;
  /** Machine-readable reason, present iff !ok. */
  error?: 'as_unreachable' | 'as_unverified' | 'as_key_mismatch' | 'as_tls_mismatch';
  message?: string;
}

/**
 * Fetch the AS's reported public key — used ONLY as the trust-on-first-use
 * candidate for a URL that has no pin yet. Reporting a key proves nothing by
 * itself (see as-challenge.ts); {@link checkAsKeyBeforeLogin} only trusts
 * whatever this returns once the challenge below proves the AS actually
 * holds it.
 */
async function fetchAsPublicKey(
  asUrl: string,
): Promise<{ ok: true; publicKeyHex: string } | { ok: false; message: string }> {
  try {
    const res = await fetch(`${asUrl}/api/as/pubkey`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return {
        ok: false,
        message: `Could not reach the Authority Server at ${asUrl} to read its signing key (HTTP ${res.status}). Refusing to sign in.`,
      };
    }
    const body = (await res.json().catch(() => null)) as { publicKey?: unknown } | null;
    if (!body || typeof body.publicKey !== 'string' || !body.publicKey) {
      return {
        ok: false,
        message: `The Authority Server at ${asUrl} returned a malformed signing key. Refusing to sign in.`,
      };
    }
    return { ok: true, publicKeyHex: body.publicKey };
  } catch (err) {
    return {
      ok: false,
      message: `Could not reach the Authority Server at ${asUrl} to read its signing key — ` +
        `${err instanceof Error ? err.message : String(err)}. Refusing to sign in.`,
    };
  }
}

/**
 * Verify the Authority Server at `asUrl` actually HOLDS its signing key —
 * BEFORE the API key is sent anywhere. Fail-closed rules:
 *
 *  1. When a pin already exists for this exact URL, the challenge
 *     (as-challenge.ts) is checked against the PINNED key, never against a
 *     freshly-fetched `/api/as/pubkey` value — a live answer that merely
 *     matches the pin string proves nothing (see as-challenge.ts); only a
 *     valid signature under the pin does. A pin that fails the challenge
 *     refuses sign-in outright (409 `as_key_mismatch`) — see
 *     doc/self-hosted-as.md §10, "Replacement only by re-pairing" (rotation
 *     via a signature from the old key is future work; there is no
 *     re-pairing UX yet beyond clearing the pairing record by hand).
 *  2. First pairing (no pin yet): the live `/api/as/pubkey` value is only a
 *     CANDIDATE — trust-on-first-use is conditioned on it passing the same
 *     challenge. The fingerprint shown in Settings (AuthorityServerCard.tsx)
 *     is the out-of-band check for this first pairing: compare it against
 *     the Authority Server operator's published fingerprint before trusting
 *     it. Any failure here (unreachable, malformed, or an invalid challenge)
 *     refuses sign-in (502 `as_unreachable` / `as_unverified`) rather than
 *     proceeding unpinned.
 *
 * Scope: this refuses a server that cannot produce a valid signature under
 * the key being checked (the pin, or the first-pairing candidate) — see
 * as-challenge.ts for exactly what that does and does not cover (in
 * particular: it is not a substitute for TLS against an on-path relay that
 * forwards every request, including the challenge, to the genuine Authority
 * Server). Closing THAT gap is opt-in TLS pinning (`config set pin-tls on`,
 * default off) — see as-tls-pin.ts: when enabled, the challenge call below
 * also captures (first pairing) or enforces (every sign-in after) a pin on
 * the AS TLS certificate's public key, independently of the Ed25519 check.
 *
 * Deliberately does NOT touch the API key: this runs before the caller sends
 * it to `/api/auth/session`, so a server that fails this check never
 * receives credentials.
 */
async function checkAsKeyBeforeLogin(asUrl: string, dataDir: string): Promise<AsKeyCheckResult> {
  const existing = readPairing(dataDir);
  const pinnedKey = existing && existing.asUrl === asUrl ? existing.publicKeyHex : undefined;
  const existingTlsPin = existing && existing.asUrl === asUrl ? existing.tlsSpkiPinHex : undefined;

  let candidateKey: string;
  if (pinnedKey) {
    candidateKey = pinnedKey;
  } else {
    const fetched = await fetchAsPublicKey(asUrl);
    if (!fetched.ok) {
      return { ok: false, error: 'as_unreachable', message: fetched.message };
    }
    candidateKey = fetched.publicKeyHex;
  }

  // Opt-in TLS pinning (`config set pin-tls on`) — see as-tls-pin.ts. Only
  // the challenge call below is ever allowed to CAPTURE a new pin; every
  // other AS call in this file only enforces whatever is already pinned.
  const pinning: AsFetchPinning = {
    enabled: resolvePinTls(dataDir),
    pinnedSpkiHex: existingTlsPin,
    captureIfUnpinned: true,
  };

  let capturedTlsSpkiHex: string | undefined;
  try {
    const result = await verifyAsHoldsKey(asUrl, candidateKey, pinning);
    capturedTlsSpkiHex = result.capturedTlsSpkiHex;
  } catch (err) {
    if (err instanceof AsTlsMismatchError) {
      return { ok: false, error: 'as_tls_mismatch', message: err.message };
    }
    if (err instanceof AsChallengeUnreachableError) {
      // Network/5xx on the challenge itself — refuse fail-closed regardless
      // of whether a pin exists; this says nothing about a mismatch, only
      // that nothing could be verified.
      return { ok: false, error: 'as_unverified', message: `${err.message}. Refusing to sign in.` };
    }
    if (err instanceof AsChallengeInvalidError) {
      if (pinnedKey) {
        return {
          ok: false,
          error: 'as_key_mismatch',
          message:
            `The Authority Server at ${asUrl} does not match the one pinned when this gateway last ` +
            `signed in (pinned fingerprint ${fingerprintOf(pinnedKey)}) — its signing-key challenge did ` +
            `not verify (${err.message}). Refusing to sign in. If the AS's key changed intentionally, ` +
            `an operator must clear the old pairing before signing in again.`,
        };
      }
      return {
        ok: false,
        error: 'as_unverified',
        message:
          `The Authority Server at ${asUrl} could not prove it holds the signing key it presented — ` +
          `${err.message}. Refusing to sign in.`,
      };
    }
    throw err;
  }

  return {
    ok: true,
    publicKeyHex: candidateKey,
    tlsSpkiPinHex: pinning.enabled ? (existingTlsPin ?? capturedTlsSpkiHex) : undefined,
  };
}

export function createAuthRouter(
  vault: Vault,
  logoutAuth: Middleware,
  loginRateLimit: Middleware,
  /**
   * Called right after a successful login sets `vault.setSessionExpiresAt`,
   * so the expiry scheduler can re-arm its timer against the NEW value
   * immediately rather than on its next coarse tick.
   */
  onSessionEstablished?: () => void,
  /**
   * Optional so existing callers (and this router's own tests) keep working
   * unpinned. Real production wiring (index.ts) always supplies it.
   */
  pairing?: AuthRouterPairingOptions,
  /**
   * Called on a TLS pin mismatch (as-tls-pin.ts) discovered on an AS call
   * made AFTER a session was already established (the background E2EE sweep,
   * logout) — the ongoing-session counterpart to the login-time refusal
   * below. Optional so existing callers/tests keep working; index.ts always
   * supplies it. Defaults to a no-op, not to the real lock, so a test that
   * doesn't pass one can't accidentally touch global state.
   */
  lockAsTlsMismatch: () => void = () => {},
): Router {
  const router = Router();
  const SP_URL = pairing?.asUrl ?? DEFAULT_SP_URL;

  /**
   * POST /auth/login
   * Header: X-API-Key: hap_xxx
   *
   * 1. Rate-limited (10 attempts / minute per IP)
   * 2. Calls SP POST /api/auth/session with X-API-Key
   * 3. Captures SP session cookie -> server-side only
   * 4. Derives vault key from API key
   * 5. Pushes cookie + vault key to MCP
   * 6. Returns { user, groups } — NO Set-Cookie headers
   */
  router.post('/login', loginRateLimit, async (req: Request, res: Response) => {
    const apiKey = (req.headers['x-api-key'] as string) || (req.body as { apiKey?: string })?.apiKey;
    const confirmWipe = (req.body as { confirmWipe?: boolean })?.confirmWipe === true;
    if (!apiKey) {
      res.status(400).json({ error: 'Missing API key (X-API-Key header or body.apiKey)' });
      return;
    }

    try {
      // Check the AS's signing key BEFORE the API key is sent anywhere — an
      // impostor server must not receive real credentials just to be told
      // "no" a moment later. See checkAsKeyBeforeLogin: this also refuses
      // outright (rather than proceeding unpinned) when the key can't be
      // fetched or is malformed.
      let keyCheck: AsKeyCheckResult | null = null;
      if (pairing) {
        keyCheck = await checkAsKeyBeforeLogin(pairing.asUrl, pairing.dataDir);
        if (!keyCheck.ok) {
          const status = keyCheck.error === 'as_key_mismatch' || keyCheck.error === 'as_tls_mismatch' ? 409 : 502;
          res.status(status).json({
            error: keyCheck.error,
            message: keyCheck.message,
          });
          return;
        }
      }

      // The EFFECTIVE TLS pin for this request (as established by the check
      // above — already pinned, or just captured) — enforced on every AS
      // call this handler makes from here on. `enabled: false` (pin-tls off)
      // makes fetchAs behave exactly like a bare `fetch`.
      const sessionPinning: AsFetchPinning = {
        enabled: Boolean(pairing && resolvePinTls(pairing.dataDir)),
        pinnedSpkiHex: keyCheck?.tlsSpkiPinHex,
        captureIfUnpinned: false,
      };

      // NOT `Response` bare — that identifier in this file resolves to
      // Express's type (imported above for `res`), not the Fetch API one
      // `fetchAs` actually returns.
      let spRes: Awaited<ReturnType<typeof fetchAs>>['res'];
      try {
        const result = await fetchAs(
          `${SP_URL}/api/auth/session`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-Key': apiKey,
              // The AS grants a 30-day gateway session ONLY to a login that
              // identifies itself this way; without it, a 24-hour browser
              // session (see doc at the top of this file).
              ...clientVersionHeaders(),
            },
          },
          sessionPinning,
        );
        spRes = result.res;
      } catch (err) {
        if (err instanceof AsTlsMismatchError) {
          // No session exists yet at this point (the API key hasn't even
          // been accepted) — nothing to lock, just refuse, same shape as the
          // challenge-time refusal above. The API key was already written
          // into the request this handler built, but fetchAs aborts the TLS
          // handshake before Node ever writes a byte of it to the wire.
          res.status(409).json({ error: 'as_tls_mismatch', message: err.message });
          return;
        }
        throw err;
      }

      if (!spRes.ok) {
        const err = await spRes.json().catch(() => ({ error: 'Invalid API key' }));
        res.status(spRes.status).json(err);
        return;
      }

      // Pin the key now that the credentials are known good AND the key
      // check above already passed (fresh pairing, or matching an existing
      // pin — a mismatch already returned above). Only a fresh pairing needs
      // a write; matching an existing pin is a no-op. The TLS pin (if any)
      // rides along with a fresh pairing, or is attached separately via
      // recordTlsPin when the signing-key pin already existed but pin-tls
      // was turned on more recently (no TLS pin yet for an otherwise-paired
      // URL).
      if (pairing && keyCheck?.publicKeyHex) {
        const existing = readPairing(pairing.dataDir);
        if (!existing || existing.asUrl !== pairing.asUrl) {
          writePairing(pairing.dataDir, pairing.asUrl, keyCheck.publicKeyHex, {
            tlsSpkiPinHex: keyCheck.tlsSpkiPinHex,
          });
          console.error(`[Control Plane] Paired with Authority Server ${pairing.asUrl} (fingerprint ${fingerprintOf(keyCheck.publicKeyHex)})`);
        } else if (keyCheck.tlsSpkiPinHex && !existing.tlsSpkiPinHex) {
          recordTlsPin(pairing.dataDir, pairing.asUrl, keyCheck.tlsSpkiPinHex);
          console.error(`[Control Plane] Captured TLS pin for Authority Server ${pairing.asUrl} (pin-tls just enabled).`);
        }
      }

      // Read the body once — reused below both for sessionExpiresAt and as
      // the response returned to the browser.
      const data = (await spRes.json()) as { sessionExpiresAt?: number } & Record<string, unknown>;

      // Capture SP session cookie — store server-side, never send to browser
      const setCookieHeaders = spRes.headers.getSetCookie?.() ?? [];
      const sessionCookie = setCookieHeaders.join('; ');
      vault.setSpCookie(sessionCookie);

      // Derive vault encryption key from API key
      await vault.deriveAndSetKey(apiKey);

      // Vault encryption key is derived from the API key. Logging in with a
      // different API key on the same gateway means the existing vault
      // contents (service credentials, integrations, E2EE keypair, gates)
      // become unreadable and must be wiped. This is destructive — block on
      // it until the UI has explicitly confirmed.
      if (vault.isVaultFromDifferentKey()) {
        if (!confirmWipe) {
          // Build a summary of what would be lost so the UI can warn clearly.
          const credentialIds = vault.listCredentials();
          const services = vault.listServices();
          // Drop the just-derived (wrong) key so subsequent calls don't
          // accidentally encrypt anything against the new salt.
          vault.clearKey();
          res.status(409).json({
            error: 'different_account',
            wouldWipe: true,
            summary: {
              credentialCount: credentialIds.length,
              serviceCount: services.length,
              credentialIds,
            },
          });
          return;
        }
        console.error('[Control Plane] Different user confirmed — wiping vault and removing previous integrations');
        // A different API key on this machine means a different person.
        // Remove the prior user's integrations from the registry so their
        // configuration doesn't leak into the new user's session.
        try {
          await stopAndRemoveAllIntegrations();
        } catch (err) {
          console.error('[Control Plane] Failed to remove integrations:', err);
        }
        vault.wipe();
        // Re-derive key after wipe (wipe clears the salt, need a fresh one)
        await vault.deriveAndSetKey(apiKey);
      }

      // Session length: the AS reports when THIS session ends (30 days, given
      // the version header above; older/unpatched AS deployments may omit
      // it). Held in memory only — see vault.ts's doc on spSessionExpiresAt.
      const sessionExpiresAt = typeof data.sessionExpiresAt === 'number' ? data.sessionExpiresAt : null;
      vault.setSessionExpiresAt(sessionExpiresAt);
      onSessionEstablished?.();

      // Push session cookie + vault key to MCP server (must complete before responding)
      if (sessionCookie) {
        try {
          await configure(sessionCookie, vault.getVaultKeyHex());
        } catch (err) {
          console.error('[Control Plane] Failed to configure MCP:', err);
        }
      }

      // Return user data
      res.json(data);

      // Background: re-push credentials, trigger a pending-integrations retry,
      // re-sync gates, and register the E2EE public key on the SP (non-blocking).
      //
      // The per-credential pushServiceCredentials path already fires
      // startIntegrationForService for integrations whose envKeys reference the
      // credId. The explicit startPendingIntegrations() afterwards catches
      // the case where an integration's envKeys reference a service id that
      // doesn't match the credId — so the sweep sees the updated credentials
      // and starts everything that's resolvable now. Silently-skipped
      // integrations log their missing keys on the MCP side.
      (async () => {
        // P5.3: Auto-register E2EE public key on the SP (idempotent).
        try {
          const kp = await loadOrGenerateKeyPair(vault);
          const localPubkeyB64 = Buffer.from(kp.publicKey).toString('base64');

          // Fetch currently registered key from SP and compare.
          const spCookie = vault.getSpCookie();
          const { res: meKeyRes } = await fetchAs(
            `${SP_URL}/api/users/me/pubkey`,
            { headers: spCookie ? { Cookie: spCookie } : {}, signal: AbortSignal.timeout(5000) },
            sessionPinning,
          );

          let needsUpdate = false;
          if (meKeyRes.status === 404) {
            needsUpdate = true;
          } else if (meKeyRes.ok) {
            const meKeyData = await meKeyRes.json() as { pubkey?: string };
            needsUpdate = meKeyData.pubkey !== localPubkeyB64;
          }

          if (needsUpdate) {
            const { res: putRes } = await fetchAs(
              `${SP_URL}/api/users/me/pubkey`,
              {
                method: 'PUT',
                headers: {
                  'Content-Type': 'application/json',
                  ...(spCookie ? { Cookie: spCookie } : {}),
                },
                body: JSON.stringify({ pubkey: localPubkeyB64 }),
                signal: AbortSignal.timeout(5000),
              },
              sessionPinning,
            );
            if (!putRes.ok) {
              console.error(`[Control Plane] E2EE pubkey registration failed: ${putRes.status}`);
            } else {
              console.error('[Control Plane] E2EE pubkey registered with SP');
            }
          } else {
            console.error('[Control Plane] E2EE pubkey already up to date');
          }
        } catch (err) {
          if (err instanceof AsTlsMismatchError) {
            console.error('[Control Plane] E2EE pubkey auto-register aborted — TLS pin mismatch:', err.message);
            lockAsTlsMismatch();
          } else {
            console.error('[Control Plane] E2EE pubkey auto-register failed:', err);
          }
        }

        for (const credId of vault.listCredentials()) {
          try {
            const creds = vault.getCredential(credId);
            if (creds) {
              await pushServiceCredentials(credId, creds);
              console.error(`[Control Plane] Pushed ${credId} credentials to MCP`);
            }
          } catch (err) {
            console.error(`[Control Plane] Failed to push ${credId} credentials:`, err);
          }
        }
        try {
          const { running } = await startPendingIntegrations();
          console.error(`[Control Plane] Post-unlock sweep — running: ${running.join(', ') || '(none)'}`);
        } catch (err) {
          console.error('[Control Plane] Post-unlock sweep failed:', err);
        }
        try {
          const { synced } = await resyncGates();
          if (synced > 0) {
            console.error(`[Control Plane] Re-synced ${synced} gate(s) with SP`);
          }
        } catch (err) {
          console.error('[Control Plane] Failed to re-sync gates:', err);
        }
      })().catch(() => {});
    } catch (err) {
      console.error('[Control Plane] Login error:', err);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  /**
   * POST /auth/logout
   * Requires valid X-API-Key — prevents anonymous DoS.
   *
   * Clears the in-memory vault key + SP cookie. Deliberately leaves
   * running integrations and the integration registry alone — agents
   * acting under existing attestations continue working asynchronously
   * regardless of whether the human is logged into the UI. That's the
   * point of Suveren's bounded-authority model. To halt all agent traffic,
   * use `suveren-gateway stop` (clean process shutdown) or revoke the
   * relevant attestations (protocol-level, granular, audited).
   */
  router.post('/logout', logoutAuth, async (_req: Request, res: Response) => {
    // Signing out must stop the agent too. Clearing only the vault key left the
    // MCP server holding the AS session, so tickets kept being issued after the
    // UI showed "signed out". End the session everywhere: here, in the MCP
    // server, and on the Authority Server (a 30-day session must not outlive
    // the sign-out). The last two are best effort: the local lock is what counts.
    const cookie = vault.getSpCookie();
    vault.clearKey();
    // Enforce the TLS pin here too, for the same reason as every other AS
    // call in this file — but a mismatch on LOGOUT must never block it: the
    // vault key is already cleared above (that's what actually matters
    // locally), and failing to tell a possibly-hostile network party "log me
    // out" is not a problem worth surfacing to the user as an error.
    const logoutPinning: AsFetchPinning = pairing
      ? { enabled: resolvePinTls(pairing.dataDir), pinnedSpkiHex: readPairing(pairing.dataDir)?.tlsSpkiPinHex, captureIfUnpinned: false }
      : { enabled: false };
    await Promise.allSettled([
      unconfigureSession(),
      cookie
        ? fetchAs(
            `${SP_URL}/api/auth/logout`,
            { method: 'POST', headers: { cookie, ...clientVersionHeaders() }, redirect: 'manual' },
            logoutPinning,
          ).catch(err => {
            if (err instanceof AsTlsMismatchError) {
              console.error('[Control Plane] Logout: TLS pin mismatch talking to the Authority Server — local sign-out still applied:', err.message);
              lockAsTlsMismatch();
            } else {
              throw err;
            }
          })
        : Promise.resolve(),
    ]);
    res.json({ ok: true });
  });

  return router;
}
