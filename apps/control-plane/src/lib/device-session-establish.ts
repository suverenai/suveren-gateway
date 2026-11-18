/**
 * What a device sign-in does once the Authority Server has opened a session
 * (device-keys step 6): the same hand-over routes/auth.ts makes after an
 * account-key login, minus everything that belongs to the account key.
 *
 * First sign-in of an unlock:
 *   - the bearer token becomes the vault's Authority Server credential
 *     (`vault.setSpCookie`, read through lib/as-credential.ts),
 *   - the person is recorded. The token's end is NOT recorded as the session end: the
 *     expiry scheduler would lock the gateway at it, and a token ending (an outage, a
 *     sleep) must only trigger a new sign-in (lib/device-signin.ts), never a lock,
 *   - a move to a fresh vault key that did not finish is completed first,
 *   - the MCP server gets the token and the vault key it can read its stores with,
 *   - in the background: connector replacements, credentials, pending connectors,
 *     gate re-sync (as after a login).
 * A renewal only swaps the token, here and in the MCP server.
 *
 * Not done here, on purpose: registering the reading key through the legacy
 * `/api/users/me/pubkey`. An account on device keys carries its reading key in the
 * chain (`device.read_pub`); an account is either on today's mechanism or on device
 * keys, never both (plan 9.2).
 */

import type { Vault, McpRekeyClient } from './vault';
import type { DeviceSession } from './device-signin';
import { bearerCredential } from './as-credential';

export interface EstablishDeps {
  vault: Vault;
  /** The MCP server's rekey client; undefined where there is none. */
  mcpRekey?: McpRekeyClient;
  /** mcp-bridge `configure`. */
  configure: (credential: string, vaultKeyHex?: string) => Promise<void>;
  /** Re-arm the expiry scheduler against the new session end. */
  onSessionEstablished?: () => void;
  /** The background work after a login. Errors are the sweep's own to log. */
  sweep?: () => Promise<void>;
  log?: (m: string) => void;
}

export function createEstablish(d: EstablishDeps): (s: DeviceSession, first: boolean) => Promise<void> {
  const log = d.log ?? (m => console.error(m));
  return async (session, first) => {
    const { vault } = d;
    // The vault may have locked while the Authority Server answered: nothing is handed over then.
    if (!vault.isUnlocked()) throw new Error('locked');
    const credential = bearerCredential(session.token);

    if (!first) {
      vault.setSpCookie(credential);
      // The token's end must never lock the vault: it only means "sign in again" (lib/device-signin.ts).
      vault.setSessionExpiresAt(null);
      d.onSessionEstablished?.();
      try { await d.configure(credential); } catch (err) { log(`[Control Plane] Could not give the renewed session to the MCP server: ${err instanceof Error ? err.message : 'error'}`); }
      return;
    }

    let mcpKeyHex: string | null = vault.getVaultKeyHex();
    if (vault.hasPendingRekey()) {
      const moved = await vault.reconcileRekey(d.mcpRekey);
      if (moved.outcome === 'locked') throw new Error('rekey_incomplete');
      mcpKeyHex = moved.mcpKeyHex;
    }
    if (!vault.isUnlocked()) throw new Error('locked'); // locked while the MCP server was moved
    vault.setSpCookie(credential);
    vault.setSessionExpiresAt(null);
    vault.setSessionUser({ id: session.user.id, did: session.user.did });
    d.onSessionEstablished?.();
    if (mcpKeyHex) {
      try { await d.configure(credential, mcpKeyHex); } catch (err) { log(`[Control Plane] Failed to configure MCP: ${err instanceof Error ? err.message : 'error'}`); }
    }
    if (d.sweep) void d.sweep().catch(() => { /* logged by the sweep */ });
  };
}
