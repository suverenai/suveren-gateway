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

  private async route(c: ExtraRouteContext): Promise<boolean> {
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
      decision, sig: raw.sig as string, asChainSeq: state.head.seq, storedAt: 0,
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
