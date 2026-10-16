/**
 * /api/report-seen — the local "last seen Report at" display flag (reports mockup, 2026-10-16).
 *
 *   GET  /            → { lastSeenReportAt: number }
 *   POST /  { ts? }   → marks seen (now, or the given ts), returns the
 *                        persisted { lastSeenReportAt: number }
 *
 * Auth-guarded like the rest of /api. Every response is the persisted
 * value, never the request echoed back, so the UI renders backend truth.
 * See lib/report-seen-store.ts for what this flag does and doesn't do.
 */

import { Router } from 'express';
import { readLastSeenReportAt, markReportSeen } from '../lib/report-seen-store';

export function createReportSeenRouter(dataDir?: string): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ lastSeenReportAt: readLastSeenReportAt(dataDir) });
  });

  router.post('/', (req, res) => {
    const body = req.body as { ts?: unknown } | undefined;
    const ts = typeof body?.ts === 'number' && Number.isFinite(body.ts) ? body.ts : Date.now();
    try {
      res.json({ lastSeenReportAt: markReportSeen(ts, dataDir) });
    } catch (err) {
      res.status(500).json({ error: `Could not save: ${(err as Error).message}` });
    }
  });

  return router;
}
