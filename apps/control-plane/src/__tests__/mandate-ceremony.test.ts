/**
 * The gateway creating a mandate for the signed-in person (simulation setup S8):
 * the sign page's steps, run in the control plane after a person approved the
 * AI's proposal. The Authority Server is a recording stand-in here; the real
 * one is exercised by hap-e2e. What must hold:
 *
 * - the attest request is the one the sign page would send — hashes from
 *   hap-core over the same bounds/scope/intent, the person's DID and domain;
 * - a team mandate's intent is encrypted for the profile's approvers;
 * - every refusal (rights, limits, scope, mode, duration, intent, unknown
 *   profile or team) comes before anything is created;
 * - an AS refusal is passed on; an undeliverable intent revokes the mandate.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeBoundsHash, computeScopeHash, computeIntentHash, computeProfileHash } from '@hap/core';
import { planMandate, createMandate, approverPubkeys, MandateRefused, type CeremonyDeps, type MandateRequest } from '../lib/mandate-ceremony';

const profilesDir = process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', '..', 'hap-profiles');
const SALES = JSON.parse(readFileSync(join(profilesDir, 'sales', '0.4.profile.json'), 'utf8'));
const DELEGATION = JSON.parse(readFileSync(join(profilesDir, 'delegation', '0.1.profile.json'), 'utf8'));
const REPORTING = JSON.parse(readFileSync(join(profilesDir, 'reporting', '0.2.profile.json'), 'utf8'));
const USER = { id: 'u_anna', did: 'did:key:anna' };

const LIMITS = {
  read_access: 'unlimited', value_max: 1000, discount_max: 10, order_value_daily_max: 5000,
  quote_daily_max: 10, send_daily_max: 10, order_daily_max: 0, setup_daily_max: 0,
};

function fakeAs(opts: { approvers?: string[]; attestStatus?: number; attestBody?: unknown; delegationIn?: string[] } = {}) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const profiles = [SALES, DELEGATION, REPORTING, { ...SALES, id: SALES.id.replace('@0.4', '@0.2'), version: '0.2' }];
  const as: CeremonyDeps['as'] = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === '/api/groups') return { status: 200, body: { groups: [
      { id: 'g_personal', name: 'Anna', isPersonal: true },
      { id: 'g_team', name: 'Sales Vienna', isPersonal: false },
    ] } };
    if (path === '/api/mandates/mine?status=active') return { status: 200, body: { mandates: [
      ...(opts.delegationIn ?? []).map((g) => ({ profileId: DELEGATION.id, groupId: g })),
      { profileId: SALES.id, groupId: 'g_other' },
    ] } };
    if (path === '/api/profiles') return { status: 200, body: { profiles: profiles.map((p) => ({ id: p.id })) } };
    if (path.startsWith('/api/profiles/')) {
      const p = profiles.find((x) => x.id === decodeURIComponent(path.slice('/api/profiles/'.length)));
      return p ? { status: 200, body: p } : { status: 404, body: { error: 'not found' } };
    }
    if (path.endsWith('/approvers/pubkeys')) {
      return { status: 200, body: { pubkeys: Object.fromEntries((opts.approvers ?? []).map((u) => [u, Buffer.alloc(32, 7).toString('base64')])) } };
    }
    if (path.includes('/profile-config/')) {
      return opts.approvers ? { status: 200, body: { config: { approvers: opts.approvers } } } : { status: 404, body: { error: 'No config' } };
    }
    if (path === '/api/as/mandate') return { status: opts.attestStatus ?? 201, body: opts.attestBody ?? { authorization_id: (body as { authorization_id?: string }).authorization_id } };
    if (path.endsWith('/revoke')) return { status: 200, body: {} };
    return { status: 404, body: {} };
  };
  return { as, calls };
}

function deps(as: CeremonyDeps['as'], over: Partial<CeremonyDeps> = {}) {
  const encrypt = vi.fn(async (_intent: string, recipients: Array<{ userId: string }>) => ({
    intentCiphertext: 'Y2lwaGVy', encryptedKeys: Object.fromEntries(recipients.map((r) => [r.userId, { ct: 'a', enc: 'b' }])),
    approversFrozen: recipients.map((r) => r.userId), intentDisclosureHash: 'sha256:disclosure',
  }));
  const deliverGateContent = vi.fn(async () => {});
  const d: CeremonyDeps = { as, user: USER, encrypt, deliverGateContent, newAuthorizationId: () => 'authz_new', ...over };
  return { d, encrypt, deliverGateContent };
}

const REQ: MandateRequest = {
  profile: 'sales', limits: LIMITS, scope: { currency: 'EUR' },
  intent: 'Why — quotes wait two days.\n\nGoal — same-day quotes.', mode: 'automatic', durationHours: 24, title: 'Same-day quotes',
};

describe('createMandate — the sign page\'s request, from the gateway', () => {
  it('personal workspace: attests with hap-core hashes, the person\'s DID, domain owner; delivers the intent', async () => {
    const { as, calls } = fakeAs();
    const { d, encrypt, deliverGateContent } = deps(as);
    const { authorizationId, plan } = await createMandate(REQ, d);
    expect(authorizationId).toBe('authz_new');
    expect(plan.profile.id).toBe(SALES.id); // the newest version of "sales"

    const attest = calls.find((c) => c.path === '/api/as/mandate')!.body;
    const bounds = { ...LIMITS, profile: SALES.id };
    expect(attest).toMatchObject({
      authorization_id: 'authz_new', profile_id: SALES.id, profile_hash: computeProfileHash(SALES),
      supported_versions: ['0.7'], group_id: 'g_personal', domain: 'owner', did: USER.did,
      mandate_owners: [{ did: USER.did }],
      bounds, bounds_hash: computeBoundsHash(bounds as never, SALES),
      scope_hash: computeScopeHash({ currency: 'EUR' } as never, SALES),
      gate_content_hashes: { intent: computeIntentHash(REQ.intent) },
      execution_context_hash: computeIntentHash(JSON.stringify({ profile: SALES.id, domain: 'owner', group: 'g_personal' })),
      commitment_mode: 'automatic', ttl: 24 * 3600, title: 'Same-day quotes',
    });
    expect(attest.intent_ciphertext).toBeUndefined();
    expect(encrypt).not.toHaveBeenCalled();
    expect(deliverGateContent).toHaveBeenCalledWith(expect.objectContaining({ authorizationId: 'authz_new', gateContent: { intent: REQ.intent } }));
  });

  it('team, the person is an approver: domain = user id, intent encrypted for every approver', async () => {
    const { as, calls } = fakeAs({ approvers: ['u_anna', 'u_bernd'] });
    const { d, encrypt } = deps(as);
    await createMandate({ ...REQ, team: 'Sales Vienna' }, d);
    const attest = calls.find((c) => c.path === '/api/as/mandate')!.body;
    expect(attest).toMatchObject({ group_id: 'g_team', domain: 'u_anna', approvers_frozen: ['u_anna', 'u_bernd'], intent_ciphertext: 'Y2lwaGVy' });
    expect(encrypt.mock.calls[0][1].map((r: { userId: string }) => r.userId)).toEqual(['u_anna', 'u_bernd']);
  });

  it('an AS refusal is passed on', async () => {
    const { as } = fakeAs({ attestStatus: 422, attestBody: { error: 'commitment_mode_not_allowed', message: 'not allowed here' } });
    await expect(createMandate(REQ, deps(as).d)).rejects.toThrow(/refused the mandate: not allowed here/);
  });

  it('an intent that cannot be delivered revokes the new mandate', async () => {
    const { as, calls } = fakeAs();
    const { d } = deps(as, { deliverGateContent: async () => { throw new Error('mcp down'); } });
    await expect(createMandate(REQ, d)).rejects.toThrow(/revoked/);
    expect(calls.some((c) => c.path === '/api/authorizations/authz_new/revoke')).toBe(true);
  });
});

describe('planMandate — every refusal comes before anything is created', () => {
  const cases: Array<[string, Partial<MandateRequest>, { approvers?: string[] }, RegExp]> = [
    ['team where the profile is not enabled', { team: 'Sales Vienna' }, {}, /not enabled in "Sales Vienna"/],
    ['team where the person is not an approver', { team: 'Sales Vienna' }, { approvers: ['u_bernd'] }, /approvers in "Sales Vienna"/],
    ['a team the person is not in', { team: 'Elsewhere' }, {}, /not a member of a team "Elsewhere"/],
    ['an unknown profile', { profile: 'nope' }, {}, /Unknown profile/],
    ['an unknown limit', { limits: { ...LIMITS, bogus_max: 1 } }, {}, /Unknown field "bogus_max"/],
    ['a missing required limit', { limits: { read_access: 'unlimited' } }, {}, /Missing required field/],
    ['an enum value the profile does not offer', { limits: { ...LIMITS, read_access: 'some' } }, {}, /must be one of unlimited, none/],
    ['a scope the profile does not define', { scope: { colour: 'red' } }, {}, /does not fit/],
    ['a mode the profile does not allow', { profile: DELEGATION.id, limits: { read_access: 'unlimited', brief_daily_max: 1, mandate_daily_max: 0 }, scope: {}, mode: 'automatic' }, {}, /allows mode review/],
    ['a duration over the profile maximum', { durationHours: 24 * 365 }, {}, /At most/],
    ['a limit above the profile\'s declared maximum', { profile: REPORTING.id, limits: { read_access: 'unlimited', read_max_age_days: 367, report_daily_max: 5 }, scope: {} }, {}, /"read_max_age_days" may be at most 366/],
    ['an empty intent', { intent: '  ' }, {}, /`intent` is required/],
    ['an intent over 2000 characters', { intent: 'x'.repeat(2001) }, {}, /limit is 2000/],
  ];
  it.each(cases)('refuses %s', async (_label, over, asOpts, msg) => {
    const { as, calls } = fakeAs(asOpts);
    await expect(planMandate({ ...REQ, ...over }, deps(as).d)).rejects.toThrow(msg);
    await expect(planMandate({ ...REQ, ...over }, deps(as).d)).rejects.toBeInstanceOf(MandateRefused);
    expect(calls.some((c) => c.path === '/api/as/mandate')).toBe(false);
  });

  it('refuses when the gateway is not signed in', async () => {
    const { as } = fakeAs();
    await expect(planMandate(REQ, deps(as, { user: null }).d)).rejects.toThrow(/not signed in/);
  });

  it('a limit exactly at the profile\'s maximum is allowed', async () => {
    const { as } = fakeAs();
    const plan = await planMandate({ ...REQ, profile: REPORTING.id, limits: { read_access: 'unlimited', read_max_age_days: 366, report_daily_max: 5 }, scope: {} }, deps(as).d);
    expect(plan.profile.id).toBe(REPORTING.id);
  });

  it('a delegation mandate (review) is allowed — no special rule', async () => {
    const { as } = fakeAs();
    const plan = await planMandate({ ...REQ, profile: 'delegation', limits: { read_access: 'unlimited', brief_daily_max: 2, mandate_daily_max: 1 }, scope: {}, mode: 'review' }, deps(as).d);
    expect(plan.profile.id).toBe(DELEGATION.id);
  });
});

describe('approverPubkeys', () => {
  it('reads the shape the Authority Server sends', () => {
    expect(approverPubkeys({ pubkeys: { u1: 'k1', u2: 'k2' } })).toEqual([{ userId: 'u1', publicKey: 'k1' }, { userId: 'u2', publicKey: 'k2' }]);
    expect(approverPubkeys({ pubkeys: {} })).toEqual([]);
    expect(approverPubkeys({ approvers: [] })).toEqual([]);
  });
});

describe('workspace when `team` is omitted — the Delegation mandate\'s', () => {
  it('no Delegation mandate: the personal workspace', async () => {
    const { as } = fakeAs();
    expect((await planMandate(REQ, deps(as).d)).groupId).toBe('g_personal');
  });

  it('Delegation mandate in a team: that team (domain = user id)', async () => {
    const { as } = fakeAs({ delegationIn: ['g_team'], approvers: ['u_anna'] });
    const plan = await planMandate(REQ, deps(as).d);
    expect(plan.groupId).toBe('g_team');
    expect(plan.domain).toBe('u_anna');
  });

  it('Delegation mandates in two workspaces: refused, naming both — the AI must say which', async () => {
    const { as, calls } = fakeAs({ delegationIn: ['g_team', 'g_personal'], approvers: ['u_anna'] });
    await expect(planMandate(REQ, deps(as).d)).rejects.toThrow(/several workspaces.*"Sales Vienna".*personal/);
    expect(calls.some((c) => c.path === '/api/as/mandate')).toBe(false);
  });

  it('`team: "personal"` picks the personal workspace even when a team holds the Delegation mandate', async () => {
    const { as } = fakeAs({ delegationIn: ['g_team'] });
    expect((await planMandate({ ...REQ, team: 'personal' }, deps(as).d)).groupId).toBe('g_personal');
  });
});
