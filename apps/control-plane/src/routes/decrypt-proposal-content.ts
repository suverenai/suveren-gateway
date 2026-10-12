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
import { decryptProposalContent } from '../lib/content-crypto';
import { loadOrGenerateKeyPair } from '../lib/e2e-key-manager';
import type { Vault } from '../lib/vault';

export function createDecryptProposalContentRouter(vault: Vault): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const { ciphertext, keys } = req.body as { ciphertext?: unknown; keys?: unknown };

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
      const plaintext = await decryptProposalContent(
        { ciphertext, keys: keys as Record<string, { ct: string; enc: string }> },
        me.id,
        kp.privateKey,
      );
      res.json({ plaintext });
    } catch (err) {
      console.error('[Control Plane] decrypt-proposal-content error:', err);
      const msg = err instanceof Error ? err.message : 'Decryption failed';
      res.status(msg.includes('No key wrap') ? 403 : 500).json({ error: msg });
    }
  });

  return router;
}
