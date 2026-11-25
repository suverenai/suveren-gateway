/**
 * The proposal routes of the Authority Server for the step 12 tests, on top of StubAs
 * (helpers/stub-as.ts): `GET /api/proposals/:id` and `POST /api/proposals/:id/{approve,
 * reject,resolve,withdraw}`, in the shapes of the real routes
 * (suveren-as app/api/proposals/[id]/**, lib/device-keys/decisions.ts, as of PR #134).
 *
 * Only the network is a stand-in. What the real routes decide about a device decision is decided
 * here with the real hap-core verifier (`verifyChain`, `verifyDecision`) against the chain StubAs
 * holds, with the real AS's rules: a device session MUST send `device_decision`
 * (DEVICE_DECISION_REQUIRED), the signing key must be the key of the session (DEVICE_MISMATCH), the
 * kind must be the one the route performs (DECISION_KIND_MISMATCH), `(user, nonce)` is used once
 * (DECISION_NONCE_REUSED), and the fingerprint the call sends must be the proposal's (CONTENT_MISMATCH).
 * It records every call so a test can search what the gateway sent.
 */

import { verifyChain, verifyDecision, DeviceKeysError } from '@hap/core/device-keys';
import type { Decision, DecisionKind } from '@hap/core/device-keys';
import type { ExtraRouteContext, StubAs } from './stub-as';

export interface StubProposal {
  id: string;
  authorizationId: string;
  profileId: string;
  tool: string;
  /** What the AS stored with the proposal (validated against the profile there). */
  actionType?: string;
  toolArgs: Record<string, unknown> | null;
  content: Record<string, unknown> | null;
  contentHash: string;
  status: 'pending' | 'committed' | 'rejected' | 'executed';
  createdBy: string;
  pendingApprovers?: string[];
  approvedBy?: Record<string, unknown>;
  pendingDomains: string[];
  committedBy: Record<string, unknown>;
  rejectedBy: unknown;
  executionContext: Record<string, unknown>;
  executionResult: null;
  createdAt: number;
  expiresAt: number;
  path: string;
}

export interface StoredDecision {
  proposalId: string;
  userId: string;
  keyId: string;
  deviceLabel: string | null;
  decision: Decision;
  sig: string;
  asChainSeq: number;
  storedAt: number;
}

export interface Posted { route: string; proposalId: string; body: Record<string, unknown>; status: number }

export class StubProposals {
  readonly proposals = new Map<string, StubProposal>();
  readonly decisions: StoredDecision[] = [];
  readonly posts: Posted[] = [];
  /** What the AS names for a decision: the signed mandate id and the action type stored with the proposal. */
  mandateId = 'mandate-1';
  actionType = 'send';
  private readonly nonces = new Set<string>();
  /**
   * The single-use claims of the approvals-from-any-device routes (plan 20.21.6, step 6), in the shapes of the real routes
   * (suveren-as app/api/proposals/{committed,[id]/spend,[id]/release}, lib/device-keys/approval-spends.ts, branch feat/approvals-any-device):
   *   GET  /api/proposals/committed?content_hash=&tool=  -> 200 { proposals: [ { proposal, decision: { key_id, decision, sig, as_chain_seq, stored_at },
   *                                                           spend: { state: 'free' } | { state: 'claimed'|'spent', key_id, mandate_id, claimed_at, spent_at } } ] }
   *   POST /api/proposals/:id/spend   { phase: 'claim' } -> 200 { claimed, claimed_at, expires_at } | 409 SPEND_CLAIMED / SPEND_DONE
   *   POST /api/proposals/:id/spend   { phase: 'done', mandate_id } -> 200 { spent } (claiming key only; MANDATE_NOT_ISSUED unless an issued mandate has that id)
   *   POST /api/proposals/:id/release                   -> 200 { released } (claiming key only; 409 SPEND_DONE / SPEND_NOT_HELD)
   * A claim lapses after 10 minutes unless spent. `issuedMandates` is what the stub accepts as issued (tests fill it from StubMandates).
   */
  readonly spends = new Map<string, { claimedAt: number; spentAt: number | null; keyId: string; mandateId?: string | null }>();
  /** Mandate ids the stub counts as issued (the `done` phase checks them). Default: any. */
  issuedMandates: ((id: string) => boolean) | null = null;
  /** Tests only: answer 503 to every `done`. */
  failDone = false;
  readonly spendCalls: Array<{ proposalId: string; action: string; status: number }> = [];
  /** Tests only: serve these decisions instead of the stored ones (a forged or altered copy). */
  committedOverride: ((p: StubProposal, own: StoredDecision[]) => unknown[]) | null = null;

