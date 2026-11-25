/**
 * GET /api/replaced-mandates — mandates the person replaced whose revoke at the
 * Authority Server has not gone through yet. They are no longer honoured on
 * this gateway; the Mandates list shows a quiet line on each until the retry
 * loop (lib/replaced-revoke-retry.ts) has ended it there. There is deliberately
 * no "revoke now" action (maintainer, 2026-11-20): the gateway ends it by itself.
 */
import { Router } from 'express';
import type { ReplacedMandateEntry } from '../lib/mcp-bridge';

export function createReplacedMandatesRouter(list: () => Promise<ReplacedMandateEntry[]>): Router {
  const router = Router();
  router.get('/', async (_req, res) => {
    try {
      const entries = await list();
      // The page needs only which mandate and by what — no error text.
      res.json({ entries: entries.map((e) => ({ authorizationId: e.authorizationId, replacedBy: e.replacedBy, since: e.since })) });
    } catch (err) {
      res.status(502).json({ error: 'mcp_unreachable', message: err instanceof Error ? err.message : String(err) });
    }
  });
  return router;
}
