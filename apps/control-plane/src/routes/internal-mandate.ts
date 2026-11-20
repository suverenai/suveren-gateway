/**
 * POST /internal/mandate — the MCP server asking the control plane to check or
 * create a mandate for the signed-in person (simulation setup S8,
 * `setup__create_mandate`). Body: `{ dryRun: boolean, request: MandateRequest }`.
 *
 * - dryRun: validate only (rights, profile, limits, scope, mode, duration, intent);
 *   with `request.rightsOnly` only the rights (team authority gate) — the 422 then carries
 *   a `code` (`profile_not_enabled` / `not_a_grantor`) so the gateway can name the next step
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
import { planMandate, createMandate, checkMandateRight, planMandateChange, changeMandate, changeOnPhone, giveOnPhone, isNoCheckKeyRefusal, MandateRefused, type CeremonyDeps, type MandateChangeRequest, type MandateRequest } from '../lib/mandate-ceremony';
import { eventBus } from '../lib/event-bus';
import { ApprovalRefusal, type DeviceApprovals, type TakenApproval } from '../lib/device-approvals';

/** The workspace the Setup tools' mandates go to (the same name builtins/setup.ts declares; keep the two in step). */
const DELEGATION_PROFILE = 'delegation';

/** The request the Setup tool builds from the arguments a person approved (mirror of builtins/setup.ts `mandateRequest` and `changesFrom`). */
function createRequestFrom(args: Record<string, unknown>): MandateRequest {
  return {
    workspaceOf: DELEGATION_PROFILE, profile: args.profile, limits: args.limits, scope: args.scope, intent: args.intent, mode: args.mode,
    durationHours: args.duration_hours, title: args.title,
  } as MandateRequest;
}
function changeRequestFrom(args: Record<string, unknown>, old: unknown): { change: MandateChangeRequest } {
  return { change: {
    old: old as MandateChangeRequest['old'],
    changes: {
      limits: args.limits as Record<string, unknown> | undefined, scope: args.scope as Record<string, unknown> | undefined,
      mode: typeof args.mode === 'string' ? args.mode : undefined, durationHours: typeof args.duration_hours === 'number' ? args.duration_hours : undefined,
      intent: typeof args.intent === 'string' ? args.intent : undefined,
    },
    sealedDiff: args.change as MandateChangeRequest['sealedDiff'],
  } };
}

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createInternalMandateRouter(
  getSecret: () => string,
  deps: () => Omit<CeremonyDeps, 'newAuthorizationId'>,
  approvals?: DeviceApprovals,
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
    // Whether a person compared an approver's identity code is for the page to say, never for the AI path (nor for a proposal's sealed copy).
    delete (request as { confirmedApproverDids?: unknown }).confirmedApproverDids;
    if ((request as { change?: { confirmedApproverDids?: unknown } }).change) delete (request as { change?: { confirmedApproverDids?: unknown } }).change!.confirmedApproverDids;
    let spend: TakenApproval | undefined;
    const changingNow = !!(request as { change?: unknown }).change;
    // Spent as soon as the Authority Server accepted the mandate: a failure AFTER that (the intent not delivered) never lets the same approval run again.
    const d: CeremonyDeps = { ...deps(), newAuthorizationId: () => `authz_${randomUUID()}`, onIssued: info => spend?.done(info.mandateId), newMandateId: () => (changingNow ? undefined : spend?.mandateId) };
    // A gateway with a device chain: creating a mandate raises Touch ID. Only the internal secret is not a reason to: the call runs only
    // for exactly what the person approved on the page (lib/device-approvals.ts: the device-signed commit decision, from any own device). The request is then built HERE from those approved
    // arguments; nothing of the caller's request content is used. Read-only checks (dry runs) are not affected.
    let effective: MandateRequest = request;
    if (dryRun !== true && d.grants?.active()) {
      const changing = !!(request as { change?: unknown }).change;
      let taken: TakenApproval;
      try {
        if (!approvals) throw new ApprovalRefusal(403, 'approval_required', 'A mandate on this gateway is created only for what the person approved, and nothing was approved under that fingerprint.');
        taken = await approvals.take(changing ? 'setup__change_mandate' : 'setup__create_mandate', (request as { approvalHash?: unknown }).approvalHash);
      } catch (e) {
        if (e instanceof ApprovalRefusal) { res.status(e.status).json({ error: 'approval_required', code: e.code, message: e.message, ...e.extra }); return; }
        console.error('[Control Plane] /internal/mandate approval check failed:', e instanceof Error ? e.name : 'error');
        res.status(500).json({ error: 'internal', message: 'The approval could not be checked.' });
        return;
      }
      spend = taken;
      // A change is of the mandate the person approved the change OF, not of whichever one the caller names.
      if (changing && (request as { change?: { old?: { authorizationId?: unknown } } }).change?.old?.authorizationId !== taken.args.mandate_id) {
        await taken.release();
        res.status(403).json({ error: 'approval_required', code: 'approval_other_mandate', message: 'The change was approved for another mandate than the one named.' });
        return;
      }
      effective = (changing ? changeRequestFrom(taken.args, (request as { change?: { old?: unknown } }).change?.old) : createRequestFrom(taken.args)) as MandateRequest;
    }
    try {
      const change = (effective as { change?: MandateChangeRequest }).change;
      if (change) {
        if (dryRun === true) {
          const { plan, diff } = await planMandateChange(change, d);
          res.json({ ok: true, groupName: plan.groupName, profileId: plan.profile.id, mode: plan.mode, ttlSeconds: plan.ttlSeconds, diff });
          return;
        }
        const { authorizationId, plan, revokeError, oldStoppedLocally } = await changeMandate(change, d);
        await spend?.settled();
        // The Authority Server holds the new mandate now: the Mandates list and the
        // dashboard re-read it at once (this path never crosses the /api proxy,
        // which is where every other mandate write announces itself).
        eventBus.emit('attestation-changed');
        res.json({ ok: true, authorizationId, profileId: plan.profile.id, groupName: plan.groupName, mode: plan.mode, ttlSeconds: plan.ttlSeconds, ...(revokeError ? { revokeError } : {}), ...(oldStoppedLocally ? { oldStoppedLocally } : {}) });
        return;
      }
      if (dryRun === true && (request as { rightsOnly?: unknown }).rightsOnly === true) {
        // Only "may this person give a mandate for this profile here?" — no limits needed.
        const r = await checkMandateRight(request, d);
        res.json({ ok: true, groupName: r.groupName, profileId: r.profileId });
        return;
      }
      if (dryRun === true) {
        const plan = await planMandate(request, d);
        res.json({ ok: true, groupName: plan.groupName, profileId: plan.profile.id, mode: plan.mode, ttlSeconds: plan.ttlSeconds });
        return;
      }
      const { authorizationId, plan } = await createMandate(effective, d);
      await spend?.settled();
      eventBus.emit('attestation-changed'); // see the change branch above
      res.json({ ok: true, authorizationId, profileId: plan.profile.id, groupName: plan.groupName, mode: plan.mode, ttlSeconds: plan.ttlSeconds });
    } catch (err) {
      // A computer without Touch ID cannot grant what the person approved; their phone can (DEC-90). The claim on the approval is kept (not
      // released): the give carries the mandate id the claim names, so once the phone's grant is issued the Authority Server refuses the
      // approval to anyone else (a claim whose mandate was issued is never taken over), and before that only this computer holds it.
      if (spend && isNoCheckKeyRefusal(err)) {
        try {
          const change = (effective as { change?: MandateChangeRequest }).change;
          const g = change ? await changeOnPhone(change, d, { proposalId: spend.proposalId }) : await giveOnPhone(effective, d, { proposalId: spend.proposalId });
          res.json({ ok: true, onPhone: { mandateId: g.mandateId, mandateVersion: g.mandateVersion, expiresAt: g.expiresAt }, proposalId: spend.proposalId });
          return;
        } catch (phoneErr) {
          // No phone that can give it either: the person hears the computer's own refusal below.
          if (!(phoneErr instanceof MandateRefused)) console.error('[Control Plane] sending the approved mandate to the phone failed:', phoneErr instanceof Error ? phoneErr.message : phoneErr);
        }
      }
      await spend?.release();
      if (err instanceof MandateRefused) {
        res.status(422).json({ error: 'mandate_refused', message: err.message, ...(err.code ? { code: err.code } : {}), ...(err.detail ?? {}) });
        return;
      }
      console.error('[Control Plane] /internal/mandate failed:', err);
      res.status(500).json({ error: 'internal', message: err instanceof Error ? err.message : String(err) });
    }
  });
  return router;
}
