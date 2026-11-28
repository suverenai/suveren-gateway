/**
 * planMandate fills a bound the profile marks `required` and gives a `default`, when the request leaves
 * it out (hap-core validation ignores defaults). A MADE-UP profile with its own field names: the fill is
 * read from the profile schema, never from a field name. The real Email profile through the real
 * gateway is for suveren-e2e (setup__create_mandate without setup_daily_max).
 */
import { describe, it, expect, vi } from 'vitest';
import { planMandate, MandateRefused, type CeremonyDeps, type MandateRequest } from '../lib/mandate-ceremony';

const SHOP = {
  id: 'example.org/profiles/shop@1', name: 'Shop', version: '1', description: 'made-up',
  boundsSchema: {
    keyOrder: ['profile', 'refund_daily_max', 'gift_daily_max', 'ship_daily_max'],
    actionTypes: ['refund'],
    fields: {
      profile: { type: 'string', required: true },
      refund_daily_max: { type: 'number', required: true, default: 0, boundType: { kind: 'cumulative_count', window: 'daily' }, appliesTo: ['refund'] },
      gift_daily_max: { type: 'number', required: false, default: 5, boundType: { kind: 'cumulative_count', window: 'daily' }, appliesTo: ['refund'] },
      ship_daily_max: { type: 'number', required: true, boundType: { kind: 'cumulative_count', window: 'daily' }, appliesTo: ['refund'] },
    },
  },
  scopeSchema: { keyOrder: [], fields: {} }, executionContextSchema: { fields: {} }, requiredGates: [],
  commitment_modes: ['automatic', 'review'], ttl: { default: 3600, max: 86400 }, retention_minimum: 1,
};
const USER = { id: 'u_anna', did: 'did:key:anna' };
const as: CeremonyDeps['as'] = async (_m, path) => {
  if (path === '/api/groups') return { status: 200, body: { groups: [{ id: 'g_personal', name: 'Anna', isPersonal: true }] } };
  if (path === '/api/mandates/mine?status=active') return { status: 200, body: { mandates: [{ authorization_id: 'a', profileId: SHOP.id, groupId: 'g_personal' }] } };
  if (path === '/api/profiles') return { status: 200, body: { profiles: [{ id: SHOP.id }] } };
  if (path.startsWith('/api/profiles/')) return { status: 200, body: SHOP };
  return { status: 404, body: {} };
};
const deps = { as, user: USER, encrypt: vi.fn(), deliverGateContent: vi.fn(async () => {}), newAuthorizationId: () => 'authz_new' } as unknown as CeremonyDeps;
const REQ: MandateRequest = { team: 'personal', profile: SHOP.id, limits: { ship_daily_max: 3 }, scope: {}, intent: 'Refund.', mode: 'automatic', durationHours: 1 };

describe('planMandate fills required bounds that have a default', () => {
  it('uses the default of a required bound the request leaves out, and puts it in the plan the card shows', async () => {
    const plan = await planMandate(REQ, deps);
    expect(plan.bounds.refund_daily_max).toBe(0);
  });
  it('never changes a value the request set, 0 included', async () => {
    expect((await planMandate({ ...REQ, limits: { ship_daily_max: 3, refund_daily_max: 7 } }, deps)).bounds.refund_daily_max).toBe(7);
  });
  it('leaves an optional bound with a default alone, and still refuses a required one without a default', async () => {
    expect((await planMandate(REQ, deps)).bounds.gift_daily_max).toBeUndefined();
    await expect(planMandate({ ...REQ, limits: {} }, deps)).rejects.toBeInstanceOf(MandateRefused);
  });
});
