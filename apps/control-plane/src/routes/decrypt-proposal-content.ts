/**
 * POST /api/decrypt-proposal-content
 *
 * Decrypts a proposal's sealed content (toolArgs, JCS-encoded — the caller
 * JSON.parses the result) or a change-needed note, on behalf of the signed-in
 * user, using the vault's private HPKE key. Generalizes /api/decrypt-intent
 * (same construction) to any JCS/text payload, and resolves "my own user id"
 * from the session (`vault.getSessionUser()`) instead of trusting a
 * body-supplied id.
 *
 * Body:
 *   { ciphertext: string, keys: Record<userId, { ct: string; enc: string }> }
 *
 * Response:
 *   { plaintext: string }
 *
 * Auth: session must be active (requireAuth middleware applied by caller in index.ts).
 */
import { Router, type Request, type Response } from 'express';
import { decryptProposalContent, decryptProposalContext, NoWrapError } from '../lib/content-crypto';
import type { DeviceChainStore } from '../lib/device-chain-store';
import { loadOrGenerateKeyPair } from '../lib/e2e-key-manager';
import type { Vault } from '../lib/vault';

export function createDecryptProposalContentRouter(vault: Vault, deviceStore?: DeviceChainStore): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const { ciphertext, hash, proposalContentHash, device_keys: deviceKeysIn, context } = req.body as {
      ciphertext?: unknown; keys?: unknown; encrypted_keys?: unknown; device_keys?: unknown; context?: unknown; hash?: unknown; proposalContentHash?: unknown;
    };
    // Both names: under a 0.8 mandate `encrypted_keys` is keyed by DID and
    // `keys` by account id (the same CEK); under 0.7 they are the same wraps.
    const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
    const { encrypted_keys: ek, keys: lk } = req.body as { encrypted_keys?: unknown; keys?: unknown };
    const keys = isObj(ek) || isObj(lk) ? { ...(isObj(lk) ? lk : {}), ...(isObj(ek) ? ek : {}) } : undefined;

    if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
      res.status(400).json({ error: 'Missing or invalid field: ciphertext (base64 string)' });
      return;
    }
    if (typeof keys !== 'object' || keys === null) {
      res.status(400).json({ error: 'Missing or invalid field: keys (object)' });
      return;
    }

    const me = vault.getSessionUser();
    if (!me) {
      res.status(401).json({ error: 'No Authority Server session.' });
      return;
    }

    try {
      const kp = await loadOrGenerateKeyPair(vault);
      // Device keys, step 8: this computer's own entry in `device_keys` is read first, then the legacy wrap.
      let myKeyId: string | undefined;
      try { myKeyId = deviceStore?.read()?.keyId; } catch { /* an unreadable slot: the legacy wrap is tried */ }
      const wire = {
        ciphertext,
        keys: keys as Record<string, { ct: string; enc: string }>,
        ...(typeof deviceKeysIn === 'object' && deviceKeysIn !== null && !Array.isArray(deviceKeysIn) ? { device_keys: deviceKeysIn as Record<string, { ct: string; enc: string }> } : {}),
        ...(typeof context === 'string' ? { context } : {}),
        // v0.8 rule 8: when the caller passes the proposal's fingerprint, the
        // decrypted content is checked against it before it is shown.
        ...(typeof hash === 'string' ? { hash } : {}),
        ...(typeof proposalContentHash === 'string' ? { proposalContentHash } : {}),
      };
      const plaintext = await decryptProposalContent(wire, me.id, kp.privateKey, me.did, myKeyId);
      // The card context is checked on open, bound to this proposal; a failure never hides the arguments.
      const ctx = await decryptProposalContext(wire, me.id, kp.privateKey, me.did, myKeyId);
      res.json({ plaintext, ...(ctx ? ctx : {}) });
    } catch (err) {
      console.error('[Control Plane] decrypt-proposal-content error:', err);
      const msg = err instanceof Error ? err.message : 'Decryption failed';
      res.status(msg.includes('No key wrap') ? 403 : 500).json({ error: msg, ...(err instanceof NoWrapError ? { code: err.code } : {}) });
    }
  });

  return router;
}
