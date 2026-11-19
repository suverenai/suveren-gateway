/**
 * POST /api/mandate/sign, /api/mandate/renew — the web page's mandate signing.
 * The page no longer hashes or signs: it sends the values and the control plane
 * runs the same steps the AI path runs (lib/mandate-ceremony.ts), under the
 * person's own session. A refusal answers 422 { error, message, code? }.
 */
import { Router, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { createMandate, renewMandate, MandateRefused, type CeremonyDeps, type MandateRequest, type RenewRequest } from '../lib/mandate-ceremony';
import { GrantRefusal } from '../lib/mandate-grants';

function answerRefusal(res: Response, err: unknown): void {
  if (err instanceof MandateRefused) {
    res.status(422).json({ error: 'mandate_refused', message: err.message, ...(err.code ? { code: err.code } : {}), ...(err.detail ?? {}) });
    return;
  }
  if (err instanceof GrantRefusal) {
    res.status(422).json({ error: 'mandate_refused', message: err.message, code: 'grant_refused', grantCode: err.code, ...err.extra });
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
      const { authorizationId, revokeError } = await createMandate(request, d);
      res.json({ ok: true, authorizationId, ...(revokeError ? { revokeError } : {}) });
    } catch (err) { answerRefusal(res, err); }
  });
  // End a mandate on a gateway with a device chain: signed by this computer's device key, final (plan 4.4).
  // Anything else (no chain) is not served here: the page revokes through the Authority Server as before.
  router.post('/revoke', async (req, res) => {
    try {
      const d = deps();
      const authorizationId = (req.body as { authorizationId?: unknown } | undefined)?.authorizationId;
      if (!d.grants?.active()) { res.status(409).json({ error: 'not_set_up', message: 'Device keys are not set up.', code: 'not_set_up' }); return; }
      if (typeof authorizationId !== 'string' || !/^authz_[0-9a-f-]{36}$/.test(authorizationId)) { res.status(400).json({ error: 'bad_request', code: 'bad_request', message: 'Bad request.' }); return; }
      const r = await d.grants.revoke(authorizationId);
      void d.resyncGates?.().catch(() => {});
      res.json({ ok: true, mandateId: r.mandateId, version: r.version });
    } catch (err) { answerRefusal(res, err); }
  });
  // The person compared another person's identity code (their own screen against this one): that DID is then one this gateway
  // honours mandates of, and names as an approver. Page session only (this router sits behind it); never the AI path.
  router.post('/confirm-identity', async (req, res) => {
    try {
      const d = deps();
      if (!d.grants?.active()) { res.status(409).json({ error: 'not_set_up', message: 'Device keys are not set up.', code: 'not_set_up' }); return; }
      const b = (req.body ?? {}) as { did?: unknown; code?: unknown };
      await d.grants.confirmIdentity(b.did, b.code);
      res.json({ ok: true });
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
