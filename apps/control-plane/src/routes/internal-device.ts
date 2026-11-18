/**
 * What the MCP server asks the control plane about device keys (device-keys plan
 * section 7: "the mcp-server asks the control plane for chain state; it holds no
 * keys"; step 12 computer part). Authenticated by the shared internal secret, like
 * /internal/mandate; mounted only with SUVEREN_DEVICE_KEYS=on and device set-up.
 *
 *   GET  /internal/device-chain          { state: 'none' | 'present' | 'unreadable', rootDid? }
 *                                        does this gateway have a device chain, and whose
 *   POST /internal/device-pin/get        { did }        -> { head: { seq, hash } | null }
 *   POST /internal/device-pin/advance    { did, head }  -> { head } | 409 { code: 'rollback' | 'fork' }
 *
 * The control plane only remembers heads (lib/device-pin-store.ts). It checks nothing
 * about chains: the MCP server verifies them with hap-core before it asks to advance.
 */
import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { DeviceChainStore } from '../lib/device-chain-store';
import { DevicePinStore, PinRefusedError } from '../lib/device-pin-store';

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createInternalDeviceRouter(getSecret: () => string, store: DeviceChainStore, pins: DevicePinStore): Router {
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

  router.post('/device-pin/advance', guarded((req, res) => {
    const { did, head } = (req.body ?? {}) as { did?: unknown; head?: { seq?: unknown; hash?: unknown } };
    res.json({ head: pins.advance(did as string, head as { seq: number; hash: string }) });
  }));

  return router;
}
