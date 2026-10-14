/**
 * /api/blocked-seen — the local "last seen Blocked at" display flag.
 *
 *   GET  /            → { lastSeenBlockedAt: number }
 *   POST /  { ts? }   → marks seen (now, or the given ts), returns the
 *                        persisted { lastSeenBlockedAt: number }
 *
 * Auth-guarded like the rest of /api. Every response is the persisted
 * value, never the request echoed back, so the UI renders backend truth.
 * See lib/blocked-seen-store.ts for what this flag does and doesn't do.
 */

import { Router } from 'express';
import { readLastSeenBlockedAt, markBlockedSeen } from '../lib/blocked-seen-store';

export function createBlockedSeenRouter(dataDir?: string): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ lastSeenBlockedAt: readLastSeenBlockedAt(dataDir) });
  });

  router.post('/', (req, res) => {
    const body = req.body as { ts?: unknown } | undefined;
    const ts = typeof body?.ts === 'number' && Number.isFinite(body.ts) ? body.ts : Date.now();
    try {
      res.json({ lastSeenBlockedAt: markBlockedSeen(ts, dataDir) });
    } catch (err) {
      res.status(500).json({ error: `Could not save: ${(err as Error).message}` });
    }
  });

  return router;
}
