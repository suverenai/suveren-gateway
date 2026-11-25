/**
 * Does the chain the Authority Server shows hold OUR entry? A joining device asks this before it keeps anything (plan 4.3 step 6):
 * the `done` message says "stored", but only the chain says it is. The chain is verified from the genesis on (signatures, checks, order),
 * and the entry at the expected number must hash to the entry this device built, with this device active. Any defect is false.
 * One function for the phone (joining a computer's chain) and the gateway page (joining a phone's).
 */
import { isActive, verifyChain } from '@hap/core/device-keys';

export async function entryInChain(
  chain: { root_did: string; entries: unknown[] } | undefined,
  expect: { rootDid: string; seq: number; hash: string; keyId: string },
): Promise<boolean> {
  if (!chain || chain.root_did !== expect.rootDid || !Array.isArray(chain.entries)) return false;
  try {
    const state = await verifyChain({ expectedRootDid: expect.rootDid, entries: chain.entries });
    return state.hashes[expect.seq] === expect.hash && isActive(state, expect.keyId);
  } catch {
    return false;
  }
}
