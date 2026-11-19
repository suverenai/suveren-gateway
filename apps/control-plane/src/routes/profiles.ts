/**
 * GET /api/profiles, GET /api/profiles/:id — the profile catalog the UI reads,
 * answered from THIS gateway's own profiles (the ones it enforces), never
 * forwarded to the Authority Server. Mounted before the AS proxy, so the proxy
 * never sees these two reads. Anything else under /api/profiles (e.g. a POST
 * that publishes a community profile) falls through to the proxy untouched.
 *
 * An id the gateway does not ship answers 404 with a plain reason and is NOT
 * fetched from the Authority Server: the screen shows it as unavailable.
 */
import { Router } from 'express';

export interface LocalProfileReads {
  list: () => Promise<{ profiles: Array<{ id: string }> }>;
  get: (id: string) => Promise<{ status: number; body: unknown }>;
}

export function createProfilesRouter(reads: LocalProfileReads): Router {
  const router = Router();
  router.get('/', async (_req, res) => {
    try {
      res.json(await reads.list());
    } catch (err) {
      res.status(502).json({ error: 'profiles_unavailable', message: err instanceof Error ? err.message : String(err) });
    }
  });
  router.get('/:id', async (req, res) => {
    try {
      const { status, body } = await reads.get(req.params.id);
      res.status(status).json(body);
    } catch (err) {
      res.status(502).json({ error: 'profiles_unavailable', message: err instanceof Error ? err.message : String(err) });
    }
  });
  return router;
}
