/**
 * Auth routes — cookie-less API key authentication.
 *
 * Login: rate-limited, validates API key against SP, captures SP session cookie
 * server-side, derives vault key, pushes both to MCP. No cookies sent to browser.
 *
 * Logout: requires auth (prevents anonymous DoS).
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { configure, pushServiceCredentials, resyncGates, startPendingIntegrations, stopAndRemoveAllIntegrations } from '../lib/mcp-bridge';
import type { Vault } from '../lib/vault';
import { loadOrGenerateKeyPair, getPublicKey } from '../lib/e2e-key-manager';

const SP_URL = process.env.HAP_SP_URL ?? 'https://www.suveren.ai';

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

export function createAuthRouter(vault: Vault, logoutAuth: Middleware, loginRateLimit: Middleware): Router {
  const router = Router();

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
      const spRes = await fetch(`${SP_URL}/api/auth/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
      });

      if (!spRes.ok) {
        const err = await spRes.json().catch(() => ({ error: 'Invalid API key' }));
        res.status(spRes.status).json(err);
        return;
      }

      // Capture SP session cookie — store server-side, never send to browser
      const setCookieHeaders = spRes.headers.getSetCookie?.() ?? [];
      const sessionCookie = setCookieHeaders.join('; ');
      vault.setSpCookie(sessionCookie);

      // Derive vault encryption key from API key
      vault.deriveAndSetKey(apiKey);

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
        vault.deriveAndSetKey(apiKey);
      }

      // Push session cookie + vault key to MCP server (must complete before responding)
      if (sessionCookie) {
        try {
          await configure(sessionCookie, vault.getVaultKeyHex());
        } catch (err) {
          console.error('[Control Plane] Failed to configure MCP:', err);
        }
      }

      // Return user data
      const data = await spRes.json();
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
          const meKeyRes = await fetch(`${SP_URL}/api/users/me/pubkey`, {
            headers: spCookie ? { Cookie: spCookie } : {},
            signal: AbortSignal.timeout(5000),
          });

          let needsUpdate = false;
          if (meKeyRes.status === 404) {
            needsUpdate = true;
          } else if (meKeyRes.ok) {
            const meKeyData = await meKeyRes.json() as { pubkey?: string };
            needsUpdate = meKeyData.pubkey !== localPubkeyB64;
          }

          if (needsUpdate) {
            const putRes = await fetch(`${SP_URL}/api/users/me/pubkey`, {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json',
                ...(spCookie ? { Cookie: spCookie } : {}),
              },
              body: JSON.stringify({ pubkey: localPubkeyB64 }),
              signal: AbortSignal.timeout(5000),
            });
            if (!putRes.ok) {
              console.error(`[Control Plane] E2EE pubkey registration failed: ${putRes.status}`);
            } else {
              console.error('[Control Plane] E2EE pubkey registered with SP');
            }
          } else {
            console.error('[Control Plane] E2EE pubkey already up to date');
          }
        } catch (err) {
          console.error('[Control Plane] E2EE pubkey auto-register failed:', err);
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
   * use `hap-gateway stop` (clean process shutdown) or revoke the
   * relevant attestations (protocol-level, granular, audited).
   */
  router.post('/logout', logoutAuth, async (_req: Request, res: Response) => {
    vault.clearKey();
    res.json({ ok: true });
  });

  return router;
}
