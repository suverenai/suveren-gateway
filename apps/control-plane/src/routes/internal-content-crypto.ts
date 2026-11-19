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
import { encryptProposalContent, decryptProposalContent, decryptProposalContext, type V08Readers } from '../lib/content-crypto';
import type { CardContext } from '../lib/content-wraps';
import { loadOrGenerateKeyPair, getPublicKey } from '../lib/e2e-key-manager';
import type { Vault } from '../lib/vault';
import type { DeviceReaders } from '../lib/device-readers';
import type { ProposalRewrap } from '../lib/proposal-rewrap';
import type { DeviceChainStore } from '../lib/device-chain-store';

/** Device keys, step 8: present only on a gateway that set up a device chain. */
export interface DeviceContentDeps {
  readers: DeviceReaders;
  rewrap: ProposalRewrap;
  store: DeviceChainStore;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The card context the MCP server hands over: the gateway's own four members, nothing else (plan 5). */
function cardContextOf(v: unknown): CardContext | null {
  if (!isObj(v) || typeof v.gateway_version !== 'string' || !('display' in v) || !('execution_mapping' in v) || !('linked_record' in v)) return null;
  return { display: v.display, execution_mapping: v.execution_mapping, linked_record: v.linked_record, gateway_version: v.gateway_version };
}

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
  device?: DeviceContentDeps,
): Router {
  const router = Router();

  router.post('/encrypt-content', async (req, res) => {
    if (!secretMatches(req.header('X-Internal-Secret') ?? undefined, getSecret())) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const { toolArgs, recipientUserIds, readers, context } = (req.body ?? {}) as { toolArgs?: unknown; recipientUserIds?: unknown; readers?: unknown; context?: unknown };
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
    let cardContext: CardContext | undefined;
    if (context !== undefined) {
      const c = cardContextOf(context);
      if (!c) { res.status(400).json({ error: 'context must be { display, execution_mapping, linked_record, gateway_version }' }); return; }
      cardContext = c;
    }
    const me = vault.getSessionUser();
    const cookie = vault.getSpCookie();
    if (!me || !cookie) {
      res.status(401).json({ error: 'no Authority Server session' });
      return;
    }
    try {
      const selfPublicKey = v08 ? (await getPublicKey(vault)) ?? undefined : undefined;
      // Device keys: a gateway with a chain encrypts to every device of every reader (lib/content-crypto.ts encryptToDevices).
      const selfPrivateKey = v08 && device?.readers.active() ? (await loadOrGenerateKeyPair(vault)).privateKey : undefined;
      const { content, unreadableFor, unreadableReaders } = await encryptProposalContent(
        toolArgs as Record<string, unknown>,
        recipientUserIds as string[],
        {
          spUrl, cookie, dataDir, selfUserId: me.id, ...(v08 ? { selfDid: me.did, selfPublicKey } : {}),
          ...(device && selfPrivateKey ? { device: { readers: device.readers, selfPrivateKey } } : {}),
        },
        v08,
        cardContext,
      );
      res.json({ content, unreadableFor, ...(unreadableReaders ? { unreadableReaders } : {}) });
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
      ciphertext?: unknown; keys?: unknown; encrypted_keys?: unknown; device_keys?: unknown; context?: unknown; hash?: unknown; proposalContentHash?: unknown;
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
      let myKeyId: string | undefined;
      try { myKeyId = device?.store.read()?.keyId; } catch { /* an unreadable slot: the legacy wrap is tried */ }
      const wire = {
        ciphertext,
        keys: keys as Record<string, { ct: string; enc: string }>,
        ...(isObj(body.device_keys) ? { device_keys: body.device_keys as Record<string, { ct: string; enc: string }> } : {}),
        ...(typeof body.context === 'string' ? { context: body.context } : {}),
        // v0.8 rule 8: checked against the fingerprint before it is returned.
        ...(typeof hash === 'string' ? { hash } : {}),
        ...(typeof proposalContentHash === 'string' ? { proposalContentHash } : {}),
      };
      const plaintext = await decryptProposalContent(wire, me.id, kp.privateKey, me.did, myKeyId);
      // The card context is checked on open, bound to this proposal; its failure never hides the arguments.
      const ctx = await decryptProposalContext(wire, me.id, kp.privateKey, me.did, myKeyId);
      res.json({ plaintext, ...(ctx ? ctx : {}) });
    } catch (err) {
      console.error('[Control Plane] /internal/decrypt-content failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'decryption failed' });
    }
  });

  // Device keys, step 8: wrap the open proposals' content keys for this person's other devices (lib/proposal-rewrap.ts).
  router.post('/rewrap-proposals', async (req, res) => {
    if (!secretMatches(req.header('X-Internal-Secret') ?? undefined, getSecret())) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!device) { res.status(404).json({ error: 'not found' }); return; }
    try {
      res.json(await device.rewrap.run());
    } catch {
      res.status(500).json({ error: 'rewrap failed' });
    }
  });

  return router;
}
