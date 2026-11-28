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
 *   POST /internal/mandate-grant/body    { mandateId, version, grantHash } -> { scope, intent } | 404/422 { code } (plan 20.19)
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

export function createInternalDeviceRouter(getSecret: () => string, store: DeviceChainStore, pins: DevicePinStore, mandates?: { store: MandateGrantStore; grants: MandateGrants; account?: () => { signedIn: boolean; did: string | null } }, hasPassword?: () => boolean): Router {
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

  // Whether this gateway has an unlock password (readable while locked): the locked notice the AI gets names password or Touch ID only then.
  router.get('/unlock-password', guarded((_req, res) => { res.json({ hasPassword: hasPassword?.() === true }); }));

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
    // The DID of the account this gateway is signed in as (the session answer of the Authority Server at sign-in), for the one question
    // "does the Authority Server know a chain for this account?". `signedIn: false` when no session is held (locked, signed out): the caller
    // then asks about the owners the mandates name instead. `did: null`: signed in,
    // and the Authority Server named no DID for the account: it has no chain for it.
    router.get('/mandate-grant/account-did', guarded((_req, res) => {
      const a = mandates.account?.();
      if (!a || !a.signedIn) { res.json({ signedIn: false }); return; }
      res.json({ did: a.did });
    }));
    router.get('/mandate-grant/chain-seen', guarded((_req, res) => { res.json({ seen: mandates.store.chainSeen() }); }));
    // Only a gateway that has a chain sets it (turning device keys off clears it through the page session, never from here).
    router.post('/mandate-grant/chain-seen', guarded((_req, res) => {
      if (!store.exists()) { res.status(409).json({ error: 'not_set_up', code: 'not_set_up' }); return; }
      mandates.store.markChainSeen();
      res.json({ ok: true });
    }));

    // Who counts as a colleague: this person, or a member of the team's verified member list (DEC-73). The list is brought up to date here
    // when it is older than 5 minutes; a list that cannot be checked answers `known: false` (nothing honoured), never an error.
    router.post('/mandate-grant/owner-known', async (req: Request, res: Response) => {
      if (!secretMatches(req.header('X-Internal-Secret') ?? undefined, getSecret())) { res.status(401).json({ error: 'unauthorized' }); return; }
      res.setHeader('Cache-Control', 'no-store');
      const { did } = (req.body ?? {}) as { did?: unknown };
      try {
        res.json({ known: await mandates.grants.ownerKnownFresh(did as string) });
      } catch { res.status(423).json({ error: 'unavailable', code: 'unavailable' }); }
    });

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

    // The sealed body of a verified grant, opened with THIS computer's key (plan 20.19). The grant is verified here again; the MCP server
    // compares what comes back with the hashes of the mandate before it uses any of it. Not a log line, not an error text carries a body.
    router.post('/mandate-grant/body', async (req: Request, res: Response) => {
      if (!secretMatches(req.header('X-Internal-Secret') ?? undefined, getSecret())) { res.status(401).json({ error: 'unauthorized' }); return; }
      res.setHeader('Cache-Control', 'no-store');
      const { mandateId, version, grantHash } = (req.body ?? {}) as { mandateId?: unknown; version?: unknown; grantHash?: unknown };
      try {
        const body = await mandates.grants.openBody({ mandateId: mandateId as string, version: version as number, grantHash: grantHash as string });
        res.json({ ok: true, ...body });
      } catch (err) {
        if ((err as { name?: string })?.name === 'GrantRefusal') {
          const code = (err as { code: string }).code;
          // like the other routes: could not ask / check now -> 502 with NO code; a real refusal -> 4xx with its code
          if (isTransientGrantCode(code)) { res.status(502).json({ error: 'unavailable' }); return; }
          res.status(code === 'bad_request' ? 400 : code === 'body_not_received' ? 404 : 422).json({ error: 'body_refused', code });
          return;
        }
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
