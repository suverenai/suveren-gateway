/**
 * /api/team-changes — changes of a team's member list after the join (DEC-73 step 5). Mounted behind the page session and the auth
 * guard, like /api/team-join, only on a gateway with a device chain. All logic is in lib/team-changes.ts; nothing the page sends is
 * signed by itself: the page names a person (a DID from the verified list, a user id the Authority Server pointed at) and asks for the next step.
 *
 *   GET  /:teamId                          what is on offer (admin: remove, replace, re-sign, hand-over; member: admin changed / gone)
 *   POST /:teamId/remove        { did }            the touch: list without that person
 *   POST /:teamId/replace/:userId/check { code }   the NEW identity's code, compared here (3 tries)
 *   POST /:teamId/replace/:userId              the touch: list with the old DID replaced by the new one
 *   POST /:teamId/resign                       the touch: the same members again, by a device that stays
 *   POST /:teamId/handover      { did }        the old admin names the new admin and her device (no touch)
 *   POST /:teamId/handover/build               the new admin builds and signs the list (touch)
 *   POST /:teamId/handover/sign                the old admin adds her signature (touch)
 *   DELETE /:teamId/handover                   withdraw
 *   POST /:teamId/take-over                    a member takes over, the admin took a new identity (touch)
 *
 * An answer is { ok: true, ... } or { ok: false, code } with a neutral code the page maps to its words. Nothing is logged but codes.
 */
import { Router, type Response } from 'express';
import { JoinRefusal } from '../lib/team-join';
import type { TeamListChanges } from '../lib/team-changes';

function answer(res: Response, err: unknown): void {
  if (err instanceof JoinRefusal) { res.status(err.status).json({ ok: false, error: err.code, code: err.code, ...err.extra }); return; }
  console.error('[Control Plane] /api/team-changes failed:', err instanceof Error ? err.name : 'error');
  res.status(500).json({ ok: false, error: 'internal', code: 'internal' });
}

export function createTeamChangesRouter(c: TeamListChanges): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!c.active()) { res.status(409).json({ ok: false, error: 'not_set_up', code: 'not_set_up' }); return; }
    next();
  });
  const b = (req: { body?: unknown }): { code?: unknown; did?: unknown } => (req.body ?? {}) as { code?: unknown; did?: unknown };
  const run = (fn: (req: any) => Promise<object>) => async (req: any, res: Response) => {
    try { res.json({ ok: true, ...(await fn(req)) }); } catch (e) { answer(res, e); }
  };
  router.get('/:teamId', run(req => c.status(req.params.teamId)));
  router.post('/:teamId/remove', run(req => c.removeMember(req.params.teamId, b(req).did)));
  router.post('/:teamId/replace/:userId/check', run(req => c.replaceCheck(req.params.teamId, req.params.userId, b(req).code)));
  router.post('/:teamId/replace/:userId', run(req => c.replaceMember(req.params.teamId, req.params.userId)));
  router.post('/:teamId/resign', run(req => c.resign(req.params.teamId)));
  router.post('/:teamId/handover', run(req => c.handoverOffer(req.params.teamId, b(req).did)));
  router.post('/:teamId/handover/build', run(req => c.handoverBuild(req.params.teamId)));
  router.post('/:teamId/handover/sign', run(req => c.handoverSign(req.params.teamId)));
  router.delete('/:teamId/handover', run(req => c.handoverWithdraw(req.params.teamId)));
  router.post('/:teamId/take-over', run(req => c.takeOver(req.params.teamId)));
  return router;
}
