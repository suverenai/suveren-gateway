/**
 * POST /api/encrypt-intent
 *
 * Encrypts an authority intent for a set of recipients using the HPKE
 * broadcast pattern (RFC 9180).
 *
 * This route does NOT require vault access — encryption uses only the
 * recipients' public keys (provided by the caller).
 *
 * Body:
 *   {
 *     intent: string,
 *     recipients: Array<{ userId: string; publicKey: string }>  // base64 pubkeys
 *   }
 *
 * Response:
 *   {
 *     intentCiphertext: string,                            // base64
 *     encryptedKeys: Record<string, { ct: string; enc: string }>,  // base64 values
 *     approversFrozen: string[],                           // userIds
 *     intentDisclosureHash: string,                        // "sha256:<hex>" — C2 cross-check
 *   }
 *
 * Auth: requireAuth (session must be active).
 */

import { Router, type Request, type Response } from 'express';
import { encryptForRecipients } from '../lib/e2e-crypto';
import { computeIntentDisclosureHash } from '@hap/core';

export function createEncryptIntentRouter(): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const { intent, recipients } = req.body as {
      intent?: unknown;
      recipients?: unknown;
    };

    if (typeof intent !== 'string' || intent.length === 0) {
      res.status(400).json({ error: 'Missing or invalid field: intent (string)' });
      return;
    }

    if (!Array.isArray(recipients) || recipients.length === 0) {
      res.status(400).json({ error: 'Missing or invalid field: recipients (non-empty array)' });
      return;
    }

    // Validate and parse recipients.
    const parsed: Array<{ userId: string; publicKey: Uint8Array }> = [];
    for (const r of recipients) {
      if (
        typeof r !== 'object' ||
        r === null ||
        typeof (r as Record<string, unknown>).userId !== 'string' ||
        typeof (r as Record<string, unknown>).publicKey !== 'string'
      ) {
        res.status(400).json({
          error: 'Each recipient must have { userId: string; publicKey: string (base64) }',
        });
        return;
      }
      const { userId, publicKey: pubB64 } = r as { userId: string; publicKey: string };
      let pubBytes: Uint8Array;
      try {
        pubBytes = new Uint8Array(Buffer.from(pubB64, 'base64'));
      } catch {
        res.status(400).json({ error: `Invalid base64 publicKey for userId "${userId}"` });
        return;
      }
      if (pubBytes.length !== 32) {
        res.status(400).json({
          error: `publicKey for userId "${userId}" must be 32 bytes (X25519); got ${pubBytes.length}`,
        });
        return;
      }
      parsed.push({ userId, publicKey: pubBytes });
    }

    try {
      const encrypted = await encryptForRecipients(intent, parsed);

      // Serialize binary values to base64 for the wire.
      const encryptedKeys: Record<string, { ct: string; enc: string }> = {};
      for (const [userId, wrap] of Object.entries(encrypted.encryptedKeys)) {
        encryptedKeys[userId] = {
          ct: Buffer.from(wrap.ct).toString('base64'),
          enc: Buffer.from(wrap.enc).toString('base64'),
        };
      }

      const intentCiphertextB64 = Buffer.from(encrypted.intentCiphertext).toString('base64');
      const approversFrozen = parsed.map(r => r.userId);
      const intentDisclosureHash = computeIntentDisclosureHash(intentCiphertextB64, approversFrozen);

      res.json({
        intentCiphertext: intentCiphertextB64,
        encryptedKeys,
        approversFrozen,
        intentDisclosureHash,
      });
    } catch (err) {
      console.error('[Control Plane] encrypt-intent error:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Encryption failed' });
    }
  });

  return router;
}
