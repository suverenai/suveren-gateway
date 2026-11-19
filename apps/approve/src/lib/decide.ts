/**
 * Approve and reject on the phone (device-keys plan 4.2, 8; build step 12, phone part; DEC-47).
 *
 * The decision is the SAME object the gateway page signs (hap-core `suveren-device-decision`, built by `@hap/core/decision-input`, the
 * one implementation the control plane uses too). The phone signs it with its own non-extractable device key and sends it to the
 * Authority Server beside the fields the legacy call sends. A tap inside the session needs no check (DEC-47); a decision after the session
 * limit needs the check first, because the session itself needs it: the app asks for Face ID, opens a new session, and carries on.
 *
 * Every member is rebuilt here, at the moment of signing, never taken from the card or the button:
 *   - the proposal is read again with the phone's own session and must still wait, with the SAME fingerprint the person was shown
 *   - the mandate id and the action type are the ones the checks verified (card-checks.ts)
 *   - the chain head is the one this phone verified at sign-in
 *
 * Nothing is optimistic: the card shows its stamp only after the Authority Server answered the call.
 * Nothing the AI wrote can reach the Authority Server through here: the body holds the decision, the fingerprint and the fields the
 * person chose (domain, which button).
 */
import { buildDecision, b64uEncode, randomBytes, signedBytes } from '@hap/core/device-keys';
import { decisionBody, decisionFields, readProposalHead, type DecisionKind } from '@hap/core/decision-input';
import { ticketIdOf, type DecisionResult } from '@suveren/approval-card/lib/approval-flow';
import type { Proposal } from '@suveren/approval-card/types';
import type { AsApi } from './as-api';
import type { AccountStore } from './account-store';
import type { DeviceKeyStore } from './key-store';
import type { DeviceSession } from './session';
import type { ProposalReader } from './proposals';
import type { ReadyCard } from './card-checks';
import { errorText } from '../texts';

/** A decision that did not go through. `code` has a text of its own (texts.ts); `message` is that text, never the server's. */
export class DecideError extends Error {
  constructor(readonly code: string) {
    super(errorText(code));
    this.name = 'DecideError';
  }
}

export interface DeciderDeps {
  api: AsApi;
  session: DeviceSession;
  keys: DeviceKeyStore;
  accounts: AccountStore;
  reader: ProposalReader;
  now: () => number;
  /** Test seam: 16 random bytes, base64url. */
  nonce?: () => string;
}

export type PhoneDecision = 'approve' | 'reject';

export class PhoneDecider {
  constructor(private readonly d: DeciderDeps) {}

  /**
   * Decide one card. Resolves only after the Authority Server accepted the decision. Rejects with a {@link DecideError}.
   * A session that ended (here or at the server) is opened again with the person's check, once; the card is read again after it.
   */
  async decide(proposal: Proposal, ready: ReadyCard, what: PhoneDecision, extras: { shownHash?: string } = {}): Promise<DecisionResult> {
    let reopened = false;
    for (;;) {
      if (!this.d.session.bearer()) {
        // Over the phone's own limit: the check comes first (plan 8). One try only: a refused check ends the decision, nothing is sent.
        if (reopened) throw new DecideError('session_ended');
        const r = await this.d.session.open();
        if (!r.ok) throw new DecideError(r.code);
        reopened = true;
      }
      const out = await this.attempt(proposal, ready, what, extras);
      if (out !== 'session_ended') return out;
      // The server ended it (its own limit, not ours): drop it and loop to open a new one.
      if (reopened) throw new DecideError('session_ended');
    }
  }

  private async attempt(proposal: Proposal, ready: ReadyCard, what: PhoneDecision, extras: { shownHash?: string }): Promise<DecisionResult | 'session_ended'> {
    const d = this.d;
    const bearer = d.session.bearer();
    const open = d.session.current();
    const account = await d.accounts.read();
    if (!bearer || !open || !account) return 'session_ended';
    // A tap on a button is use of the session.
    d.session.noteUse();

    // 1. the request, read again: it must still wait, with the fingerprint the person was shown and the action type that was checked
    const fresh = await d.reader.get(proposal.id, true);
    if (!fresh.ok) {
      if (fresh.code === 'session_ended') return 'session_ended';
      throw new DecideError(fresh.code === 'as_unreachable' ? 'as_unreachable' : 'generic');
    }
    const head = readProposalHead(fresh.data, proposal.id);
    if (!head.ok) throw new DecideError(head.code === 'proposal_not_pending' ? 'not_pending' : 'as_answer_invalid');
    if (head.head.contentHash !== ready.contentHash || head.head.actionType !== ready.facts.actionType) throw new DecideError('content_changed');

    // 2. the decision, named against the head this phone verified at sign-in, signed with the device key
    const kind: DecisionKind = what === 'approve' ? 'commit' : 'reject';
    const decision = buildDecision(decisionFields({
      signer: { rootDid: account.root_did, keyId: account.key_id, chainSeq: open.chain.head.seq, chainHead: open.chain.head.hash },
      proposal: { id: head.head.id, tool: head.head.tool },
      facts: ready.facts,
      kind,
      contentHash: ready.contentHash,
      decidedAt: d.now(),
      nonce: (d.nonce ?? (() => b64uEncode(randomBytes(16))))(),
    }));
    const sig = b64uEncode(await d.keys.sign(signedBytes(decision)));

    // 3. the call: `approve`/`reject` for an above-cap approver, `resolve` for the person's own queue
    const route = ready.route;
    const extra: Record<string, unknown> = { ...(extras.shownHash ? { shown_hash: extras.shownHash } : {}) };
    if (route.kind === 'domain') { extra.domain = route.domain; extra.action = kind === 'commit' ? 'commit' : 'reject'; }
    if (what === 'reject') extra.outcome = 'rejected';
    const path = route.kind === 'approver' ? what : 'resolve';
    const reply = await d.api.decide(head.head.id, path, decisionBody({ extras: extra, contentHash: ready.contentHash, decision, sig }), bearer);
    if (!reply.ok) {
      if (reply.status === 401 || reply.code === 'SESSION_EXPIRED') { d.session.lost(); return 'session_ended'; }
      if (reply.status === 0) throw new DecideError('as_unreachable');
      throw new DecideError(DECISION_CODES.has(reply.code.toLowerCase()) ? reply.code.toLowerCase() : 'generic');
    }
    return what === 'approve' ? { ticketId: ticketIdOf((reply.data as { receipt?: unknown }).receipt) } : {};
  }
}

/** The Authority Server's refusal codes of a decision that have a sentence of their own (texts.ts); every other code reads as the generic one. */
const DECISION_CODES = new Set([
  'device_decision_required', 'device_mismatch', 'not_active', 'bad_signature', 'proposal_mismatch', 'action_type_unknown',
  'chain_ahead', 'fork', 'decision_nonce_reused', 'device_decision_exists', 'content_mismatch', 'proposal_already_decided',
  'mandate_revoked', 'mandate_expired', 'wrong_root', 'check_required',
]);
