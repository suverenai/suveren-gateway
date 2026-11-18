/**
 * A decision made on the gateway page, signed with this computer's device key
 * (device-keys plan 4.2, 6.3, 20.17 / DEC-47, DEC-39; build step 12, computer part).
 *
 *   approve (commit), reject, change-needed (a reject) and withdraw all go the same way:
 *     1. the proposal is read from the Authority Server with this computer's own device
 *        session. Every signed field comes from THAT copy and from the gateway's own
 *        mandate and manifest (the MCP server's `proposal-facts`), never from the request
 *        body: the page can ask for a decision, it cannot say what is signed.
 *     2. for a commit the content is opened on this computer and hashed again; the hash
 *        must be the proposal's. Nothing is signed for content this computer cannot show.
 *        A reject or withdrawal of content this computer cannot read names the proposal's
 *        own fingerprint (it claims nothing about having seen the content).
 *     3. the decision object is built with hap-core, named against the chain head this
 *        gateway verified at sign-in, and signed with the device key.
 *     4. the Authority Server gets the decision as `device_decision: { decision, sig }`
 *        beside the same fields the legacy call sends. Its answer is passed on unchanged.
 *
 * Approving is a click inside the page session (no check, DEC-47); a reject and a
 * withdrawal need no confirmation either (DEC-39). The page-session limits are enforced by
 * the router in front of this (routes/device-decision.ts), never by the page.
 *
 * Never logs a body, a signature or a nonce. Codes are neutral; the words are the
 * maintainer's (O19).
 */

import { randomBytes } from 'node:crypto';
import type { Vault } from './vault';
import { deviceKeys } from './device-keys-lazy';
import type { DeviceChainStore } from './device-chain-store';
import { DeviceAsClient, AsUnreachableError } from './device-as-client';
import { AsTlsMismatchError } from './as-tls-pin';
import { isBearerCredential } from './as-credential';
import { loadDeviceSigningKey, loadOrGenerateKeyPair } from './e2e-key-manager';
import { computeProposalContentHash, decryptProposalContent, type ProposalContentWire } from './content-crypto';

export type DecisionRoute = 'approve' | 'reject' | 'resolve' | 'withdraw';
export const DECISION_ROUTES: readonly DecisionRoute[] = ['approve', 'reject', 'resolve', 'withdraw'];
export type DecisionKind = 'commit' | 'reject' | 'withdraw';

/** A refusal with a neutral code. */
export class DecisionRefusal extends Error {
  constructor(readonly status: number, readonly code: string, readonly extra: Record<string, unknown> = {}) {
    super(code);
    this.name = 'DecisionRefusal';
  }
}

/** What the gateway itself knows about a proposal that the Authority Server's read does not carry. */
export interface ProposalFacts {
  /** The signed `mandate_id` of the mandate the Authority Server checks the proposal against. */
  mandateId: string;
  /** The action type the connector's manifest (or this gateway's own submission) declares. */
  actionType: string;
}

export interface DeviceDecisionDeps {
  vault: Vault;
  store: DeviceChainStore;
  client: DeviceAsClient;
  /** Ask the MCP server (its signed mandate, its manifests). Throws when it cannot say. */
  facts: (p: { proposalId: string; authorizationId: string; tool: string }) => Promise<ProposalFacts>;
  /** Told after the Authority Server accepted a decision (events, the executor nudge). */
  onDecided?: (route: DecisionRoute, kind: DecisionKind) => void;
  /** Epoch seconds. */
  now?: () => number;
}

/** The body fields passed on to the Authority Server as the page sent them. None of them is signed. */
const PASS_THROUGH = ['domain', 'outcome', 'note', 'note_encrypted', 'reason', 'shown_hash'] as const;

interface ProposalRead {
  id: string;
  authorizationId: string;
  tool: string;
  status: string;
  contentHash: string;
  toolArgs?: Record<string, unknown> | null;
  content?: ProposalContentWire | null;
}

