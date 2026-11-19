import { describe, it, expect } from 'vitest';
import { b64uDecode, jcs, sha256Hash, utf8 } from '@hap/core/device-keys';
import { checkCard, type ReadyCard } from './card-checks';
import { DecideError } from './decide';
import { cardWorld, PROPOSAL_ID, MANDATE_ID } from './card-world';
import { IDLE_LIMIT } from './session';
import { errorText } from '../texts';

type World = Awaited<ReturnType<typeof cardWorld>>;

async function ready(w: World): Promise<ReadyCard> {
  const c = await checkCard(w.rt.checks, w.as.byId.get(PROPOSAL_ID) as never);
  if (!c.ok) throw new Error(`not ready: ${c.reason}`);
  return c.ready;
}
const row = (w: World) => w.as.byId.get(PROPOSAL_ID) as never;

describe('approve and reject on the phone (step 12, phone part; DEC-47)', () => {
  it('approve inside the session: a tap, no check, a decision the server verified under the phone\'s key', async () => {
    const w = await cardWorld();
    const r = await ready(w);
    const touches = (w.rt.check as unknown as { proved: string[] }).proved.length;
    const result = await w.rt.decider.decide(row(w), r, 'approve');
    expect(result).toEqual({ ticketId: 'tk-1' });
    // no check for a tap (DEC-47): the passkey was not asked again
    expect((w.rt.check as unknown as { proved: string[] }).proved.length).toBe(touches);
    const d = w.as.decisions[0];
    expect(d.route).toBe('resolve');
    expect(d.body.action).toBe('commit');
    expect(d.body.domain).toBe('owner');
    expect(d.decision).toMatchObject({
      typ: 'suveren-device-decision', decision: 'commit', proposal_id: PROPOSAL_ID, mandate_id: MANDATE_ID, action: 'email__send_message', action_type: 'send',
      approver_did: w.account.root_did, key_id: w.account.key_id, content_hash: w.proposal.contentHash, proposal_content_hash: w.proposal.contentHash,
    });
    // the decision names the chain head the phone verified at sign-in
    expect(d.decision.chain_seq).toBe(w.rt.session.current()!.chain.head.seq);
    expect(d.decision.chain_head).toBe(w.rt.session.current()!.chain.head.hash);
    // both fingerprints travel under both names; the fingerprint is the hash of the content THIS phone opened
    expect(d.body.proposalContentHash).toBe(w.proposal.contentHash);
    expect(await sha256Hash(utf8(jcs(w.args)))).toBe(w.proposal.contentHash);
    // the server is now the truth
    expect((w.as.byId.get(PROPOSAL_ID) as { status: string }).status).toBe('committed');
  });

  it('reject: a decision of kind reject, outcome "rejected", no ticket', async () => {
    const w = await cardWorld();
    const result = await w.rt.decider.decide(row(w), await ready(w), 'reject');
    expect(result).toEqual({});
    expect(w.as.decisions[0].decision.decision).toBe('reject');
    expect(w.as.decisions[0].body).toMatchObject({ action: 'reject', outcome: 'rejected', domain: 'owner' });
  });

  it('an above-cap approver uses the approve and reject routes, with no domain', async () => {
    const w = await cardWorld({ pendingApprovers: ['user-1'] });
    await w.rt.decider.decide(row(w), await ready(w), 'approve');
    expect(w.as.decisions[0].route).toBe('approve');
    expect(w.as.decisions[0].body.domain).toBeUndefined();
    expect(w.as.decisions[0].body.action).toBeUndefined();
  });

  it('the signature is the phone\'s own: a second decision is a new nonce, and the same one sent twice is refused by the server', async () => {
    const w = await cardWorld();
    const r = await ready(w);
    await w.rt.decider.decide(row(w), r, 'approve');
    const first = w.as.decisions[0];
    expect(b64uDecode(first.body.device_decision.sig).length).toBe(64);
    // a replay of the very same body is refused (the proposal is decided and the nonce is used)
    const replay = await w.rt.api.decide(PROPOSAL_ID, 'resolve', first.body, w.rt.session.bearer()!);
    expect(replay.ok).toBe(false);
  });

  it('the card is not the source of what is signed: a fingerprint changed after the person looked stops the decision, nothing is sent', async () => {
    const w = await cardWorld();
    const r = await ready(w);
    (w.as.byId.get(PROPOSAL_ID) as { contentHash: string }).contentHash = 'sha256:' + '3'.repeat(64);
    const e = await w.rt.decider.decide(row(w), r, 'approve').catch((x: Error) => x);
    expect(e).toBeInstanceOf(DecideError);
    expect((e as DecideError).code).toBe('content_changed');
    expect((e as DecideError).message).toBe(errorText('content_changed'));
    expect(w.as.decisions.length).toBe(0);
    expect(w.as.calls.some((c) => c.method === 'POST' && c.path.includes('/resolve'))).toBe(false);
  });

  it('a request that was decided meanwhile (by another device) is not decided again', async () => {
    const w = await cardWorld();
    const r = await ready(w);
    (w.as.byId.get(PROPOSAL_ID) as { status: string }).status = 'rejected';
    const e = await w.rt.decider.decide(row(w), r, 'approve').catch((x: Error) => x);
    expect((e as DecideError).code).toBe('not_pending');
    expect(w.as.decisions.length).toBe(0);
  });

  it('a decision after the phone\'s own limit asks for the touch first, then goes on with the same card', async () => {
    const w = await cardWorld();
    const r = await ready(w);
    const proved = () => (w.rt.check as unknown as { proved: string[] }).proved.length;
    const before = proved();
    w.as.clock += IDLE_LIMIT + 60; // an hour without use
    expect(w.rt.session.bearer()).toBeNull();
    const result = await w.rt.decider.decide(row(w), r, 'approve');
    expect(result.ticketId).toBeDefined();
    expect(proved()).toBe(before + 1); // the one touch of the new session; none for the tap itself
    expect(w.as.decisions.length).toBe(1);
  });

  it('a decision the SERVER refuses after its own limit asks for the touch, then goes on (the server is the one that ended it)', async () => {
    const w = await cardWorld();
    const r = await ready(w);
    const proved = () => (w.rt.check as unknown as { proved: string[] }).proved.length;
    const before = proved();
    w.as.expireSessionOnDecision = true;
    const result = await w.rt.decider.decide(row(w), r, 'approve');
    expect(result.ticketId).toBeDefined();
    expect(proved()).toBe(before + 1);
    expect(w.as.decisions.length).toBe(1);
  });

  it('a touch that is cancelled ends the decision: nothing is sent', async () => {
    const w = await cardWorld();
    const r = await ready(w);
    w.as.clock += IDLE_LIMIT + 60;
    (w.rt.check as unknown as { cancelNext: boolean }).cancelNext = true;
    const e = await w.rt.decider.decide(row(w), r, 'approve').catch((x: Error) => x);
    expect(e).toBeInstanceOf(DecideError);
    expect(w.as.decisions.length).toBe(0);
    expect(w.as.calls.some((c) => c.method === 'POST' && c.path.includes('/resolve'))).toBe(false);
  });

  it('a session that ends again right after the touch does not loop: one touch, then it stops', async () => {
    const w = await cardWorld();
    const r = await ready(w);
    w.as.clock += IDLE_LIMIT + 60;
    // the server ends every session it opens at the next decision call
    const orig = w.as.call.bind(w.as);
    w.as.call = async (m, p, o) => { if (p.includes('/resolve')) w.as.expireSessionOnDecision = true; return orig(m, p, o); };
    const e = await w.rt.decider.decide(row(w), r, 'approve').catch((x: Error) => x);
    expect((e as DecideError).code).toBe('session_ended');
    expect(w.as.decisions.length).toBe(0);
  });

  it('what the server refuses is said in the phone\'s own words, never the server\'s code or message', async () => {
    const w = await cardWorld();
    const r = await ready(w);
    w.as.refuseDecision = { status: 409, code: 'PROPOSAL_MISMATCH' };
    const e = await w.rt.decider.decide(row(w), r, 'approve').catch((x: Error) => x);
    expect((e as Error).message).toBe(errorText('proposal_mismatch'));
    expect((e as Error).message).not.toMatch(/PROPOSAL_MISMATCH|x$/);
    w.as.refuseDecision = { status: 500, code: 'SOMETHING_NEW' };
    const g = await w.rt.decider.decide(row(w), r, 'approve').catch((x: Error) => x);
    expect((g as Error).message).toBe(errorText('generic'));
    expect(w.as.decisions.length).toBe(0);
  });

  it('a server that cannot be reached is said so, and nothing is shown as decided', async () => {
    const w = await cardWorld();
    const r = await ready(w);
    // the request is read again first: the failure shows there
    w.as.down = true;
    const e = await w.rt.decider.decide(row(w), r, 'approve').catch((x: Error) => x);
    expect((e as DecideError).code).toBe('as_unreachable');
    expect((w.as.byId.get(PROPOSAL_ID) as { status: string }).status).toBe('pending');
  });

  it('a removed device cannot decide: the server refuses it and the phone says so', async () => {
    const w = await cardWorld();
    const r = await ready(w);
    w.as.refuseDecision = { status: 403, code: 'NOT_ACTIVE' };
    const e = await w.rt.decider.decide(row(w), r, 'reject').catch((x: Error) => x);
    expect((e as DecideError).code).toBe('not_active');
  });

  it('a tap counts as use of the session (an hour of no use ends it; a decision restarts the clock)', async () => {
    const w = await cardWorld();
    const r = await ready(w);
    w.as.clock += IDLE_LIMIT - 60;
    await w.rt.decider.decide(row(w), r, 'reject');
    w.as.clock += IDLE_LIMIT - 60;
    expect(w.rt.session.bearer()).not.toBeNull();
  });

  it('every decision text is plain: no code, no pronoun, no server word', () => {
    for (const c of ['not_pending', 'content_changed', 'content_mismatch', 'device_decision_required', 'device_mismatch', 'not_active', 'wrong_root', 'bad_signature', 'fork', 'chain_ahead', 'proposal_mismatch', 'action_type_unknown', 'decision_nonce_reused', 'device_decision_exists', 'proposal_already_decided', 'mandate_revoked', 'mandate_expired', 'check_required']) {
      const t = errorText(c);
      expect(t, c).not.toBe(errorText('generic'));
      expect(t, c).not.toMatch(/\b(he|she|his|hers?|him)\b/i);
      expect(t, c).not.toMatch(/authority server|[A-Z]{3,}_[A-Z]{3,}/);
    }
  });
});
