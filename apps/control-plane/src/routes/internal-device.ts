/**
 * What the MCP server asks the control plane about device keys (device-keys plan
 * section 7: "the mcp-server asks the control plane for chain state; it holds no
 * keys"; step 12 computer part). Authenticated by the shared internal secret, like
 * /internal/mandate; mounted only with SUVEREN_DEVICE_KEYS=on and device set-up.
 *
 *   GET  /internal/device-chain          { state: 'none' | 'present' | 'unreadable', rootDid? }
 *                                        does this gateway have a device chain, and whose
 *   POST /internal/device-pin/get        { did }        -> { head: { seq, hash } | null }
 *   POST /internal/device-pin/advance    { did, head, keep? } -> { head } | 409 { code: 'rollback' | 'fork' | 'own_chain' | 'full' }
 *                                        never moves THIS computer's own head (only sign-in does)
 *   POST /internal/device-ledger/consume { proposalId, nonces } -> 409 { code: 'proposal_id_reused' | 'nonce_reused' }
 *
 * The control plane only remembers heads (lib/device-pin-store.ts). It checks nothing
 * about chains: the MCP server verifies them with hap-core before it asks to advance.
 */
import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { DeviceChainStore } from '../lib/device-chain-store';
import { DevicePinStore, PinRefusedError } from '../lib/device-pin-store';
import { MandateGrantStore, GrantStoreRefused } from '../lib/mandate-grant-store';
import type { MandateGrants } from '../lib/mandate-grants';

/**
 * Codes that mean "could not ask / could not be checked now" (the Authority Server unreachable or its pin not matching, this gateway locked or
 * not signed in, an answer that makes no sense). The MCP server must keep what it honoured through these: they are answered 502 with NO code,
 * like a failure. Everything else a refusal carries (chain_fork, grant_invalid, owner_unknown, ...) stays a 4xx with its code.
 */
