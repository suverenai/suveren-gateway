import { describe, it, expect } from 'vitest';
import { entryHash, verifyChain } from '@hap/core/device-keys';
import { RemoveDriver } from './remove-driver';
import { chainNotices } from './chain-notices';
import { errorText } from '../texts';
import { FakeAs, FakePasskeys, PeerComputer, addWithRoot, registerPhone, testRuntime, type TestRuntime } from './test-kit';

const pk = (rt: TestRuntime) => rt.check as FakePasskeys;
import { rootKeyFromRecoveryCode } from '@hap/core/device-keys';

const driverOf = (rt: TestRuntime) => new RemoveDriver({ keys: rt.keys, check: rt.check, api: rt.api, accounts: rt.accounts, session: rt.session, now: rt.now });

/** A phone that registered an account (it can grant), plus two computers added with the recovery code, and an open session. */
async function world(macCheck = true) {
  const as = await FakeAs.create();
  const rt = testRuntime(as);
  const { recoveryCode } = await registerPhone(rt, as, 'My iPhone');
  const root = await rootKeyFromRecoveryCode(recoveryCode);
  const office = await PeerComputer.create('Office Mac', macCheck);
  const home = await PeerComputer.create('Home Mac', false);
  await addWithRoot(as, root, office);
  await addWithRoot(as, root, home);
  const opened = await rt.session.open();
  if (!opened.ok) throw new Error('session');
  const me = (await rt.accounts.read())!.key_id;
  return { as, rt, office, home, me, root };
}

describe('this phone removes a device (stage D3, mockup C1–C5)', () => {
  it('another device: the confirm screen shows the list after the change BEFORE the touch; then one touch, a remove signed and checked by the phone', async () => {
    const { as, rt, home, me } = await world();
    const d = driverOf(rt);
    await d.start(home.keyId);
    const st = d.get();
    expect(st.step).toBe('confirm');
    if (st.step !== 'confirm') return;
    expect(st.self).toBe(false);
    expect(st.target.label).toBe('Home Mac');
    expect(st.after.map((r) => r.label)).toEqual(['My iPhone', 'Office Mac']);
    const touches = pk(rt).proved.length;
    expect(as.entries).toHaveLength(3);

    await d.confirm();
    const done = d.get();
    expect(done).toMatchObject({ step: 'done', label: 'Home Mac', self: false });
    if (done.step !== 'done') return;
    expect(done.rows.map((r) => r.label)).toEqual(['My iPhone', 'Office Mac']);
    expect(pk(rt).proved.length).toBe(touches + 1);
    const e = as.entries[3];
    expect(e).toMatchObject({ op: 'remove', target: home.keyId, signer: me });
    expect(e.sigs.map((s) => s.by)).toEqual([me]);
    expect(e.checks.map((c) => c.by)).toEqual([me]);
    // The touch was over exactly this entry.
    expect(pk(rt).proved.at(-1)).toBe(await entryHash(e));
    const state = await verifyChain({ expectedRootDid: as.rootDid, entries: as.entries });
    expect(state.devices[home.keyId].removed_seq).toBe(3);
    expect((await rt.accounts.read())!.head.seq).toBe(3);
  });

  it('this phone itself (DEC-85): the same touch first, then an entry signed by the phone alone (hap-core refuses a check on a self-remove)', async () => {
    const { as, rt, me } = await world();
    const d = driverOf(rt);
    await d.start(me);
    expect(d.get()).toMatchObject({ step: 'confirm', self: true });
    const touches = pk(rt).proved.length;
    await d.confirm();
    expect(d.get()).toMatchObject({ step: 'done', self: true, rows: [] });
    expect(pk(rt).proved.length).toBe(touches + 1);
    const e = as.entries.at(-1)!;
    expect(e).toMatchObject({ op: 'remove', target: me, signer: me, checks: [] });
    await verifyChain({ expectedRootDid: as.rootDid, entries: as.entries });
  });

  it('the last device that can confirm changes: refused before the touch, nothing signed, nothing sent (NO_GRANTING_DEVICE)', async () => {
    const { as, rt, me } = await world(false);
    const d = driverOf(rt);
    const touches = pk(rt).proved.length;
    await d.start(me);
    expect(d.get()).toMatchObject({ step: 'refused', self: true, error: errorText('last_granting_self') });
    expect(pk(rt).proved.length).toBe(touches);
    expect(as.entries).toHaveLength(3);
  });

  it('a computer without Touch ID can go: the phone still confirms changes', async () => {
    const { rt, home } = await world(false);
    const d = driverOf(rt);
    await d.start(home.keyId);
    expect(d.get().step).toBe('confirm');
  });

  it('a cancelled touch: nothing sent, said in words', async () => {
    const { as, rt, home } = await world();
    pk(rt).cancelNext = true;
    const d = driverOf(rt);
    await d.start(home.keyId);
    await d.confirm();
    expect(d.get()).toMatchObject({ step: 'failed', error: errorText('cancelled') });
    expect(as.entries).toHaveLength(3);
  });

  it('the list moved meanwhile: the server refuses, and the phone says the list changed, not "nothing was added"', async () => {
    const { as, rt, home, office, root } = await world();
    const d = driverOf(rt);
    await d.start(home.keyId);
    await addWithRoot(as, root, await PeerComputer.create('Spare Mac', false));
    void office;
    await d.confirm();
    expect(d.get()).toMatchObject({ step: 'failed', error: errorText('remove_chain_moved') });
  });
});

describe('notices from the other devices (mockup F1, F3)', () => {
  it('an add and a remove made elsewhere show; what this phone did itself does not', async () => {
    const { as, rt, home, me } = await world();
    const d = driverOf(rt);
    await d.start(home.keyId);
    await d.confirm();
    const s = rt.session.current()!;
    const n = chainNotices(s.entries, s.chain, me, as.now());
    // Both computers were added with the recovery code (signer root); the remove was this phone's own.
    expect(n.map((x) => [x.kind, 'label' in x ? x.label : null, x.by])).toEqual([['added', 'Home Mac', null], ['added', 'Office Mac', null]]);
  });

  it('older than 14 days: gone', async () => {
    const { as, rt, me } = await world();
    const s = rt.session.current()!;
    expect(chainNotices(s.entries, s.chain, me, as.now() + 15 * 86400)).toEqual([]);
  });
});
