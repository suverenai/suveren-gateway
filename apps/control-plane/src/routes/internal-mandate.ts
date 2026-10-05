/**
 * POST /internal/mandate — the MCP server asking the control plane to check or
 * create a mandate for the signed-in person (simulation setup S8,
 * `setup__create_mandate`). Body: `{ dryRun: boolean, request: MandateRequest }`.
 *
 * - dryRun: validate only (rights, profile, limits, scope, mode, duration, intent)
 *   — the tool calls this BEFORE a proposal exists, so a person is never asked to
 *   approve a mandate that could not be created;
 * - otherwise: create it, exactly as the sign page does (lib/mandate-ceremony.ts).
 *   Only ever called by the MCP server's committed executor, i.e. after a person
 *   approved the proposal, under a ticket.
 *
 * Authenticated by the shared internal secret (like /internal/event); the session
 * used towards the Authority Server is the control plane's own — the person's.
 * Refusals come back as 422 { error, message } so the tool can show the reason.
 */
import { Router } from 'express';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { planMandate, createMandate, MandateRefused, type CeremonyDeps, type MandateRequest } from '../lib/mandate-ceremony';

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createInternalMandateRouter(
  getSecret: () => string,
  deps: () => Omit<CeremonyDeps, 'newAuthorizationId'>,
): Router {
  const router = Router();
  router.post('/mandate', async (req, res) => {
    if (!secretMatches(req.header('X-Internal-Secret') ?? undefined, getSecret())) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const { dryRun, request } = (req.body ?? {}) as { dryRun?: unknown; request?: MandateRequest };
    if (!request || typeof request !== 'object') {
      res.status(400).json({ error: 'missing request' });
      return;
    }
    const d: CeremonyDeps = { ...deps(), newAuthorizationId: () => `authz_${randomUUID()}` };
    try {
      if (dryRun === true) {
        const plan = await planMandate(request, d);
        res.json({ ok: true, groupName: plan.groupName, profileId: plan.profile.id, mode: plan.mode, ttlSeconds: plan.ttlSeconds });
        return;
      }
      const { authorizationId, plan } = await createMandate(request, d);
      res.json({ ok: true, authorizationId, profileId: plan.profile.id, groupName: plan.groupName, mode: plan.mode, ttlSeconds: plan.ttlSeconds });
    } catch (err) {
      if (err instanceof MandateRefused) {
        res.status(422).json({ error: 'mandate_refused', message: err.message });
        return;
      }
      console.error('[Control Plane] /internal/mandate failed:', err);
      res.status(500).json({ error: 'internal', message: err instanceof Error ? err.message : String(err) });
    }
  });
  return router;
}
