/**
 * Ending a mandate on the phone (mandate-end.ts), against the card world: a mandate signed by the fake Authority Server under the pinned
 * key, granted by this phone with its check; FakeAs stores a posted revoke only when hap-core verifies it against the newest grant.
 */
import { describe, it, expect } from 'vitest';
import { verifyGrant, buildGrant, signedBytes, b64uEncode, randomBytes, rootKeyFromRecoveryCode, buildReceipt, grantHash, signObject, type MandateGrant } from '@hap/core/device-keys';
import { GRANT_FIXED_MEMBERS } from '@hap/core/mandate-grant';
import { PeerComputer, addWithRoot } from './test-kit';
import { cardWorld, AUTHZ, MANDATE_ID, PROFILE_ID } from './card-world';
import { readOwnMandates, EndDriver } from './mandate-end';

async function world(o: Parameters<typeof cardWorld>[0] = {}) {
  const w = await cardWorld(o);
  w.as.mine = [{ authorization_id: AUTHZ, profileId: PROFILE_ID, title: 'Purchases', status: 'active', mandates: [{ domain: 'owner', expiresAt: w.payload.expires_at }] }];
  const deps = { keys: w.rt.keys, api: w.rt.api, accounts: w.rt.accounts, session: w.rt.session, now: w.as.now };
  return { ...w, deps };
}

