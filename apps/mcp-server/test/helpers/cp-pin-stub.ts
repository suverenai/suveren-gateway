/**
 * The control plane's `pinChain` (lib/mandate-grants.ts: fetch the chain, verify it with hap-core against the head pinned before,
 * then move the pin), for the tests that mount the real internal router over in-memory stores: the chains come from the test's
 * Authority Server stand-in, the verification and the pin store are the real ones. The control plane's own tests cover the real class.
 */
import * as dk from '@hap/core/device-keys';
import { PinRefusedError, type DevicePinStore } from '../../../control-plane/src/lib/device-pin-store';

export function pinChainStub(chains: Map<string, { entries: unknown[] }>, pins: DevicePinStore, ownDid: string) {
  return async (did: string) => {
    if (did === ownDid) throw new PinRefusedError('own_chain');
    const c = chains.get(did);
    if (!c) throw Object.assign(new Error('no chain'), { name: 'GrantRefusal', code: 'chain_unknown' });
    let state;
    try {
      state = await dk.verifyChain({ expectedRootDid: did, entries: c.entries as never, storedHead: pins.get(did) });
    } catch (e) {
      if ((e as { code?: string }).code === 'ROLLBACK') throw new PinRefusedError('rollback');
      if ((e as { code?: string }).code === 'FORK') throw new PinRefusedError('fork');
      throw Object.assign(new Error('chain invalid'), { name: 'GrantRefusal', code: 'chain_invalid' });
    }
    return pins.advance(did, state.head, []);
  };
}
