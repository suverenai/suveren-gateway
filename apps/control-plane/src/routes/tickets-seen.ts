/**
 * /api/tickets-seen — the local "last seen Tickets at" display flag (UI spec §12.3).
 *
 *   GET  /            → { lastSeenTicketsAt: number }
 *   POST /  { ts? }   → marks seen (now, or the given ts), returns the
 *                        persisted { lastSeenTicketsAt: number }
 *
 * Auth-guarded like the rest of /api. Every response is the persisted
 * value, never the request echoed back, so the UI renders backend truth.
 * See lib/tickets-seen-store.ts for what this flag does and doesn't do.
 */

import { Router } from 'express';
import { readLastSeenTicketsAt, markTicketsSeen } from '../lib/tickets-seen-store';

export function createTicketsSeenRouter(dataDir?: string): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ lastSeenTicketsAt: readLastSeenTicketsAt(dataDir) });
  });

  router.post('/', (req, res) => {
    const body = req.body as { ts?: unknown } | undefined;
    const ts = typeof body?.ts === 'number' && Number.isFinite(body.ts) ? body.ts : Date.now();
    try {
      res.json({ lastSeenTicketsAt: markTicketsSeen(ts, dataDir) });
    } catch (err) {
      res.status(500).json({ error: `Could not save: ${(err as Error).message}` });
    }
  });

  return router;
}