describe('ending a mandate on the phone', () => {
  it('lists this person\'s granted mandate with its newest verified version', async () => {
    const w = await world();
    const r = await readOwnMandates(w.deps);
    expect(r).toMatchObject({ ok: true, items: [{ authorizationId: AUTHZ, mandateId: MANDATE_ID, version: 1, title: 'Purchases' }] });
  });

  it('does not offer a mandate without a grant that verifies, nor someone else\'s, nor a revoked one', async () => {
    expect(await readOwnMandates((await world({ grant: { none: true } })).deps)).toMatchObject({ ok: true, items: [] });
    expect(await readOwnMandates((await world({ ownerDid: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK' })).deps)).toMatchObject({ ok: true, items: [] });
    expect(await readOwnMandates((await world({ grant: { noCheck: true } })).deps)).toMatchObject({ ok: true, items: [] });
    const w = await world();
    w.as.mine[0].status = 'revoked';
    expect(await readOwnMandates(w.deps)).toMatchObject({ ok: true, items: [] });
  });

  it('the revoke is signed by this phone, without a touch, over the members of the newest grant; it verifies and is final', async () => {
    const w = await world();
    const r = await readOwnMandates(w.deps);
    if (!r.ok) throw new Error(r.code);
    const before = w.rt.check.proved.length;
    const d = new EndDriver(w.deps);
    d.open(r.items[0]);
    await d.end();
    expect(d.get()).toMatchObject({ step: 'done' });
    expect(w.rt.check.proved.length, 'no touch').toBe(before);
    const posted = w.as.postedGrants.at(-1)!;
    expect(posted.op).toBe('revoke');
    expect(posted.check).toBeNull();
    const g = posted.grant as MandateGrant;
    expect(g.key_id).toBe(w.account.key_id);
    await verifyGrant({ grant: g, sig: posted.sig }, { chain: await w.as.state(), mandateFields: r.items[0].fields, expect: { ops: ['revoke'], mandate_id: MANDATE_ID, mandate_version: 1 } });
    // once revoked it is not offered again
    expect(await readOwnMandates(w.deps)).toMatchObject({ ok: true, items: [] });
  });

  it('a refusal by the Authority Server is said; the mandate still runs', async () => {
    const w = await world();
    const r = await readOwnMandates(w.deps);
    if (!r.ok) throw new Error(r.code);
    const orig = w.as.call.bind(w.as);
    w.as.call = async (m, p, o) => (m === 'POST' && p.endsWith('/grants') ? { status: 409, body: { approved: false, errors: [{ code: 'MANDATE_REVOKED', message: 'x' }] } } : orig(m, p, o));
    const d = new EndDriver(w.deps);
    d.open(r.items[0]);
    await d.end();
    expect(d.get()).toMatchObject({ step: 'failed', error: expect.stringContaining('still runs') });
  });
});

describe('"ended on <device>" (mockup F2): only a revoke that verifies against this phone\'s chain', () => {
  /** Another computer of this person ends the mandate: a revoke signed with its device key over the newest grant's members. */
  async function endedOnComputer(tamper = false) {
    const w = await world();
    const root = await rootKeyFromRecoveryCode(w.recoveryCode);
    const computer = await PeerComputer.create('Office Mac');
    await addWithRoot(w.as, root, computer);
    await w.rt.session.open();
    const state = await w.as.state();
    const top = w.as.grants.get(MANDATE_ID)![0];
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(top.grant as Record<string, unknown>)) if (!(GRANT_FIXED_MEMBERS as readonly string[]).includes(k)) fields[k] = v;
    const g = buildGrant({ op: 'revoke', owner_did: w.account.root_did, key_id: computer.keyId, chain_seq: state.head.seq, chain_head: state.head.hash, mandate_id: MANDATE_ID, mandate_version: 1, granted_at: w.as.now(), nonce: b64uEncode(randomBytes(16)) }, fields);
    let sig = b64uEncode(await computer.sign(signedBytes(g)));
    if (tamper) sig = sig.slice(0, -4) + 'AAAA';
    w.as.grants.set(MANDATE_ID, [...w.as.grants.get(MANDATE_ID)!, { mandate_version: 1, op: 'revoke', grant: g, sig, check: null }]);
    w.as.mine[0].status = 'revoked';
    return w;
  }

  it('names the computer that ended it', async () => {
    const w = await endedOnComputer();
    expect(await readOwnMandates(w.deps)).toMatchObject({ ok: true, items: [], ended: [{ title: 'Purchases', by: 'Office Mac' }] });
  });

  it('a revoke row that does not verify says nothing', async () => {
    const w = await endedOnComputer(true);
    expect(await readOwnMandates(w.deps)).toMatchObject({ ok: true, items: [], ended: [] });
  });

  it('a revoke made on this phone is not "ended elsewhere"', async () => {
    const w = await world();
    const r = await readOwnMandates(w.deps);
    if (!r.ok) throw new Error(r.code);
    const d = new EndDriver(w.deps);
    d.open(r.items[0]);
    await d.end();
    w.as.mine[0].status = 'revoked';
    expect(await readOwnMandates(w.deps)).toMatchObject({ ok: true, ended: [] });
  });
});

// On-hold mockup v2 (Andreas 2026-11-24, DEC-109/110/111): what the phone's own check holds back, and a give no computer took in.
describe('on hold on the phone (mockup v2)', () => {
  it('a mandate without any grant is held back as "given without your touch"; one with a grant that does not verify, by its check code', async () => {
    const none = await readOwnMandates((await world({ grant: { none: true } })).deps);
    expect(none).toMatchObject({ ok: true, items: [], held: [{ authorizationId: AUTHZ, title: 'Purchases', code: 'mandate_not_granted' }] });
    const noCheck = await readOwnMandates((await world({ grant: { noCheck: true } })).deps);
    expect(noCheck.ok && noCheck.held.length).toBe(1);
    expect(noCheck.ok && noCheck.held[0].code).toBeTruthy();
  });

  it('given here, no computer receipt after 10 minutes: names the computer; before 10 minutes or with nothing to name: nothing', async () => {
    const w = await world();
    const root = await rootKeyFromRecoveryCode(w.recoveryCode);
    await addWithRoot(w.as, root, await PeerComputer.create('Office Mac'));
    await w.rt.session.open();
    const top = w.as.grants.get(MANDATE_ID)![0];
    const at = (top.grant as { granted_at: number }).granted_at;
    const early = await readOwnMandates({ ...w.deps, now: () => at + 60 });
    expect(early.ok && early.items[0].notReceivedBy).toBeNull();
    const late = await readOwnMandates({ ...w.deps, now: () => at + 12 * 60 });
    expect(late).toMatchObject({ ok: true, items: [{ notReceivedBy: 'Office Mac', givenHereAt: at }] });
    const day = await readOwnMandates({ ...w.deps, now: () => at + 2 * 86400 });
    expect(day.ok && day.items.length ? day.items[0].notReceivedBy : null).toBeFalsy();
  });

  it('a computer receipt that verifies: no note', async () => {
    const w = await world();
    const root = await rootKeyFromRecoveryCode(w.recoveryCode);
    const computer = await PeerComputer.create('Office Mac');
    await addWithRoot(w.as, root, computer);
    await w.rt.session.open();
    const state = await w.as.state();
    const top = w.as.grants.get(MANDATE_ID)![0];
    const g = top.grant as unknown as MandateGrant;
    const r = buildReceipt({ mandate_id: MANDATE_ID, mandate_version: 1, grant_hash: await grantHash(g), key_id: computer.keyId, chain_seq: state.head.seq, chain_head: state.head.hash, received_at: w.as.now() });
    w.as.receipts.set(MANDATE_ID, [{ receipt: r, sig: await signObject(r, computer.seed) }]);
    const late = await readOwnMandates({ ...w.deps, now: () => g.granted_at + 12 * 60 });
    expect(late.ok && late.items[0].notReceivedBy).toBeNull();
  });
});