  constructor(private readonly as: StubAs) {
    as.extraRoutes = c => this.route(c);
  }

  add(p: Partial<StubProposal> & { id: string; tool: string; contentHash: string }): StubProposal {
    const full: StubProposal = {
      authorizationId: 'authz_1', profileId: 'email@0.9', path: 'email@0.9', toolArgs: null, content: null,
      status: 'pending', createdBy: 'u1', pendingDomains: ['u1'], committedBy: {}, rejectedBy: null,
      executionContext: {}, executionResult: null, createdAt: 0, expiresAt: 0,
      ...p,
    };
    this.proposals.set(full.id, full);
    return full;
  }

  private approvalRoute(c: ExtraRouteContext): boolean {
    const now = Math.floor(Date.now() / 1000);
    const spendOf = (id: string) => {
      const r = this.spends.get(id);
      if (!r) return { state: 'free' as const };
      if (r.spentAt !== null) return { state: 'spent' as const, ...r };
      return now - r.claimedAt < 600 ? { state: 'claimed' as const, ...r } : { state: 'free' as const, ...r };
    };
    if (c.method === 'GET' && c.path === '/api/proposals/committed') {
      if (!c.session) { c.refuse(401, 'UNAUTHENTICATED', 'Authentication required'); return true; }
      const url = new URL(c.req.url ?? c.path, 'http://x');
      const hash = url.searchParams.get('content_hash');
      const tool = url.searchParams.get('tool');
      const out = [...this.proposals.values()]
        .filter(p => p.status === 'committed' && p.contentHash === hash && (!tool || p.tool === tool))
        .flatMap(p => {
          const own = this.decisions.filter(d => d.proposalId === p.id && d.userId === c.session!.userId && d.decision.decision === 'commit');
          const rows = this.committedOverride ? this.committedOverride(p, own) : own.map(d => ({ key_id: d.keyId, decision: d.decision, sig: d.sig, as_chain_seq: d.asChainSeq, stored_at: d.storedAt }));
          const sp = spendOf(p.id);
          return rows.slice(0, 1).map(decision => ({
            proposal: { ...p, deviceDecisions: undefined }, decision,
            spend: sp.state === 'free' ? { state: 'free' } : { state: sp.state, key_id: (sp as { keyId: string }).keyId, mandate_id: (sp as { mandateId?: string | null }).mandateId ?? null, claimed_at: (sp as { claimedAt: number }).claimedAt, spent_at: (sp as { spentAt: number | null }).spentAt },
          }));
        });
      c.json(200, { proposals: out });
      return true;
    }
    const m = /^\/api\/proposals\/([^/]+)\/(spend|release)$/.exec(c.path);
    if (!m || c.method !== 'POST') return false;
    if (!c.session) { c.refuse(401, 'UNAUTHENTICATED', 'Authentication required'); return true; }
    const id = decodeURIComponent(m[1]);
    const act = m[2] === 'release' ? 'release' : String(c.body.phase ?? 'claim');
    const record = (status: number): boolean => { this.spendCalls.push({ proposalId: id, action: act, status }); return true; };
    const p = this.proposals.get(id);
    if (!p) { c.refuse(404, 'PROPOSAL_NOT_FOUND', 'proposal not found'); return record(404); }
    if (p.status !== 'committed') { c.refuse(409, 'PROPOSAL_NOT_COMMITTED', 'not committed'); return record(409); }
    if (!this.decisions.some(d => d.proposalId === id && d.userId === c.session!.userId && d.decision.decision === 'commit')) { c.refuse(409, 'NO_DEVICE_DECISION', 'no decision'); return record(409); }
    const cur = spendOf(id) as { state: string; keyId?: string; mandateId?: string | null; claimedAt?: number };
    const keyId = c.session.keyId;
    const isIssued = (m: string | null | undefined): boolean => !!m && (this.issuedMandates ? this.issuedMandates(m) : false);
    const mandateId = c.body.mandate_id;
    if (act === 'claim') {
      // PR #145: mandate_id is REQUIRED at claim; the same key claiming the same mandate again is idempotent.
      if (typeof mandateId !== 'string') { c.refuse(400, 'MALFORMED', 'claim needs mandate_id'); return record(400); }
      if (cur.state === 'spent') { c.refuse(409, 'SPEND_DONE', 'used'); return record(409); }
      if (cur.state === 'claimed') {
        if (cur.keyId === keyId && cur.mandateId === mandateId) { c.json(200, { claimed: true, proposal_id: id, claimed_at: cur.claimedAt, expires_at: (cur.claimedAt as number) + 600 }); return record(200); }
        c.refuse(409, 'SPEND_CLAIMED', 'held elsewhere'); return record(409);
      }
      // a lapsed claim cannot be taken over once the mandate it named was issued
      if (cur.keyId && isIssued(cur.mandateId)) { c.refuse(409, 'SPEND_DONE', 'the mandate of an earlier claim was issued'); return record(409); }
      this.spends.set(id, { claimedAt: now, spentAt: null, keyId, mandateId });
      c.json(200, { claimed: true, proposal_id: id, claimed_at: now, expires_at: now + 600 }); return record(200);
    }
    if (act === 'done') {
      if (typeof mandateId !== 'string') { c.refuse(400, 'MALFORMED', 'done needs mandate_id'); return record(400); }
      if (this.failDone) { c.refuse(503, 'UNAVAILABLE', 'down'); return record(503); }
      if (cur.state === 'spent') { c.refuse(409, 'SPEND_DONE', 'used'); return record(409); }
      if (cur.keyId !== keyId || cur.mandateId !== mandateId) { c.refuse(409, 'SPEND_NOT_HELD', 'not held, or another mandate than the claim named'); return record(409); }
      if (this.issuedMandates && !this.issuedMandates(mandateId)) { c.refuse(409, 'MANDATE_NOT_ISSUED', 'not issued'); return record(409); }
      this.spends.set(id, { claimedAt: cur.claimedAt as number, spentAt: now, keyId, mandateId });
      c.json(200, { spent: true, proposal_id: id, mandate_id: mandateId, spent_at: now }); return record(200);
    }
    if (act === 'release') {
      if (cur.state === 'spent') { c.refuse(409, 'SPEND_DONE', 'used'); return record(409); }
      if (cur.keyId !== keyId) { c.refuse(409, 'SPEND_NOT_HELD', 'not held'); return record(409); }
      if (isIssued(cur.mandateId)) { c.refuse(409, 'SPEND_DONE', 'the mandate was issued'); return record(409); }
      this.spends.delete(id);
      c.json(200, { released: true, proposal_id: id }); return record(200);
    }
    c.refuse(400, 'MALFORMED', 'phase must be "claim" or "done"'); return record(400);
  }

