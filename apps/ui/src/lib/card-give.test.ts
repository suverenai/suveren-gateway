/**
 * The approval card gives an AI-proposed mandate with the one give driver (lib/use-give.ts) the give page uses. The request it builds
 * from the proposal must be exactly what the give page sends for the same values: then prepare, the grant members and the Touch ID
 * check are the same code over the same input.
 */
import { describe, it, expect, vi } from 'vitest';

const SALES = {
  id: 'github.com/humanagencyprotocol/hap-profiles/sales@0.3',
  boundsSchema: { keyOrder: ['value_max', 'read_access'], fields: { value_max: { type: 'number' }, read_access: { type: 'string' } } },
  scopeSchema: { keyOrder: ['currency'], fields: { currency: { type: 'string' } } },
};
vi.mock('./sp-client', () => ({
  spClient: {
    listProfiles: async () => [{ id: 'github.com/humanagencyprotocol/hap-profiles/sales@0.2' }, { id: SALES.id }],
    getProfile: async () => SALES,
  },
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('../contexts/EventSourceContext', () => ({ useSSEEvent: () => {} }));

const { giveRequestFromProposal } = await import('./card-give');
const { mandatePrefillGate } = await import('@suveren/approval-card/lib/create-mandate-prefill');
const { carryBoundsForward, carryContextForward } = await import('@suveren/approval-card/lib/profile-upgrade');

const ARGS = { profile: 'sales', limits: { value_max: 1000, read_access: 'unlimited' }, scope: { currency: 'EUR' }, intent: 'Quotes wait two days.', mode: 'review', duration_hours: 24, title: 'Quotes' };

describe('giveRequestFromProposal: the card gives exactly what the give page would for the same values', () => {
  it('newest area version, limits and scope carried onto it, the proposal\'s intent, mode, duration and title, the active workspace', async () => {
    const r = await giveRequestFromProposal(ARGS, { groupId: 'g_personal', isPersonal: true });
    // What the give page sends after "Edit before signing" for the same proposal (same helpers, same order).
    const gate = mandatePrefillGate(ARGS as never);
    expect(r).toEqual({
      team: 'personal',
      profile: SALES.id,
      limits: carryBoundsForward(gate.bounds, SALES as never),
      scope: carryContextForward(gate.context, SALES as never),
      intent: 'Quotes wait two days.',
      mode: 'review',
      ttlSeconds: 24 * 3600,
      title: 'Quotes',
      discloseIdentity: true,
    });
  });

  it('a team workspace is named by its id; nothing is guessed when the area, the mode or the duration is missing', async () => {
    expect((await giveRequestFromProposal(ARGS, { groupId: 'g_team', isPersonal: false }))?.team).toBe('g_team');
    expect(await giveRequestFromProposal({ ...ARGS, profile: 'nope' }, { groupId: 'g', isPersonal: true })).toBeNull();
    expect(await giveRequestFromProposal({ ...ARGS, mode: undefined }, { groupId: 'g', isPersonal: true })).toBeNull();
    expect(await giveRequestFromProposal({ ...ARGS, duration_hours: undefined }, { groupId: 'g', isPersonal: true })).toBeNull();
  });
});
