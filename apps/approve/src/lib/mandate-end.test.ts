/**
 * Ending a mandate on the phone (mandate-end.ts), against the card world: a mandate signed by the fake Authority Server under the pinned
 * key, granted by this phone with its check; FakeAs stores a posted revoke only when hap-core verifies it against the newest grant.
 */
import { describe, it, expect } from 'vitest';
import { verifyGrant, type MandateGrant } from '@hap/core/device-keys';
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
