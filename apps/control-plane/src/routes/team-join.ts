/**
 * /api/team-join — the join screens' routes (DEC-73, design 20.21.5, build step 4). Mounted behind the page session and the
 * auth guard, like /api/mandate, and only on a gateway with a device chain. All logic is in lib/team-join.ts: nothing the page
 * sends is signed or counts as a match by itself; the page sends a typed code and asks for the next step.
 *
 *   GET  /member/:teamId                  the member's own identity code and where this side stands
 *   POST /member/:teamId/check            { code }  the admin's identity code, compared here (3 tries)
 *   POST /member/:teamId/anchor           the touch: signs "I trust this admin for this team"
 *   GET  /admin/:teamId                   the admin's own identity code and every request with its state
 *   POST /admin/:teamId/:userId/check     { code }  the member's identity code, compared here (3 tries)
 *   POST /admin/:teamId/:userId/add       the touch: signs member list version n+1
 *
 * An answer is { ok: true, ... } or { ok: false, code, triesLeft? } with a neutral `code` the page maps to its words.
 * A wrong code is a 200 with `match: false`: it is an answer, not a failure. Nothing is logged but codes.
 */
import { Router, type Response } from 'express';
import { JoinRefusal, type TeamJoin } from '../lib/team-join';

function answer(res: Response, err: unknown): void {
  if (err instanceof JoinRefusal) {
    res.status(err.status).json({ ok: false, error: err.code, code: err.code, ...err.extra });
    return;
  }
  console.error('[Control Plane] /api/team-join failed:', err instanceof Error ? err.name : 'error');
  res.status(500).json({ ok: false, error: 'internal', code: 'internal' });
}

export function createTeamJoinRouter(join: TeamJoin): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!join.active()) { res.status(409).json({ ok: false, error: 'not_set_up', code: 'not_set_up' }); return; }
    next();
  });
  const body = (req: { body?: unknown }): { code?: unknown } => (req.body ?? {}) as { code?: unknown };

  router.get('/member/:teamId', async (req, res) => {
    try { res.json({ ok: true, ...(await join.memberView(req.params.teamId)) }); } catch (e) { answer(res, e); }
  });
  router.post('/member/:teamId/check', async (req, res) => {
    try { res.json({ ok: true, ...(await join.memberCheck(req.params.teamId, body(req).code)) }); } catch (e) { answer(res, e); }
  });
  router.post('/member/:teamId/anchor', async (req, res) => {
    try { res.json({ ok: true, ...(await join.memberAnchor(req.params.teamId)) }); } catch (e) { answer(res, e); }
  });
  router.get('/admin/:teamId', async (req, res) => {
    try { res.json({ ok: true, ...(await join.adminView(req.params.teamId)) }); } catch (e) { answer(res, e); }
  });
  router.post('/admin/:teamId/:userId/check', async (req, res) => {
    try { res.json({ ok: true, ...(await join.adminCheck(req.params.teamId, req.params.userId, body(req).code)) }); } catch (e) { answer(res, e); }
  });
  router.post('/admin/:teamId/:userId/add', async (req, res) => {
    try { res.json({ ok: true, ...(await join.adminAdd(req.params.teamId, req.params.userId)) }); } catch (e) { answer(res, e); }
  });
  return router;
}
