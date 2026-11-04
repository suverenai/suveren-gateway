/**
 * POST /internal/encrypt-content, POST /internal/decrypt-content — the MCP
 * server asking the control plane to seal/open proposal content (toolArgs,
 * JCS-canonicalized) for a set of recipients, or a change-needed note. The
 * vault's private HPKE key — and the AS session needed to look up
 * recipients' public keys — live only in the control plane; the MCP server
 * has neither, so it round-trips through here, exactly like
 * /internal/mandate.
 *
 * Authenticated by the shared internal secret (like /internal/event), not a
 * browser session. "My own user id" is NOT trusted from the request body —
 * it is read from `vault.getSessionUser()`, the control plane's own signed-in
 * identity (same source /internal/mandate uses for "who is this mandate for").
 */
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { encryptProposalContent, decryptProposalContent, type V08Readers } from '../lib/content-crypto';
import { loadOrGenerateKeyPair, getPublicKey } from '../lib/e2e-key-manager';
import type { Vault } from '../lib/vault';

/** The wire contract's cap (PE1 brief): ≤ 50 recipients per proposal. */
const MAX_RECIPIENTS = 50;

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createInternalContentCryptoRouter(
  getSecret: () => string,
  vault: Vault,
  spUrl: string,
  dataDir: string,
): Router {
  const router = Router();

  router.post('/encrypt-content', async (req, res) => {
    if (!secretMatches(req.header('X-Internal-Secret') ?? undefined, getSecret())) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const { toolArgs, recipientUserIds, readers } = (req.body ?? {}) as { toolArgs?: unknown; recipientUserIds?: unknown; readers?: unknown };
    if (typeof toolArgs !== 'object' || toolArgs === null || Array.isArray(toolArgs)) {
      res.status(400).json({ error: 'toolArgs must be an object' });
      return;
    }
    if (!Array.isArray(recipientUserIds) || !recipientUserIds.every((id) => typeof id === 'string')) {
      res.status(400).json({ error: 'recipientUserIds must be a string array' });
      return;
    }
    if (recipientUserIds.length > MAX_RECIPIENTS) {
      res.status(400).json({ error: `too many recipients (max ${MAX_RECIPIENTS})` });
      return;
    }
    // v0.8 only: the mandate's owner DID and signed deciders — readers by DID.
    let v08: V08Readers | undefined;
    if (readers !== undefined) {
      const r = readers as { ownerDid?: unknown; deciders?: unknown } | null;
      if (
        !r || typeof r.ownerDid !== 'string' || !r.ownerDid.startsWith('did:')
        || !Array.isArray(r.deciders) || !r.deciders.every((d) => typeof d === 'string' && d.startsWith('did:'))
        || r.deciders.length > MAX_RECIPIENTS
      ) {
        res.status(400).json({ error: 'readers must be { ownerDid: DID, deciders: DID[] }' });
        return;
      }
      v08 = { ownerDid: r.ownerDid, deciders: r.deciders as string[] };
    }
    const me = vault.getSessionUser();
    const cookie = vault.getSpCookie();
    if (!me || !cookie) {
      res.status(401).json({ error: 'no Authority Server session' });
      return;
    }
    try {
      const selfPublicKey = v08 ? (await getPublicKey(vault)) ?? undefined : undefined;
      const { content, unreadableFor } = await encryptProposalContent(
        toolArgs as Record<string, unknown>,
        recipientUserIds as string[],
        { spUrl, cookie, dataDir, selfUserId: me.id, ...(v08 ? { selfDid: me.did, selfPublicKey } : {}) },
        v08,
      );
      res.json({ content, unreadableFor });
    } catch (err) {
      console.error('[Control Plane] /internal/encrypt-content failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'encryption failed' });
    }
  });

  router.post('/decrypt-content', async (req, res) => {
    if (!secretMatches(req.header('X-Internal-Secret') ?? undefined, getSecret())) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const body = (req.body ?? {}) as {
      ciphertext?: unknown; keys?: unknown; encrypted_keys?: unknown; hash?: unknown; proposalContentHash?: unknown;
    };
    const { ciphertext, hash, proposalContentHash } = body;
    // Both names: under a 0.8 mandate `encrypted_keys` is keyed by DID and
    // `keys` by account id (the same CEK); under 0.7 they are the same wraps.
    const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
    const keys = isObj(body.encrypted_keys) || isObj(body.keys)
      ? { ...(isObj(body.keys) ? body.keys : {}), ...(isObj(body.encrypted_keys) ? body.encrypted_keys : {}) }
      : undefined;
    if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
      res.status(400).json({ error: 'ciphertext (base64 string) is required' });
      return;
    }
    if (typeof keys !== 'object' || keys === null) {
      res.status(400).json({ error: 'keys (object) is required' });
      return;
    }
    const me = vault.getSessionUser();
    if (!me) {
      res.status(401).json({ error: 'no Authority Server session' });
      return;
    }
    try {
      const kp = await loadOrGenerateKeyPair(vault);
      const plaintext = await decryptProposalContent(
        {
          ciphertext,
          keys: keys as Record<string, { ct: string; enc: string }>,
          // v0.8 rule 8: checked against the fingerprint before it is returned.
          ...(typeof hash === 'string' ? { hash } : {}),
          ...(typeof proposalContentHash === 'string' ? { proposalContentHash } : {}),
        },
        me.id,
        kp.privateKey,
        me.did,
      );
      res.json({ plaintext });
    } catch (err) {
      console.error('[Control Plane] /internal/decrypt-content failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'decryption failed' });
    }
  });

  return router;
}
