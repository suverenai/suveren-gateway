/**
 * Pairing with the phone app, on this computer's page (device-keys plan 4.3, step 11 gateway part). API only. Mounted at /auth,
 * behind SUVEREN_DEVICE_KEYS=on, on a vault that has an unlock password:
 *
 *   GET  /auth/device/devices                 the devices of this account, from the chain this computer verified
 *   GET  /auth/device/pairing/status          the pairing in progress (the mailbox is looked at once) or { flow: 'none' }
 *   GET  /auth/device/pairing/app-origin      where the phone app is opened, as the Authority Server says it: { ok, appOrigin? } (absent when it names none)
 *   POST /auth/device/pairing/admit/start     "Add a phone": the QR of an admitter (shown_by: admitter)
 *   POST /auth/device/pairing/admit/choose    { code } the tapped comparison code; the touch; the append
 *   POST /auth/device/pairing/join/start      "Add this computer": the QR of a joiner (shown_by: joiner)
 *   POST /auth/device/pairing/join/confirm    { label } the person read who this computer joins and named it
 *   POST /auth/device/pairing/cancel          stop and forget
 *
 * Every route sits behind the page session (cookie AND header token, Origin and Host), checked by the router itself. Every code
 * is neutral; the words the person reads are the page's texts module. An answer is never cached.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Vault } from '../lib/vault';
import { pageSessionVerdict, type PageSessionDeps } from '../middleware/auth';
import { DevicePairing, PairingRefusal } from '../lib/device-pairing';

function fail(res: Response, status: number, code: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error: code, code, message: code, ...extra });
}

export interface DevicePairingRouterDeps {
  vault: Vault;
  pageSession: PageSessionDeps;
  pairing: DevicePairing;
}

export function createDevicePairingRouter(deps: DevicePairingRouterDeps): Router {
  const { vault, pageSession, pairing } = deps;
  const router = Router();
  const api = Router();

  /** The page session, every time, for every handler below. A path cannot reach a handler without it. */
  api.use((req: Request, res: Response, next: NextFunction): void => {
    const v = pageSessionVerdict(vault, pageSession, req);
    if (!v.ok) { fail(res, v.status, v.code === 'origin_refused' || v.code === 'not_local' ? v.code : 'unauthorized', { reason: v.code }); return; }
    if (!vault.hasPassword()) { fail(res, 409, 'password_required'); return; }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const run = (handler: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof PairingRefusal) { fail(res, err.status, err.code, err.extra); return; }
      console.error('[Control Plane] Device pairing error:', err instanceof Error ? err.name : 'error');
      fail(res, 500, 'bad_request');
    }
  };
  const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {});

  api.get('/devices', run(async (_req, res) => { res.json({ ok: true, ...(await pairing.devices()) }); }));
  api.get('/pairing/status', run(async (_req, res) => { res.json({ ok: true, view: await pairing.status() }); }));
  api.get('/pairing/app-origin', run(async (_req, res) => { const appOrigin = await pairing.appOrigin(); res.json({ ok: true, ...(appOrigin ? { appOrigin } : {}) }); }));
  api.post('/pairing/admit/start', run(async (_req, res) => { res.json({ ok: true, view: await pairing.admitStart() }); }));
  api.post('/pairing/admit/choose', run(async (req, res) => { res.json({ ok: true, view: await pairing.admitChoose(body(req).code) }); }));
  api.post('/pairing/join/start', run(async (_req, res) => { res.json({ ok: true, view: await pairing.joinStart() }); }));
  api.post('/pairing/join/confirm', run(async (req, res) => { res.json({ ok: true, view: await pairing.joinConfirm(body(req).label) }); }));
  api.post('/pairing/cancel', run(async (_req, res) => { res.json({ ok: true, view: await pairing.cancel() }); }));

  router.use('/device', api);
  return router;
}
