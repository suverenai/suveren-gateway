/**
 * POST /api/mandate/sign, /api/mandate/renew — the web page's mandate signing.
 * The page no longer hashes or signs: it sends the values and the control plane
 * runs the same steps the AI path runs (lib/mandate-ceremony.ts), under the
 * person's own session. A refusal answers 422 { error, message, code? }.
 */
import { Router, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { createMandate, renewMandate, renewOnPhone, prepareMandate, planMandateChange, changeMandate, changeOnPhone, giveOnPhone, pollPhoneGive, cancelPhoneGive, MandateRefused, type CeremonyDeps, type MandateRequest, type RenewRequest, type SignedMandate } from '../lib/mandate-ceremony';
import { approvalCapsOf, limitsOf, memberLabel, type TeamTerms } from '../lib/mandate-change-view';
import { GrantRefusal } from '../lib/mandate-grants';
import { eventBus } from '../lib/event-bus';

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

/** What the page's read-only routes ask of the MCP server (it owns the verdicts and the signed copies). */
export interface MandateReads {
  heldBack(): Promise<Array<{ authorizationId: string; code: string; profileId?: string; ownerDid?: string; mandateId?: string }>>;
  signedMandate(id: string): Promise<{ old: SignedMandate; team: { approverDids: string[]; approvals: number | null; caps: Record<string, number> } } | { refusal: string; code: string }>;
}

const NOT_SET_UP = { error: 'not_set_up', message: 'Device keys are not set up.', code: 'not_set_up' };

export function createMandateRouter(deps: () => Omit<CeremonyDeps, 'newAuthorizationId'>, reads?: MandateReads): Router {
  const router = Router();
  // ── Step 13 screens (page session only: this router sits behind it; a gateway with a device chain only) ──

  // The mandates this gateway holds back, with its own verdict code. Read-only: nothing is changed, signed or fetched for the AI.
  router.get('/held-back', async (_req, res) => {
    try {
      const d = deps();
      if (!d.grants?.active() || !reads) { res.status(409).json(NOT_SET_UP); return; }
      const held = await reads.heldBack();
      const names = new Map<string, string>();
      for (const id of new Set(held.map(h => h.profileId).filter((x): x is string => !!x))) {
        const r = await d.as('GET', `/api/profiles/${encodeURIComponent(id)}`);
        const n = r.status === 200 && typeof r.body?.name === 'string' && r.body.name ? r.body.name : id.replace(/@.*$/, '').split('/').pop() ?? id;
        names.set(id, n);
      }
      res.json({ held: held.map(h => ({
        authorizationId: h.authorizationId, mandateId: h.mandateId ?? h.authorizationId, code: h.code,
        profileName: h.profileId ? names.get(h.profileId) ?? h.profileId : 'a mandate',
        ownerIsYou: !!h.ownerDid && h.ownerDid === d.user?.did,
        // the member list does not name an owner by DID: not known here (the screen then says so)
        ownerName: null, adminName: null,
      })) });
    } catch (err) { answerRefusal(res, err); }
  });

  // The change the person prepares for a mandate: the hap-core diff and the team's terms before (signed) and after (settings now).
  // Computed here from the signed mandate; creates and signs nothing.
  const parseChanges = (raw: unknown): Record<string, unknown> | null => {
    try { const v = typeof raw === 'string' ? JSON.parse(raw) : raw; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
  };
  const readOld = async (id: unknown) => {
    if (typeof id !== 'string' || !/^authz_[0-9a-f-]{36}$/.test(id)) return { bad: true as const };
    const r = await reads!.signedMandate(id);
    return 'refusal' in r ? { refusal: r as { refusal: string; code: string } } : { ok: r };
  };
  router.get('/change-preview', async (req, res) => {
    try {
      const d = deps();
      if (!d.grants?.active() || !reads) { res.status(409).json(NOT_SET_UP); return; }
      const changes = parseChanges(req.query.changes ?? '{}');
      const got = await readOld(req.query.authorizationId);
      if (!changes || 'bad' in got) { res.status(400).json({ error: 'bad_request', code: 'bad_request', message: 'Bad request.' }); return; }
      if ('refusal' in got) { res.status(422).json({ error: 'mandate_refused', code: 'mandate_not_active', message: got.refusal?.refusal }); return; }
      const full: CeremonyDeps = { ...d, newAuthorizationId: () => `authz_${randomUUID()}` };
      const { plan, diff } = await planMandateChange({ old: got.ok.old, changes: changes as never }, full);
      let before: TeamTerms | null = null;
      let after: TeamTerms | null = null;
      if (!plan.isPersonal && plan.team) {
        // labels: the team's member list; a DID is read through the settings' eligible approvers (user id, DID)
        const g = await d.as('GET', `/api/groups/${encodeURIComponent(plan.groupId)}`);
        const members = (g.status === 200 ? g.body?.members ?? [] : []) as Array<{ id: string; name?: string; email?: string }>;
        const labelOfUser = (id: string) => { const m = members.find(x => x.id === id); return m ? memberLabel(m) : id; };
        const userOfDid = new Map((plan.team.eligible ?? []).filter(e => e.did).map(e => [e.did as string, e.user_id]));
        const labelOfDid = (did: string) => (userOfDid.has(did) ? labelOfUser(userOfDid.get(did)!) : 'someone no longer an approver');
        const newCaps = approvalCapsOf(plan.team, plan.profile);
        before = { approvers: got.ok.team.approverDids.map(labelOfDid), approvals: got.ok.team.approvals ?? 0, limits: limitsOf(got.ok.team.caps, plan.profile) };
        after = {
          approvers: (plan.team.eligible ?? []).filter(e => e.did).map(e => labelOfUser(e.user_id)),
          approvals: Object.keys(newCaps).length > 0 ? (plan.team.approvals ?? 1) : 0,
          limits: limitsOf(newCaps, plan.profile),
        };
      }
      res.json({ profileName: plan.profile.name ?? plan.profile.id.replace(/@.*$/, ''), diff, before, after });
    } catch (err) { answerRefusal(res, err); }
  });

  // The Touch ID change call of the Change screen: signs a new version with this computer's check. `sealedDiff` is the diff the person
  // was shown: a change that would differ from it is refused (changed_since_proposal), never signed.
  router.post('/change', async (req, res) => {
    try {
      const d = deps();
      if (!d.grants?.active() || !reads) { res.status(409).json(NOT_SET_UP); return; }
      const b = (req.body ?? {}) as { authorizationId?: unknown; changes?: unknown; sealedDiff?: unknown };
      const changes = parseChanges(b.changes ?? {});
      const got = await readOld(b.authorizationId);
      if (!changes || 'bad' in got || !b.sealedDiff || typeof b.sealedDiff !== 'object') { res.status(400).json({ error: 'bad_request', code: 'bad_request', message: 'Bad request.' }); return; }
      if ('refusal' in got) { res.status(422).json({ error: 'mandate_refused', code: 'mandate_not_active', message: got.refusal?.refusal }); return; }
      const full: CeremonyDeps = { ...d, newAuthorizationId: () => `authz_${randomUUID()}` };
      const r = await changeMandate({ old: got.ok.old, changes: changes as never, sealedDiff: b.sealedDiff as never }, full);
      void d.resyncGates?.().catch(() => {});
      res.json({ ok: true, authorizationId: r.authorizationId });
    } catch (err) { answerRefusal(res, err); }
  });

  // The same change sent to the phone (DEC-90, a computer without Touch ID; the Extend button lands here too): the diff shown is checked
  // like /change, then it waits as a give does (GET /give-on-phone/:mandateId).
  router.post('/change-on-phone', async (req, res) => {
    try {
      const d = deps();
      if (!d.grants?.active() || !reads) { res.status(409).json(NOT_SET_UP); return; }
      const b = (req.body ?? {}) as { authorizationId?: unknown; changes?: unknown; sealedDiff?: unknown };
      const changes = parseChanges(b.changes ?? {});
      const got = await readOld(b.authorizationId);
      if (!changes || 'bad' in got || !b.sealedDiff || typeof b.sealedDiff !== 'object') { res.status(400).json({ error: 'bad_request', code: 'bad_request', message: 'Bad request.' }); return; }
      if ('refusal' in got) { res.status(422).json({ error: 'mandate_refused', code: 'mandate_not_active', message: got.refusal?.refusal }); return; }
      const full: CeremonyDeps = { ...d, newAuthorizationId: () => `authz_${randomUUID()}` };
      res.json({ ok: true, ...(await changeOnPhone({ old: got.ok.old, changes: changes as never, sealedDiff: b.sealedDiff as never }, full)) });
    } catch (err) { answerRefusal(res, err); }
  });

  // A dry run of the give (chain gateways): exactly what would be granted and what the give would refuse before the touch. No touch, no write.
  router.post('/prepare', async (req, res) => {
    try {
      const d = deps();
      if (!d.grants?.active()) { res.status(409).json(NOT_SET_UP); return; }
      const request = (req.body ?? {}) as MandateRequest;
      res.json(await prepareMandate(request, { ...d, newAuthorizationId: () => `authz_${randomUUID()}` }));
    } catch (err) { answerRefusal(res, err); }
  });

  router.post('/sign', async (req, res) => {
    const request = (req.body ?? {}) as MandateRequest;
    try {
      // The page shows each step of a give with Touch ID (never a silent wait): the stage only, no content.
      const d: CeremonyDeps = { ...deps(), newAuthorizationId: () => `authz_${randomUUID()}`, progress: (stage) => eventBus.emit('give-progress', { stage }) };
      // A chain gateway gives only what was prepared for this page: the request is prepared again here and must hash to what the page echoed.
      if (d.grants?.active()) {
        const echoed = (req.body as { planHash?: unknown } | undefined)?.planHash;
        if (typeof echoed !== 'string') { res.status(422).json({ error: 'mandate_refused', code: 'prepare_required', message: 'The mandate was not prepared on this page; nothing was signed.' }); return; }
        const now = await prepareMandate(request, d);
        if (now.planHash !== echoed) { res.status(422).json({ error: 'mandate_refused', code: 'changed_since_prepare', message: 'What would be granted changed since it was shown; nothing was signed. Look at it again.' }); return; }
      }
      const { authorizationId, revokeError, oldStoppedLocally } = await createMandate(request, d);
      res.json({ ok: true, authorizationId, ...(revokeError ? { revokeError } : {}), ...(oldStoppedLocally ? { oldStoppedLocally } : {}) });
    } catch (err) { answerRefusal(res, err); }
  });
  // Give on the phone (plan 4.4 "Transport", DEC-86): the same prepared plan as /sign, sealed to the person's devices; the phone grants it.
  router.post('/give-on-phone', async (req, res) => {
    const request = (req.body ?? {}) as MandateRequest;
    try {
      const d: CeremonyDeps = { ...deps(), newAuthorizationId: () => `authz_${randomUUID()}` };
      if (!d.grants?.active()) { res.status(409).json(NOT_SET_UP); return; }
      const echoed = (req.body as { planHash?: unknown } | undefined)?.planHash;
      if (typeof echoed !== 'string') { res.status(422).json({ error: 'mandate_refused', code: 'prepare_required', message: 'The mandate was not prepared on this page; nothing was sent.' }); return; }
      const now = await prepareMandate(request, d);
      if (now.planHash !== echoed) { res.status(422).json({ error: 'mandate_refused', code: 'changed_since_prepare', message: 'What would be granted changed since it was shown; nothing was sent. Look at it again.' }); return; }
      res.json({ ok: true, ...(await giveOnPhone(request, d)) });
    } catch (err) { answerRefusal(res, err); }
  });
  // The give an approved AI proposal sent to the phone (DEC-90): the approval card asks by its proposal id and then waits like the page.
  router.get('/give-on-phone', (req, res) => {
    try {
      const d: CeremonyDeps = { ...deps(), newAuthorizationId: () => `authz_${randomUUID()}` };
      if (!d.grants?.active()) { res.json({ waiting: null }); return; }
      const proposal = typeof req.query.proposal === 'string' ? req.query.proposal : '';
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(proposal)) { res.status(400).json({ error: 'bad_request', code: 'bad_request', message: 'Bad request.' }); return; }
      const g = d.grants.phoneGives.byProposal(proposal);
      res.json({ waiting: g ? { mandateId: g.mandateId, startedAt: g.startedAt } : null });
    } catch (err) { answerRefusal(res, err); }
  });
  router.get('/give-on-phone/:mandateId', async (req, res) => {
    try {
      const d: CeremonyDeps = { ...deps(), newAuthorizationId: () => `authz_${randomUUID()}` };
      if (!d.grants?.active()) { res.status(409).json(NOT_SET_UP); return; }
      const id = req.params.mandateId;
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) { res.status(400).json({ error: 'bad_request', code: 'bad_request', message: 'Bad request.' }); return; }
      const r = await pollPhoneGive(id, d);
      if (r.state === 'done') void d.resyncGates?.().catch(() => {});
      res.json(r);
    } catch (err) { answerRefusal(res, err); }
  });
  router.delete('/give-on-phone/:mandateId', (req, res) => {
    try {
      const d: CeremonyDeps = { ...deps(), newAuthorizationId: () => `authz_${randomUUID()}` };
      res.json({ ok: cancelPhoneGive(req.params.mandateId, d) });
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
  // The person withdraws a confirmation. Page session only (this router sits behind it); never the AI path.
  // The team's verified member list, or why there is none (a code; the page words it). `?refresh=1` fetches and verifies now. Page session only.
  router.get('/team-trust', async (req, res) => {
    try {
      const d = deps();
      if (!d.grants?.active()) { res.status(409).json(NOT_SET_UP); return; }
      res.json(await d.grants.teamTrustStatus(req.query.refresh === '1'));
    } catch (err) { answerRefusal(res, err); }
  });
  router.post('/forget-identity', async (req, res) => {
    try {
      const d = deps();
      if (!d.grants?.active()) { res.status(409).json({ error: 'not_set_up', message: 'Device keys are not set up.', code: 'not_set_up' }); return; }
      d.grants.forgetIdentity((req.body as { did?: unknown } | undefined)?.did);
      res.json({ ok: true });
    } catch (err) { answerRefusal(res, err); }
  });
  // Extend on the phone (DEC-90): a computer without a check key sends the renewal to the phone; the page then waits as for a give.
  router.post('/renew-on-phone', async (req, res) => {
    const request = (req.body ?? {}) as RenewRequest;
    try {
      const d: CeremonyDeps = { ...deps(), newAuthorizationId: () => request.authorizationId };
      if (!d.grants?.active()) { res.status(409).json(NOT_SET_UP); return; }
      res.json({ ok: true, ...(await renewOnPhone(request, d)) });
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
