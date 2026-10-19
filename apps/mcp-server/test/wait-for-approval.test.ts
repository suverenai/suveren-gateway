/**
 * check-pending-commitments(proposal_id, wait_seconds) — the AI may stay "on
 * the line" until the person decides instead of ending its turn and needing a
 * "carry on" (Andreas, 2026-10-19). getProposalWaiting only waits; it never
 * decides anything.
 */
import { describe, it, expect } from 'vitest';
import { getProposalWaiting, MAX_WAIT_SECONDS } from '../src/tools/commitments';
import type { SPProposal } from '../src/lib/sp-client';

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}
const prop = (status: SPProposal['status']) => ({ id: 'p1', status }) as SPProposal;

describe('getProposalWaiting', () => {
  it('no wait asked → one look, answers at once', async () => {
    const c = clock(); let calls = 0;
    const r = await getProposalWaiting(async () => { calls++; return prop('pending'); }, 'p1', undefined, c.sleep, c.now);
    expect(r?.status).toBe('pending');
    expect(calls).toBe(1);
    expect(c.now()).toBe(0);
  });

  it('waits while pending and answers as soon as the person decides', async () => {
    const c = clock(); let calls = 0;
    const get = async () => { calls++; return prop(c.now() >= 6000 ? 'committed' : 'pending'); };
    const r = await getProposalWaiting(get, 'p1', 50, c.sleep, c.now);
    expect(r?.status).toBe('committed');
    expect(c.now()).toBe(6000); // returned on the first look after the decision, not after 50 s
  });

  it('never waits longer than asked, and never longer than the cap', async () => {
    const c1 = clock();
    expect((await getProposalWaiting(async () => prop('pending'), 'p1', 10, c1.sleep, c1.now))?.status).toBe('pending');
    expect(c1.now()).toBe(10_000);
    const c2 = clock();
    await getProposalWaiting(async () => prop('pending'), 'p1', 600, c2.sleep, c2.now);
    expect(c2.now()).toBe(MAX_WAIT_SECONDS * 1000);
  });

  it('a decided or missing proposal is answered at once, whatever the wait', async () => {
    const c = clock();
    expect((await getProposalWaiting(async () => prop('rejected'), 'p1', 50, c.sleep, c.now))?.status).toBe('rejected');
    expect(await getProposalWaiting(async () => null, 'p1', 50, c.sleep, c.now)).toBeNull();
    expect(c.now()).toBe(0);
  });
});
