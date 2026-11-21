/**
 * Approving a dashboard passkey on this computer's page (plan 6.4 point 3; AS step 17, the device side). API only. Mounted at /auth,
 * behind SUVEREN_DEVICE_KEYS=on, on a vault that has an unlock password:
 *
 *   GET  /auth/device/dashboard-passkeys                    the passkeys that wait for one of this person's devices, and whether
 *                                                           this computer can approve (a check key its chain names)
 *   POST /auth/device/dashboard-passkeys/:requestId/approve this computer's key and its check (one touch) approve that request
 *
 * Every route sits behind the page session (cookie AND header token, Origin and Host), checked by the router itself. Codes are
 * neutral; the words the person reads are the page's texts. An answer is never cached.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Vault } from '../lib/vault';
import { pageSessionVerdict, type PageSessionDeps } from '../middleware/auth';
import { DashboardPasskeys, PasskeyApprovalRefusal } from '../lib/dashboard-passkeys';
import { eventBus } from '../lib/event-bus';

function fail(res: Response, status: number, code: string): void {
  res.status(status).json({ error: code, code, message: code });
}

export interface DashboardPasskeyRouterDeps {
  vault: Vault;
  pageSession: PageSessionDeps;
  passkeys: DashboardPasskeys;
}

export function createDashboardPasskeyRouter(deps: DashboardPasskeyRouterDeps): Router {
  const { vault, pageSession, passkeys } = deps;
  const router = Router();
  const api = Router();
  api.use((req: Request, res: Response, next: NextFunction): void => {
    const v = pageSessionVerdict(vault, pageSession, req);
    if (!v.ok) { fail(res, v.status, v.code === 'origin_refused' || v.code === 'not_local' ? v.code : 'unauthorized'); return; }
    if (!vault.hasPassword()) { fail(res, 409, 'password_required'); return; }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const run = (handler: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof PasskeyApprovalRefusal) { fail(res, err.status, err.code); return; }
      console.error('[Control Plane] Dashboard passkey error:', err instanceof Error ? err.name : 'error');
      fail(res, 500, 'bad_request');
    }
  };
  api.get('/dashboard-passkeys', run(async (_req, res) => {
    const { pending, canApprove } = await passkeys.pending();
    res.json({ ok: true, canApprove, pending });
  }));
  api.post('/dashboard-passkeys/:requestId/approve', run(async (req, res) => {
    const out = await passkeys.approve(req.params.requestId, { onTouched: () => eventBus.emit('give-progress', { stage: 'touched' }) });
    res.json({ ok: true, ...out });
  }));
  router.use('/device', api);
  return router;
}