  private async route(c: ExtraRouteContext): Promise<boolean> {
    if (this.approvalRoute(c)) return true;
    const m = /^\/api\/proposals\/([^/]+)(?:\/(approve|reject|resolve|withdraw))?$/.exec(c.path);
    if (!m) return false;
    const [, id, action] = m;
    if (!c.session) { c.refuse(401, 'UNAUTHENTICATED', 'Authentication required'); return true; }
    const p = this.proposals.get(decodeURIComponent(id));
    if (!p) { c.json(404, { error: 'Proposal not found' }); return true; }
    if (c.method === 'GET' && !action) {
      c.json(200, { proposal: { ...p, deviceDecisions: this.decisions.filter(d => d.proposalId === p.id) } });
      return true;
    }
    if (c.method !== 'POST' || !action) return false;
    const status = await this.decide(c, p, action as 'approve' | 'reject' | 'resolve' | 'withdraw');
    this.posts.push({ route: action, proposalId: p.id, body: c.body, status });
    return true;
  }

  private async decide(c: ExtraRouteContext, p: StubProposal, action: 'approve' | 'reject' | 'resolve' | 'withdraw'): Promise<number> {
    const refuse = (status: number, code: string, message = code): number => { c.refuse(status, code, message); return status; };
    const kind: DecisionKind = action === 'withdraw' ? 'withdraw'
      : action === 'approve' ? 'commit'
      : action === 'reject' ? 'reject'
      : c.body.action === 'commit' ? 'commit' : 'reject';
    // The fingerprint the call sends must be the proposal's (CONTENT_MISMATCH), like the real routes.
    const sent = c.body.proposalContentHash ?? c.body.content_hash;
    if (typeof sent === 'string' && sent !== p.contentHash) return refuse(409, 'CONTENT_MISMATCH');
    if (p.status !== 'pending') return refuse(409, 'PROPOSAL_ALREADY_DECIDED');
    const raw = c.body.device_decision as { decision: unknown; sig: unknown } | undefined;
    if (raw === undefined || raw === null) return refuse(400, 'DEVICE_DECISION_REQUIRED', 'a device session must send device_decision: { decision, sig }');
    const acc = [...this.as.accounts.values()].find(a => a.id === c.session!.userId)!;
    const state = await verifyChain({ expectedRootDid: acc.rootDid!, entries: this.as.chainEntries() });
    let decision: Decision;
    try {
      decision = await verifyDecision(raw, {
        chain: state,
        expect: { proposal_id: p.id, mandate_id: this.mandateId, action: p.tool, action_type: this.actionType, proposal_content_hash: p.contentHash },
      });
    } catch (e) {
      if (e instanceof DeviceKeysError) return refuse(e.code === 'MALFORMED' ? 400 : e.code === 'CHAIN_AHEAD' || e.code === 'PROPOSAL_MISMATCH' ? 409 : 403, e.code);
      throw e;
    }
    if (decision.decision !== kind) return refuse(400, 'DECISION_KIND_MISMATCH');
    if (decision.key_id !== c.session!.keyId) return refuse(403, 'DEVICE_MISMATCH');
    const nonceKey = `${c.session!.userId}:${decision.nonce}`;
    if (this.nonces.has(nonceKey)) return refuse(409, 'DECISION_NONCE_REUSED');
    this.nonces.add(nonceKey);
    this.decisions.push({
      proposalId: p.id, userId: c.session!.userId, keyId: decision.key_id, deviceLabel: 'This computer',
      decision, sig: raw.sig as string, asChainSeq: state.head.seq, storedAt: Math.floor(Date.now() / 1000),
    });
    if (kind === 'commit') {
      p.status = 'committed';
      c.json(200, action === 'approve'
        ? { receipt: { id: 'ticket-1' }, status: 'committed', approvedBy: {}, requiredApprovals: 1, approvedCount: 1 }
        : { status: 'committed', proposalId: p.id, committedDomains: [String(c.body.domain ?? 'u1')], remainingDomains: [] });
    } else {
      p.status = 'rejected';
      c.json(200, kind === 'withdraw'
        ? { status: 'rejected', proposalId: p.id, withdrawnBy: { userId: c.session!.userId, at: 0 } }
        : { status: 'rejected', proposalId: p.id });
    }
    return 200;
  }
}
