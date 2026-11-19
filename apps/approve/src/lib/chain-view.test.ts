import { describe, it, expect } from 'vitest';
import { verifyChain } from '@hap/core/device-keys';
import { deviceRows, labelTaken, originOf, RECENT_SECONDS } from './chain-view';
import { FakeAs, PeerComputer, addWithRoot, seedAccount, removeWithRoot } from './test-kit';

describe('the device list from a verified chain', () => {
  it('lists active devices oldest first, marks this device and the ones that can confirm changes', async () => {
    const as = await FakeAs.create();
    const mac = await PeerComputer.create('Office Mac');
    await seedAccount(as, mac);
    const state = await as.state();
    const rows = deviceRows(as.entries, state, mac.keyId, as.now());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'Office Mac', kind: 'gateway', thisDevice: true, canGrant: true, recent: false });
    expect(rows[0].addedAt).toBe(as.now() - 3600);
  });

  it('a computer without a check key does not confirm changes', async () => {
    const as = await FakeAs.create();
    await seedAccount(as, await PeerComputer.create('Old PC', false));
    const rows = deviceRows(as.entries, await as.state(), 'other', as.now());
    expect(rows[0]).toMatchObject({ canGrant: false, thisDevice: false });
  });

  it('a removed device is not in the list', async () => {
    const as = await FakeAs.create();
    const a = await PeerComputer.create('A');
    const { root } = await seedAccount(as, a);
    // A second device first (a root-signed add), then the first is removed.
    const b = await PeerComputer.create('B');
    const add = await addWithRoot(as, root, b);
    await removeWithRoot(as, root, a.keyId);
    const rows = deviceRows(as.entries, await as.state(), b.keyId, as.now());
    expect(rows.map((r) => r.label)).toEqual(['B']);
    expect(rows[0].recent).toBe(true);
    expect(rows[0].recent).toBe(as.now() - add.created_at < RECENT_SECONDS);
  });

  it('says where and when the identity was made', async () => {
    const as = await FakeAs.create();
    await seedAccount(as, await PeerComputer.create('Office Mac'));
    expect(originOf(as.entries)).toEqual({ label: 'Office Mac', kind: 'gateway', at: as.now() - 3600 });
    expect(originOf([])).toBeNull();
  });

  it('a label is taken when an active device has it, ignoring case and surrounding space', async () => {
    const as = await FakeAs.create();
    await seedAccount(as, await PeerComputer.create('Office Mac'));
    const state = await verifyChain({ expectedRootDid: as.rootDid, entries: as.entries });
    expect(labelTaken(state, ' office mac ')).toBe(true);
    expect(labelTaken(state, 'Home Mac')).toBe(false);
  });
});