const HASH = /^sha256:[0-9a-f]{64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export class DeviceDecisions {
  private readonly now: () => number;

  constructor(private readonly d: DeviceDecisionDeps) {
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Which decision a route performs. `resolve` takes it from the page's `action`, which is also what is forwarded. */
  static kindOf(route: DecisionRoute, body: Record<string, unknown>): DecisionKind {
    if (route === 'approve') return 'commit';
    if (route === 'reject') return 'reject';
    if (route === 'withdraw') return 'withdraw';
    if (body.action === 'commit') return 'commit';
    if (body.action === 'reject') return 'reject';
    throw new DecisionRefusal(400, 'bad_request');
  }

  async decide(proposalId: string, route: DecisionRoute, rawBody: unknown): Promise<{ status: number; body: unknown }> {
    const { d } = this;
    const body: Record<string, unknown> = isObj(rawBody) ? rawBody : {};
    if (!str(proposalId) || proposalId.length > 128) throw new DecisionRefusal(400, 'bad_request');
    const kind = DeviceDecisions.kindOf(route, body);

    if (!d.vault.isUnlocked()) throw new DecisionRefusal(401, 'locked');
    let stored;
    try { stored = d.store.read(); } catch { throw new DecisionRefusal(500, 'chain_unreadable'); }
    if (!stored) throw new DecisionRefusal(409, 'not_set_up');
    const credential = d.vault.getSpCookie();
    // A device chain talks to the Authority Server with its device session only.
    if (!isBearerCredential(credential)) throw new DecisionRefusal(409, 'not_signed_in');
    const key = loadDeviceSigningKey(d.vault);
    if (!key) throw new DecisionRefusal(409, 'key_missing');
    const dk = await deviceKeys();
    if ((await dk.keyIdOf(key.publicKey)) !== stored.keyId) throw new DecisionRefusal(409, 'key_mismatch');

    // 1. the gateway's own copy of the proposal
    const proposal = await this.readProposal(proposalId, credential);
    if (proposal.status !== 'pending') throw new DecisionRefusal(409, 'proposal_not_pending');

    // 2. the fingerprint of what this computer can show
    const contentHash = await this.fingerprint(proposal, kind);
    // 2b. what the PERSON saw is what is signed. The page sends the hash of the content it decrypted and
    //     showed; a commit requires it and it must be the hash computed here from the proposal this call
    //     read. An Authority Server that shows the page content A and this call content B is caught here.
    //     A reject or withdrawal compares it when the page sent one.
    const shown = body.proposalContentHash ?? body.content_hash;
    if (shown !== undefined && shown !== null && (typeof shown !== 'string' || shown !== contentHash)) throw new DecisionRefusal(409, 'content_mismatch');
    if (kind === 'commit' && typeof shown !== 'string') throw new DecisionRefusal(409, 'content_not_shown');

    // 3. what only this gateway can say about the proposal
    let facts: ProposalFacts;
    try {
      facts = await d.facts({ proposalId: proposal.id, authorizationId: proposal.authorizationId, tool: proposal.tool });
    } catch {
      throw new DecisionRefusal(502, 'facts_unavailable');
    }
    if (!isObj(facts) || !str(facts.mandateId) || !str(facts.actionType)) throw new DecisionRefusal(409, 'facts_unavailable');

    // 4. sign
    const decision = dk.buildDecision({
      approver_did: stored.rootDid,
      key_id: stored.keyId,
      chain_seq: stored.head.seq,
      chain_head: stored.head.hash,
      proposal_id: proposal.id,
      mandate_id: facts.mandateId,
      action: proposal.tool,
      action_type: facts.actionType,
      decision: kind,
      // The gateway cannot see a content binding here; a decision names the proposal's fingerprint for both.
      content_hash: contentHash,
      proposal_content_hash: contentHash,
      decided_at: this.now(),
      nonce: randomBytes(16).toString('base64url'),
    });
    const sig = await dk.signObject(decision, key.privateSeed);

    // 5. the same fields the legacy call sends, plus the decision. The page's copy of the
    //    fingerprint was compared above and is replaced by the signed one; any decision it sent is never forwarded.
    const out: Record<string, unknown> = {};
    for (const k of PASS_THROUGH) if (body[k] !== undefined) out[k] = body[k];
    if (route === 'resolve') out.action = kind === 'commit' ? 'commit' : 'reject';
    out.content_hash = contentHash;
    out.proposalContentHash = contentHash;
    out.device_decision = { decision, sig };

    let reply;
    try {
      reply = await d.client.call('POST', `/api/proposals/${encodeURIComponent(proposal.id)}/${route}`, { body: out, bearer: credential });
    } catch (err) {
      if (err instanceof AsTlsMismatchError) throw new DecisionRefusal(502, 'as_tls_mismatch');
      if (err instanceof AsUnreachableError) throw new DecisionRefusal(502, 'as_unreachable');
      throw err;
    }
    if (reply.status >= 200 && reply.status < 300) d.onDecided?.(route, kind);
    return { status: reply.status, body: reply.body };
  }

  private async readProposal(proposalId: string, credential: string): Promise<ProposalRead> {
    let reply;
    try {
      reply = await this.d.client.call('GET', `/api/proposals/${encodeURIComponent(proposalId)}`, { bearer: credential });
    } catch (err) {
      if (err instanceof AsTlsMismatchError) throw new DecisionRefusal(502, 'as_tls_mismatch');
      if (err instanceof AsUnreachableError) throw new DecisionRefusal(502, 'as_unreachable');
      throw err;
    }
    if (reply.status === 404 || reply.status === 403) throw new DecisionRefusal(404, 'proposal_unknown');
    if (reply.status !== 200 || !isObj(reply.body) || !isObj(reply.body.proposal)) throw new DecisionRefusal(502, 'as_answer_invalid');
    const p = reply.body.proposal;
    // The proposal read must be the one asked for: a reply for another id signs nothing.
    if (p.id !== proposalId || !str(p.authorizationId) || !str(p.tool) || !str(p.status) || typeof p.contentHash !== 'string' || !HASH.test(p.contentHash)) {
      throw new DecisionRefusal(502, 'as_answer_invalid');
    }
    return p as unknown as ProposalRead;
  }

  /** The hash of the content this computer opened; the proposal's own fingerprint where it need not (and cannot) open it. */
  private async fingerprint(p: ProposalRead, kind: DecisionKind): Promise<string> {
    const plain = await this.openContent(p);
    if (plain) {
      if (computeProposalContentHash(plain) !== p.contentHash) throw new DecisionRefusal(409, 'content_mismatch');
      return p.contentHash;
    }
    // Nothing can be approved that this computer cannot show.
    if (kind === 'commit') throw new DecisionRefusal(409, 'content_unreadable');
    return p.contentHash;
  }

  private async openContent(p: ProposalRead): Promise<Record<string, unknown> | null> {
    if (isObj(p.toolArgs)) return p.toolArgs;
    if (!isObj(p.content)) return null;
    const me = this.d.vault.getSessionUser();
    if (!me) return null;
    try {
      const kp = await loadOrGenerateKeyPair(this.d.vault);
      const text = await decryptProposalContent({ ...(p.content as ProposalContentWire), proposalContentHash: p.contentHash }, me.id, kp.privateKey, me.did);
      const parsed: unknown = JSON.parse(text);
      return isObj(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