const TRANSIENT_CODES = new Set(['as_unreachable', 'as_tls_mismatch', 'not_signed_in', 'locked', 'as_answer_invalid', 'chain_unreadable', 'not_set_up', 'head_mismatch']);
export const isTransientGrantCode = (code: string): boolean => TRANSIENT_CODES.has(code);

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createInternalDeviceRouter(getSecret: () => string, store: DeviceChainStore, pins: DevicePinStore, mandates?: { store: MandateGrantStore; grants: MandateGrants }): Router {
  const router = Router();
  const guarded = (handler: (req: Request, res: Response) => void) => (req: Request, res: Response): void => {
    if (!secretMatches(req.header('X-Internal-Secret') ?? undefined, getSecret())) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    try {
      handler(req, res);
    } catch (err) {
      if (err instanceof PinRefusedError) {
        res.status(err.reason === 'bad_request' ? 400 : 409).json({ error: 'pin_refused', code: err.reason });
        return;
      }
      // A locked vault, or a slot that cannot be read: said, never guessed.
      res.status(423).json({ error: 'unavailable', code: 'unavailable' });
    }
  };

  router.get('/device-chain', guarded((_req, res) => {
    const state = store.state();
    if (state === 'present') {
      // A locked vault still says "present" (never "none"); the DID is only given while it can be read.
      let rootDid: string | undefined;
      try { rootDid = store.read()?.rootDid; } catch { rootDid = undefined; }
      res.json({ state, ...(rootDid ? { rootDid } : {}) });
      return;
    }
    res.json({ state });
  }));

  router.post('/device-pin/get', guarded((req, res) => {
    const { did } = (req.body ?? {}) as { did?: unknown };
    res.json({ head: pins.get(did as string) });
  }));

  // The control plane fetches and verifies the chain ITSELF before it moves a pin (and decides which pins to protect): what the MCP
  // server verified is not taken on its word, and a caller cannot name a head. (Without mandate support nothing can verify: refused.)
  router.post('/device-pin/advance', async (req: Request, res: Response) => {
    if (!secretMatches(req.header('X-Internal-Secret') ?? undefined, getSecret())) { res.status(401).json({ error: 'unauthorized' }); return; }
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!mandates) { res.status(423).json({ error: 'unavailable', code: 'unavailable' }); return; }
      const head = await mandates.grants.pinChain((req.body as { did?: unknown } | undefined)?.did as string);
      res.json({ head });
    } catch (err) {
      if (err instanceof PinRefusedError) { res.status(err.reason === 'bad_request' ? 400 : 409).json({ error: 'pin_refused', code: err.reason }); return; }
      if ((err as { name?: string })?.name === 'GrantRefusal') { const code = (err as { code: string }).code; if (isTransientGrantCode(code)) { res.status(502).json({ error: 'unavailable' }); return; } res.status(403).json({ error: 'pin_refused', code }); return; }
      res.status(423).json({ error: 'unavailable', code: 'unavailable' });
    }
  });

  // The proposal is about to run on these decisions: a reused proposal id or nonce is refused.
  router.post('/device-ledger/consume', guarded((req, res) => {
    const { proposalId, nonces } = (req.body ?? {}) as { proposalId?: unknown; nonces?: unknown };
    pins.consume(proposalId as string, Array.isArray(nonces) ? (nonces as string[]) : []);
    res.json({ ok: true });
  }));

  // Mandate grants (plan 4.4, step 13). The MCP server verifies a grant with hap-core against the chain it pinned and
  // asks here to REMEMBER it (the highest version per mandate, a revocation) and to answer it with this computer's receipt.
  // This router decides nothing about the grant: it refuses a lower version and holds the signing key.
  if (mandates) {
    router.get('/mandate-grant/chain-seen', guarded((_req, res) => { res.json({ seen: mandates.store.chainSeen() }); }));
    // Only a gateway that has a chain sets it (turning device keys off clears it through the page session, never from here).
    router.post('/mandate-grant/chain-seen', guarded((_req, res) => {
      if (!store.exists()) { res.status(409).json({ error: 'not_set_up', code: 'not_set_up' }); return; }
      mandates.store.markChainSeen();
      res.json({ ok: true });
    }));

    router.post('/mandate-grant/owner-known', guarded((req, res) => {
      const { did } = (req.body ?? {}) as { did?: unknown };
      res.json({ known: mandates.grants.ownerKnown(did as string) });
    }));

    // Remembered only after THIS control plane verified the grant itself (hap-core, the owner's chain): the MCP server cannot make it
    // record a version, a hash or a revocation it did not see verify.
    router.post('/mandate-grant/observe', async (req: Request, res: Response) => {
      if (!secretMatches(req.header('X-Internal-Secret') ?? undefined, getSecret())) { res.status(401).json({ error: 'unauthorized' }); return; }
      res.setHeader('Cache-Control', 'no-store');
      const { mandateId, version, grantHash, op } = (req.body ?? {}) as { mandateId?: unknown; version?: unknown; grantHash?: unknown; op?: unknown };
      try {
        if (op !== 'grant' && op !== 'change' && op !== 'revoke') { res.status(400).json({ error: 'grant_refused', code: 'bad_request' }); return; }
        await mandates.grants.verifyHeld({ mandateId: mandateId as string, version: version as number, grantHash: grantHash as string, op });
        const out = mandates.store.observe(mandateId as string, version as number, grantHash as string, op);
        res.json({ ok: true, receiptNeeded: out.receiptNeeded });
      } catch (err) {
        if (err instanceof GrantStoreRefused) { res.status(err.reason === 'bad_request' ? 400 : 409).json({ error: 'grant_refused', code: err.reason }); return; }
        if ((err as { name?: string })?.name === 'GrantRefusal') { const code = (err as { code: string }).code; if (isTransientGrantCode(code)) { res.status(502).json({ error: 'unavailable' }); return; } res.status(code === 'bad_request' ? 400 : 403).json({ error: 'grant_refused', code }); return; }
        res.status(423).json({ error: 'unavailable', code: 'unavailable' });
      }
    });

    router.post('/mandate-grant/receipt', async (req: Request, res: Response) => {
      if (!secretMatches(req.header('X-Internal-Secret') ?? undefined, getSecret())) { res.status(401).json({ error: 'unauthorized' }); return; }
      res.setHeader('Cache-Control', 'no-store');
      const { mandateId, version, grantHash } = (req.body ?? {}) as { mandateId?: unknown; version?: unknown; grantHash?: unknown };
      try {
        const out = await mandates.grants.receipt({ mandateId: mandateId as string, version: version as number, grantHash: grantHash as string });
        res.json({ ok: true, sent: out.sent });
      } catch (err) {
        if ((err as { name?: string })?.name === 'GrantRefusal') { const code = (err as { code: string }).code; res.status(code === 'bad_request' ? 400 : 502).json(code === 'bad_request' ? { error: 'receipt_refused', code } : { error: 'receipt_refused' }); return; }
        res.status(423).json({ error: 'unavailable', code: 'unavailable' });
      }
    });
  }

  return router;
}
