/**
 * POST /api/encrypt-proposal-note
 *
 * G5 (PE1 brief): encrypts a "change needed" note on the deciding gateway,
 * for the proposal's submitter and mandate owner. The AS cannot check the
 * note's length once it is sealed, so this route enforces the 1-500
 * character bound the wire contract assigns to the gateway.
 *
 * Body:
 *   { note: string, recipientUserIds: string[] }
 *
 * Response:
 *   { noteEncrypted: { ciphertext: string; keys: Record<userId, {ct, enc}> }, unreadableFor: string[] }
 *
 * Auth: requireAuth (session must be active).
 */
import { Router, type Request, type Response } from 'express';
import { encryptProposalNote } from '../lib/content-crypto';
import type { Vault } from '../lib/vault';

const MAX_NOTE_LENGTH = 500;

export function createEncryptProposalNoteRouter(vault: Vault, spUrl: string, dataDir: string): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const { note, recipientUserIds } = req.body as { note?: unknown; recipientUserIds?: unknown };

    if (typeof note !== 'string' || note.length === 0 || note.length > MAX_NOTE_LENGTH) {
      res.status(400).json({ error: `note must be a non-empty string up to ${MAX_NOTE_LENGTH} characters` });
      return;
    }
    if (!Array.isArray(recipientUserIds) || !recipientUserIds.every((id) => typeof id === 'string')) {
      res.status(400).json({ error: 'recipientUserIds must be a string array' });
      return;
    }

    const me = vault.getSessionUser();
    const cookie = vault.getSpCookie();
    if (!me || !cookie) {
      res.status(401).json({ error: 'No Authority Server session.' });
      return;
    }

    try {
      const { noteEncrypted, unreadableFor } = await encryptProposalNote(
        note,
        recipientUserIds as string[],
        { spUrl, cookie, dataDir, selfUserId: me.id },
      );
      res.json({ noteEncrypted, unreadableFor });
    } catch (err) {
      console.error('[Control Plane] encrypt-proposal-note error:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Encryption failed' });
    }
  });

  return router;
}
