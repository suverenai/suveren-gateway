import { describe, it, expect } from 'vitest';
import type { ChainEntry, ChainState } from '@hap/core/device-keys';
import { chainNotices } from './chain-notices';

const now = 1_800_000_000;
const state = { devices: { mac: { label: 'Office Mac' }, me: { label: 'My Phone' } } } as unknown as ChainState;
const e = (seq: number, over: Partial<ChainEntry>): ChainEntry =>
  ({ seq, created_at: now - 60, signer: 'root', op: 'set', target: null, check: null, device: null, sigs: [], checks: [], ...over } as unknown as ChainEntry);

describe('notices from the chain', () => {
  it('a root-signed set that adds a computer\'s Touch ID key is shown, naming the computer', () => {
    const n = chainNotices([e(0, { op: 'genesis' }), e(1, { target: 'mac', check: { type: 'platform', pub: 'x' } as never })], state, 'me', now);
    expect(n).toEqual([{ kind: 'touch-id', seq: 1, label: 'Office Mac', by: null, at: now - 60 }]);
  });

  it('a device\'s own set (not by the recovery code) and a set that clears a key are not shown', () => {
    expect(chainNotices([e(1, { signer: 'mac', target: 'mac', check: { type: 'platform', pub: 'x' } as never })], state, 'me', now)).toEqual([]);
    expect(chainNotices([e(1, { target: 'mac', check: null })], state, 'me', now)).toEqual([]);
  });
});
