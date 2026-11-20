/**
 * What every device builds the same way when it decides a proposal (device-keys plan 4.2, build step 12).
 *
 * The control plane (the gateway page's computer) and the phone approval app both build a `suveren-device-decision`, sign it with their
 * own device key and send it to the Authority Server beside the fields the legacy call sends. The signing differs (a seed in the
 * vault, a non-extractable WebCrypto key); everything that decides WHAT is signed does not, so it lives here once:
 *
 *   - {@link readProposalHead}  the proposal as the Authority Server served it, checked before anything is signed from it
 *   - {@link decisionFields}    the members of the decision: all of them from the proposal, the verified mandate and the
 *                               verified chain head, never from a request body or a button
 *   - {@link decisionBody}      the request body: the signed decision plus the fingerprint, nothing the person typed besides
 *                               the fields named in `extras`
 *
 * Pure: no node imports and no runtime import of hap-core (the caller passes the result to `buildDecision`).
 */
import type { Decision, DecisionKind } from '@humanagencyp/hap-core/device-keys';

export type { DecisionKind };

/** `sha256:` and 64 lower-case hex digits: the fingerprint of a proposal's content. */
export const PROPOSAL_HASH = /^sha256:[0-9a-f]{64}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** The members of a proposal that a decision is built from. */
export interface ProposalHead {
  id: string;
  authorizationId: string;
  tool: string;
  status: string;
  contentHash: string;
  /** What the Authority Server stored with the proposal (validated there against the profile); absent on an old row. */
  actionType?: string;
}

export type ProposalHeadResult =
  | { ok: true; head: ProposalHead }
  | { ok: false; code: 'as_answer_invalid' | 'proposal_not_pending' };

/**
 * Read the proposal the Authority Server served for `askedId`. A reply for another id, or one without the members a decision names,
 * signs nothing (`as_answer_invalid`); a proposal that is not waiting any more is `proposal_not_pending`.
 */
export function readProposalHead(p: unknown, askedId: string): ProposalHeadResult {
  if (!isObj(p) || p.id !== askedId || !str(p.authorizationId) || !str(p.tool) || !str(p.status) || typeof p.contentHash !== 'string' || !PROPOSAL_HASH.test(p.contentHash)) {
    return { ok: false, code: 'as_answer_invalid' };
  }
  if (p.status !== 'pending') return { ok: false, code: 'proposal_not_pending' };
  const actionType = str(p.actionType) ? p.actionType : str(p.action_type) ? p.action_type : undefined;
  return { ok: true, head: { id: p.id, authorizationId: p.authorizationId, tool: p.tool, status: p.status, contentHash: p.contentHash, ...(actionType ? { actionType } : {}) } };
}

export interface DecisionInput {
  /** The person's root DID, this device's key id, and the chain head this device verified (the decision names it, 3.3 rule 3). */
  signer: { rootDid: string; keyId: string; chainSeq: number; chainHead: string };
  proposal: Pick<ProposalHead, 'id' | 'tool'>;
  /** From the SIGNED mandate and the proposal's stored action type. */
  facts: { mandateId: string; actionType: string };
  kind: DecisionKind;
  /** The fingerprint of the content this device opened and hashed itself (a commit), or the proposal's own fingerprint (a reject or withdrawal of content it cannot read). */
  contentHash: string;
  /** Epoch seconds. */
  decidedAt: number;
  /** 16 random bytes, base64url. */
  nonce: string;
}

/** The fields to hand to hap-core's `buildDecision`. Both fingerprints name the same value: a device cannot see a content binding. */
export function decisionFields(i: DecisionInput): Omit<Decision, 'typ' | 'v'> {
  return {
    approver_did: i.signer.rootDid,
    key_id: i.signer.keyId,
    chain_seq: i.signer.chainSeq,
    chain_head: i.signer.chainHead,
    proposal_id: i.proposal.id,
    mandate_id: i.facts.mandateId,
    action: i.proposal.tool,
    action_type: i.facts.actionType,
    decision: i.kind,
    content_hash: i.contentHash,
    proposal_content_hash: i.contentHash,
    decided_at: i.decidedAt,
    nonce: i.nonce,
  };
}

/**
 * The body of the call to the Authority Server: the fields the person chose (`extras`: domain, outcome, a sealed note, the shown
 * fingerprint, `action` on `resolve`), the fingerprint under both names the Authority Server reads, and the decision. A decision the
 * caller's extras carry is never forwarded; the signed one replaces it.
 */
export function decisionBody(i: { extras: Record<string, unknown>; contentHash: string; decision: Decision; sig: string }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(i.extras)) if (v !== undefined && k !== 'device_decision' && k !== 'content_hash' && k !== 'proposalContentHash') out[k] = v;
  out.content_hash = i.contentHash;
  out.proposalContentHash = i.contentHash;
  out.device_decision = { decision: i.decision, sig: i.sig };
  return out;
}
