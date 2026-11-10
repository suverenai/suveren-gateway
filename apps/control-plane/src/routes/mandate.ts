/**
 * POST /api/mandate/sign, /api/mandate/renew — the web page's mandate signing.
 * The page no longer hashes or signs: it sends the values and the control plane
 * runs the same steps the AI path runs (lib/mandate-ceremony.ts), under the
 * person's own session. A refusal answers 422 { error, message, code? }.
 */
import { Router, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { createMandate, renewMandate, MandateRefused, type CeremonyDeps, type MandateRequest, type RenewRequest } from '../lib/mandate-ceremony';

function answerRefusal(res: Response, err: unknown): void {
  if (err instanceof MandateRefused) {
    res.status(422).json({ error: 'mandate_refused', message: err.message, ...(err.code ? { code: err.code } : {}) });
    return;
  }
  console.error('[Control Plane] /api/mandate failed:', err);
  res.status(500).json({ error: 'internal', message: err instanceof Error ? err.message : String(err) });
}

export function createMandateRouter(deps: () => Omit<CeremonyDeps, 'newAuthorizationId'>): Router {
  const router = Router();
  router.post('/sign', async (req, res) => {
    const request = (req.body ?? {}) as MandateRequest;
    try {
      const d: CeremonyDeps = { ...deps(), newAuthorizationId: () => `authz_${randomUUID()}` };
      const { authorizationId } = await createMandate(request, d);
      res.json({ ok: true, authorizationId });
    } catch (err) { answerRefusal(res, err); }
  });
  router.post('/renew', async (req, res) => {
    const request = (req.body ?? {}) as RenewRequest;
    try {
      const d: CeremonyDeps = { ...deps(), newAuthorizationId: () => request.authorizationId };
      res.json({ ok: true, ...(await renewMandate(request, d)) });
    } catch (err) { answerRefusal(res, err); }
  });
  return router;
}
