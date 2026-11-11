/**
 * Building a mandate under a profile that declares `scopeSchema.atLeastOne`
 * (@hap/core/scope-rules): the one shared path (planMandate — the sign page, the
 * AI's proposal, change_mandate) refuses a mandate whose limits allow a listed
 * action while its scope sets none of the group's fields, before anything is
 * created. A mandate that allows none of them (a count limit of 0) needs neither.
 *
 * A MADE-UP profile with other field names than any shipped profile: nothing here
 * depends on Email. The Authority Server is a recording stand-in; the real one is
 * exercised by suveren-e2e.
 */
import { describe, it, expect, vi } from 'vitest';
import { planMandate, planMandateChange, MandateRefused, type CeremonyDeps, type MandateRequest } from '../lib/mandate-ceremony';

const VENUE = {
  id: 'example.org/profiles/venue@2',
  name: 'Venue',
  version: '2',
  description: 'made-up profile for scopeSchema.atLeastOne',
  boundsSchema: {
    keyOrder: ['profile', 'book_daily_max', 'cancel_daily_max'],
    actionTypes: ['book', 'cancel'],
    fields: {
      profile: { type: 'string', required: true },
      book_daily_max: { type: 'number', required: false, boundType: { kind: 'cumulative_count', window: 'daily' }, appliesTo: ['book'] },
      cancel_daily_max: { type: 'number', required: false, boundType: { kind: 'cumulative_count', window: 'daily' }, appliesTo: ['cancel'] },
    },
  },
  scopeSchema: {
    keyOrder: ['rooms', 'buildings'],
    fields: {
      rooms: { type: 'string', required: false, displayName: 'Bookable rooms', constraint: { type: 'string', enforceable: ['subset'] } },
      buildings: { type: 'string', required: false, displayName: 'Bookable buildings', constraint: { type: 'string', enforceable: ['subset'] } },
    },
    atLeastOne: [{ fields: ['rooms', 'buildings'], requiredFor: ['book'], ask: 'where the AI may book' }],
  },
  executionContextSchema: { fields: {} },
  requiredGates: [],
  commitment_modes: ['automatic', 'review'],
  ttl: { default: 3600, max: 86400 },
  retention_minimum: 1,
};
const USER = { id: 'u_anna', did: 'did:key:anna' };
const REFUSAL = 'A Venue mandate that allows booking must name at least one bookable room or building. Ask the person where the AI may book.';

function fakeAs() {
  const calls: Array<{ method: string; path: string }> = [];
  const as: CeremonyDeps['as'] = async (method, path) => {
    calls.push({ method, path });
    if (path === '/api/groups') return { status: 200, body: { groups: [{ id: 'g_personal', name: 'Anna', isPersonal: true }] } };
    if (path === '/api/mandates/mine?status=active') return { status: 200, body: { mandates: [{ authorization_id: 'authz_old', profileId: VENUE.id, groupId: 'g_personal' }] } };
    if (path === '/api/profiles') return { status: 200, body: { profiles: [{ id: VENUE.id }] } };
    if (path.startsWith('/api/profiles/')) return { status: 200, body: VENUE };
    return { status: 404, body: {} };
  };
  return { as, calls };
}

function deps(as: CeremonyDeps['as']): CeremonyDeps {
  return {
    as, user: USER,
    encrypt: vi.fn(), deliverGateContent: vi.fn(async () => {}), newAuthorizationId: () => 'authz_new',
  } as unknown as CeremonyDeps;
}

const REQ: MandateRequest = { team: 'personal', profile: VENUE.id, limits: { book_daily_max: 3, cancel_daily_max: 1 }, scope: {}, intent: 'Book rooms.', mode: 'automatic', durationHours: 1 };

describe('planMandate and scopeSchema.atLeastOne', () => {
  it('refuses a mandate that allows a listed action and sets none of the group, before anything is created', async () => {
    const { as, calls } = fakeAs();
    const p = planMandate(REQ, deps(as));
    await expect(p).rejects.toBeInstanceOf(MandateRefused);
    await expect(planMandate(REQ, deps(as))).rejects.toThrow(REFUSAL);
    await expect(planMandate({ ...REQ, scope: { rooms: ' , ' } }, deps(as))).rejects.toMatchObject({ message: REFUSAL, code: 'scope_at_least_one' });
    expect(calls.some((c) => c.path === '/api/as/mandate')).toBe(false);
  });

  it('accepts it with one field of the group set', async () => {
    const { as } = fakeAs();
    const plan = await planMandate({ ...REQ, scope: { buildings: 'north' } }, deps(as));
    expect(plan.context).toEqual({ buildings: 'north' });
  });

  it('a mandate that does not allow the listed action (count limit 0) needs neither field', async () => {
    const { as } = fakeAs();
    const plan = await planMandate({ ...REQ, limits: { book_daily_max: 0, cancel_daily_max: 2 } }, deps(as));
    expect(plan.bounds.book_daily_max).toBe(0);
  });
});

describe('change_mandate obeys the same rule', () => {
  const OLD = {
    authorizationId: 'authz_old', profileId: VENUE.id, groupId: 'g_personal', ownerDid: USER.did,
    bounds: { profile: VENUE.id, book_daily_max: 3, cancel_daily_max: 1 }, context: { rooms: 'r1' },
    intent: 'Book rooms.', mode: 'automatic' as const, expiresAt: Math.floor(Date.now() / 1000) + 3600, title: 'Rooms',
  };

  it('removing the last field of the group while booking stays allowed is refused', async () => {
    const { as } = fakeAs();
    await expect(planMandateChange({ old: OLD, changes: { scope: { rooms: '' } } }, deps(as))).rejects.toThrow(REFUSAL);
  });

  it('removing it together with setting the booking limit to 0 is allowed', async () => {
    const { as } = fakeAs();
    const { plan } = await planMandateChange({ old: OLD, changes: { scope: { rooms: '' }, limits: { book_daily_max: 0 } } }, deps(as));
    expect(plan.bounds.book_daily_max).toBe(0);
  });
});
