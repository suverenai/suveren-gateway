/**
 * POST /device-decision/:proposalId/:route — a decision made on the gateway page of a
 * gateway that has a device chain, signed with this computer's device key
 * (device-keys plan 6.3, step 12 computer part). `route` is `approve`, `reject`,
 * `resolve` or `withdraw`: the same four routes the Authority Server has, with the
 * same body the page already sends. GET /device-decision/status tells the page which
 * path to use.
 *
 * Behind the page session (cookie AND header token, Origin and Host), checked by the
 * router itself: a path that reaches a handler has passed it, however it was written.
 * The body is only what the person chose (domain, outcome, a sealed note, the shown
 * fingerprint); what is SIGNED comes from lib/device-decision.ts, never from here.
 * Mounted only with SUVEREN_DEVICE_KEYS=on and device set-up.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Vault } from '../lib/vault';
import { pageSessionVerdict, type PageSessionDeps } from '../middleware/auth';
import { DeviceDecisions, DecisionRefusal, DECISION_ROUTES, type DecisionRoute } from '../lib/device-decision';
import type { DeviceChainStore } from '../lib/device-chain-store';

/** Placeholder messages, by code. Wording is the maintainer's (O19). */
export const DECISION_MESSAGES: Record<string, string> = {
  unauthorized: 'Unauthorized.',
  origin_refused: 'Request refused.',
  not_local: 'Device keys need the gateway to listen on this computer only.',
  bad_request: 'Bad request.',
  locked: 'The gateway is locked.',
  not_set_up: 'Device keys are not set up.',
  chain_unreadable: 'The stored device chain cannot be read.',
  not_signed_in: 'This computer is not signed in to the Authority Server.',
  key_missing: 'This computer has no device key.',
  key_mismatch: 'This computer\'s key does not match the stored chain.',
  proposal_unknown: 'No such proposal.',
  proposal_not_pending: 'This proposal is not waiting for a decision.',
  content_mismatch: 'The content does not match its fingerprint.',
  content_not_shown: 'A decision must carry the fingerprint of the content that was shown.',
  content_unreadable: 'This computer cannot show the content, so it cannot approve it.',
  facts_unavailable: 'The gateway could not tell which mandate and action type this decision names.',
  as_unreachable: 'The Authority Server could not be reached.',
  as_tls_mismatch: 'The Authority Server connection did not match its pin.',
  as_answer_invalid: 'The Authority Server answered with something unexpected.',
};

function fail(res: Response, status: number, code: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error: code, code, message: DECISION_MESSAGES[code] ?? code, ...extra });
}

export interface DeviceDecisionRouterDeps {
  vault: Vault;
  pageSession: PageSessionDeps;
  store: DeviceChainStore;
  decisions: DeviceDecisions;
}

export function createDeviceDecisionRouter(deps: DeviceDecisionRouterDeps): Router {
  const { vault, pageSession, store, decisions } = deps;
  const router = Router();

  router.use((req: Request, res: Response, next: NextFunction): void => {
    const v = pageSessionVerdict(vault, pageSession, req);
    if (!v.ok) { fail(res, v.status, v.code === 'origin_refused' || v.code === 'not_local' ? v.code : 'unauthorized', { reason: v.code }); return; }
    if (!vault.hasPassword()) { fail(res, 409, 'not_set_up'); return; }
    next();
  });

  // Is a device chain set up here? The page asks before it decides; it never decides this itself.
  router.get('/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, deviceKeys: store.exists() });
  });

  router.post('/:id/:route', async (req: Request, res: Response) => {
    const route = req.params.route as DecisionRoute;
    if (!DECISION_ROUTES.includes(route)) { fail(res, 404, 'bad_request'); return; }
    res.setHeader('Cache-Control', 'no-store');
    try {
      const out = await decisions.decide(req.params.id, route, req.body);
      res.status(out.status).json(out.body ?? {});
    } catch (err) {
      if (err instanceof DecisionRefusal) { fail(res, err.status, err.code, err.extra); return; }
      console.error('[Control Plane] Device decision error:', err instanceof Error ? err.name : 'error');
      fail(res, 500, 'bad_request');
    }
  });

  return router;
}
