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
import { computeBoundsHash, computeScopeHash, computeIntentHash, computeProfileHash, computeExecutionContextHash } from '@hap/core';
import { planMandate, createMandate, renewMandate, planMandateChange, changeMandate, checkMandateRight, approverPubkeys, MandateRefused, type CeremonyDeps, type MandateRequest } from '../lib/mandate-ceremony';

const profilesDir = process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', '..', 'hap-profiles');
const SALES = JSON.parse(readFileSync(join(profilesDir, 'sales', '0.4.profile.json'), 'utf8'));
const DELEGATION = JSON.parse(readFileSync(join(profilesDir, 'delegation', '0.1.profile.json'), 'utf8'));
const REPORTING = JSON.parse(readFileSync(join(profilesDir, 'reporting', '0.2.profile.json'), 'utf8'));
const USER = { id: 'u_anna', did: 'did:key:anna' };

const LIMITS = {
  read_access: 'unlimited', value_max: 1000, discount_max: 10, order_value_daily_max: 5000,
  quote_daily_max: 10, send_daily_max: 10, order_daily_max: 0, setup_daily_max: 0,
};

function fakeAs(opts: { approvers?: string[]; grantors?: string[] | 'all'; attestStatus?: number; attestBody?: unknown; delegationIn?: string[] } = {}) {
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
      return opts.approvers ? { status: 200, body: { config: { approvers: opts.approvers, ...(opts.grantors !== undefined ? { grantors: opts.grantors } : {}) } } } : { status: 404, body: { error: 'No config' } };
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
      // v0.8: every version this gateway verifies, newest first — the AS issues the highest both support.
      supported_versions: ['0.8', '0.7'], group_id: 'g_personal', domain: 'owner', did: USER.did,
      mandate_owners: [{ did: USER.did }],
      bounds, bounds_hash: computeBoundsHash(bounds as never, SALES),
      scope_hash: computeScopeHash({ currency: 'EUR' } as never, SALES),
      gate_content_hashes: { intent: computeIntentHash(REQ.intent) },
      // v0.8: the hash of the profile's executionContextSchema (protocol.md → Execution Context Schema).
      execution_context_hash: computeExecutionContextHash(SALES),
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
  // As the Setup built-in sends it: the workspace of the person's own mandate under its profile.
  const SETUP_REQ = { ...REQ, workspaceOf: 'delegation' };

  it('no Delegation mandate: the personal workspace', async () => {
    const { as } = fakeAs();
    expect((await planMandate(SETUP_REQ, deps(as).d)).groupId).toBe('g_personal');
  });

  it('Delegation mandate in a team: that team (domain = user id)', async () => {
    const { as } = fakeAs({ delegationIn: ['g_team'], approvers: ['u_anna'] });
    const plan = await planMandate(SETUP_REQ, deps(as).d);
    expect(plan.groupId).toBe('g_team');
    expect(plan.domain).toBe('u_anna');
  });

  it('a team that names who may give mandates (grantors) and no above-cap approvers: allowed', async () => {
    const { as } = fakeAs({ delegationIn: ['g_team'], approvers: [], grantors: ['u_anna'] });
    expect((await planMandate(SETUP_REQ, deps(as).d)).groupId).toBe('g_team');
  });

  it('grantors: "all" lets any member give the mandate', async () => {
    const { as } = fakeAs({ delegationIn: ['g_team'], approvers: [], grantors: 'all' });
    expect((await planMandate(SETUP_REQ, deps(as).d)).groupId).toBe('g_team');
  });

  it('the person is an above-cap approver but not named to give mandates: refused', async () => {
    const { as } = fakeAs({ delegationIn: ['g_team'], approvers: ['u_anna'], grantors: ['u_bernd'] });
    await expect(planMandate(SETUP_REQ, deps(as).d)).rejects.toBeInstanceOf(MandateRefused);
  });

  it('Delegation mandates in two workspaces: refused, naming both — the AI must say which', async () => {
    const { as, calls } = fakeAs({ delegationIn: ['g_team', 'g_personal'], approvers: ['u_anna'] });
    await expect(planMandate(SETUP_REQ, deps(as).d)).rejects.toThrow(/several workspaces.*"Sales Vienna".*personal/);
    expect(calls.some((c) => c.path === '/api/as/mandate')).toBe(false);
  });

  it('`team: "personal"` picks the personal workspace even when a team holds the Delegation mandate', async () => {
    const { as } = fakeAs({ delegationIn: ['g_team'] });
    expect((await planMandate({ ...SETUP_REQ, team: 'personal' }, deps(as).d)).groupId).toBe('g_personal');
  });

  it('the profile comes from the request, never a name in code: a made-up one finds its own mandate\'s workspace', async () => {
    const { as } = fakeAs({ delegationIn: ['g_team'], approvers: ['u_anna'] });
    // A Setup-like profile under another name: the Delegation mandate in g_team is not its mandate.
    expect((await planMandate({ ...REQ, workspaceOf: 'helpdesk-setup' }, deps(as).d)).groupId).toBe('g_personal');
  });

  it('no `workspaceOf` and no `team`: the personal workspace', async () => {
    const { as } = fakeAs({ delegationIn: ['g_team'], approvers: ['u_anna'] });
    expect((await planMandate(REQ, deps(as).d)).groupId).toBe('g_personal');
  });
});

describe('checkMandateRight — only the team authority gate, no limits needed', () => {
  it('personal workspace: allowed', async () => {
    const { as } = fakeAs();
    await expect(checkMandateRight({ profile: 'sales', team: 'personal' }, deps(as).d)).resolves.toMatchObject({ groupName: 'Anna', profileId: SALES.id });
  });
  it('a team where the profile is not enabled: refused with the code an admin step follows from', async () => {
    const { as } = fakeAs();
    const err = await checkMandateRight({ profile: 'sales', team: 'g_team' }, deps(as).d).catch((e) => e);
    expect(err).toBeInstanceOf(MandateRefused);
    expect(err.code).toBe('profile_not_enabled');
    expect(err.message).toMatch(/Ask an admin of "Sales Vienna" to enable/);
  });
  it('a team where the person is not a grantor: refused with its own code', async () => {
    const { as } = fakeAs({ approvers: ['u_bernd'], grantors: ['u_bernd'] });
    const err = await checkMandateRight({ profile: 'sales', team: 'g_team' }, deps(as).d).catch((e) => e);
    expect(err.code).toBe('not_a_grantor');
  });
  it('a team that enabled it for the person: allowed', async () => {
    const { as } = fakeAs({ approvers: ['u_bernd'], grantors: ['u_anna'] });
    await expect(checkMandateRight({ profile: 'sales', team: 'g_team' }, deps(as).d)).resolves.toMatchObject({ groupName: 'Sales Vienna' });
  });
});


const SCOPE = { currency: 'EUR' };

describe('the web page signs through this module', () => {
  it('a duration in seconds wins, and the name disclosure and local labels pass through', async () => {
    const { as, calls } = fakeAs();
    const { d, deliverGateContent } = deps(as);
    await createMandate({
      team: 'personal', profile: SALES.id, limits: LIMITS, scope: SCOPE, intent: 'Because.', mode: 'review',
      ttlSeconds: 7200, discloseIdentity: false, contextLabels: { list: { a: 'A' } },
    }, d);
    const sent = calls.find((c) => c.path === '/api/as/mandate')!.body;
    expect(sent.ttl).toBe(7200);
    expect(sent.disclose_identity).toBe(false);
    expect(deliverGateContent).toHaveBeenCalledWith(expect.objectContaining({ contextLabels: { list: { a: 'A' } } }));
  });

  it('without the page\'s checkbox nothing is sent about disclosure — the standing choice stays with the AS', async () => {
    const { as, calls } = fakeAs();
    const { d } = deps(as);
    await createMandate({ team: 'personal', profile: SALES.id, limits: LIMITS, scope: SCOPE, intent: 'Because.', mode: 'review' }, d);
    expect(calls.find((c) => c.path === '/api/as/mandate')!.body).not.toHaveProperty('disclose_identity');
  });

  it('renewing moves only the expiry: same id, renew flag, the signed values', async () => {
    const { as, calls } = fakeAs();
    const { d, deliverGateContent } = deps(as);
    await renewMandate({
      authorizationId: 'authz_1', profileId: SALES.id, groupId: 'g_personal',
      bounds: { ...LIMITS, profile: SALES.id }, context: SCOPE, intent: 'Because.', mode: 'review', domain: 'owner', ttlSeconds: 3600,
    }, d);
    const sent = calls.find((c) => c.path === '/api/as/mandate')!.body;
    expect(sent).toMatchObject({ authorization_id: 'authz_1', renew: true, ttl: 3600, commitment_mode: 'review' });
    expect(sent.bounds_hash).toBe(computeBoundsHash({ ...LIMITS, profile: SALES.id } as never, SALES));
    expect(deliverGateContent).toHaveBeenCalledOnce();
  });

  it('a renewal the Authority Server refuses is passed on, not swallowed', async () => {
    const { as } = fakeAs({ attestStatus: 403, attestBody: { approved: false, errors: [{ code: 'MANDATE_REVOKED', message: 'Revoked.' }] } });
    const { d, deliverGateContent } = deps(as);
    await expect(renewMandate({
      authorizationId: 'authz_1', profileId: SALES.id, groupId: 'g_personal',
      bounds: { ...LIMITS, profile: SALES.id }, context: SCOPE, intent: 'x', mode: 'review', domain: 'owner', ttlSeconds: 3600,
    }, d)).rejects.toThrow(/Revoked\./);
    expect(deliverGateContent).not.toHaveBeenCalled();
  });
});


describe('replacing a mandate', () => {
  const base: MandateRequest = { team: 'personal', profile: SALES.id, limits: LIMITS, scope: SCOPE, intent: 'Because.', mode: 'review', replaces: 'authz_old' };

  it('signs, delivers, then revokes the old one — in that order', async () => {
    const { as, calls } = fakeAs();
    const order: string[] = [];
    const { d } = deps(async (m, p, b) => { order.push(p); return as(m, p, b); }, { deliverGateContent: vi.fn(async () => { order.push('deliver'); }) });
    const r = await createMandate(base, d);
    expect(r.revokeError).toBeUndefined();
    expect(calls.find((c) => c.path === '/api/as/mandate')!.body.replaces).toBe('authz_old');
    expect(order.indexOf('deliver')).toBeGreaterThan(order.indexOf('/api/as/mandate'));
    expect(order.indexOf('/api/authorizations/authz_old/revoke')).toBeGreaterThan(order.indexOf('deliver'));
  });

  it('a failed revoke is reported, the new mandate stays', async () => {
    const { as } = fakeAs();
    const failing: CeremonyDeps['as'] = async (m, p, b) => (p.endsWith('/revoke') ? { status: 500, body: { error: 'database down' } } : as(m, p, b));
    const { d } = deps(failing);
    const r = await createMandate(base, d);
    expect(r.authorizationId).toBe('authz_new');
    expect(r.revokeError).toBe('database down');
  });

  it('an old mandate that was already revoked is not an error', async () => {
    const { as } = fakeAs();
    const gone: CeremonyDeps['as'] = async (m, p, b) => (p.endsWith('/revoke') ? { status: 409, body: { error: 'Already revoked' } } : as(m, p, b));
    const { d } = deps(gone);
    expect((await createMandate(base, d)).revokeError).toBeUndefined();
  });

  it('an undelivered new mandate is revoked and the old one is left alone', async () => {
    const { as, calls } = fakeAs();
    const { d } = deps(as, { deliverGateContent: vi.fn(async () => { throw new Error('mcp down'); }) });
    await expect(createMandate(base, d)).rejects.toThrow(/revoked/);
    const revoked = calls.filter((c) => c.path.endsWith('/revoke')).map((c) => c.path);
    expect(revoked).toEqual(['/api/authorizations/authz_new/revoke']);
  });
});

describe('changing a mandate: built from the signed old one, never from what the AI claims', () => {
  const OLD = {
    authorizationId: 'authz_old', profileId: SALES.id, groupId: 'g_personal', ownerDid: USER.did,
    bounds: { ...LIMITS, profile: SALES.id }, context: SCOPE, intent: 'Quotes for existing customers.', mode: 'review' as const,
    expiresAt: Math.floor(Date.now() / 1000) + 86400 * 10, title: 'Quotes',
  };
  function asWithMandate(active: boolean) {
    const { as, calls } = fakeAs();
    const wrapped: CeremonyDeps['as'] = async (m, p, b) => (p === '/api/mandates/mine?status=active'
      ? { status: 200, body: { mandates: active ? [{ authorization_id: 'authz_old', profileId: SALES.id, groupId: 'g_personal' }] : [] } }
      : as(m, p, b));
    return { as: wrapped, calls };
  }

  it('raising a limit: only that row differs, tagged More, the rest stays', async () => {
    const { as } = asWithMandate(true);
    const { diff, plan } = await planMandateChange({ old: OLD, changes: { limits: { quote_daily_max: 15 } } }, deps(as).d);
    expect(diff.rows).toEqual([expect.objectContaining({ field: 'quote_daily_max', before: 10, after: 15, tag: 'More', section: 'limit' })]);
    expect(diff.stays.map((s) => s.label)).toContain('mode');
    expect(plan.bounds.quote_daily_max).toBe(15);
  });

  it('lowering a limit is tagged Less', async () => {
    const { as } = asWithMandate(true);
    const { diff } = await planMandateChange({ old: OLD, changes: { limits: { quote_daily_max: 2 } } }, deps(as).d);
    expect(diff.rows[0]).toMatchObject({ tag: 'Less', before: 10, after: 2 });
  });

  it('the end date stays unless a new one is proposed', async () => {
    const { as } = asWithMandate(true);
    const stays = await planMandateChange({ old: OLD, changes: { limits: { quote_daily_max: 2 } } }, deps(as).d);
    expect(stays.diff.lastsUntil).toBeUndefined();
    expect(stays.plan.ttlSeconds).toBeGreaterThan(86400 * 9);
    expect(stays.plan.ttlSeconds).toBeLessThanOrEqual(86400 * 10);
    const moved = await planMandateChange({ old: OLD, changes: { durationHours: 48 } }, deps(as).d);
    expect(moved.diff.lastsUntil?.tag).toBe('Less');
  });

  it('refuses someone else\'s mandate', async () => {
    const { as } = asWithMandate(true);
    await expect(planMandateChange({ old: { ...OLD, ownerDid: 'did:key:someone' }, changes: { limits: { quote_daily_max: 2 } } }, deps(as).d))
      .rejects.toMatchObject({ code: 'not_your_mandate' });
  });

  it('refuses a mandate no longer active', async () => {
    const { as } = asWithMandate(false);
    await expect(planMandateChange({ old: OLD, changes: { limits: { quote_daily_max: 2 } } }, deps(as).d))
      .rejects.toMatchObject({ code: 'mandate_not_active' });
  });

  it('refuses no change at all', async () => {
    const { as } = asWithMandate(true);
    await expect(planMandateChange({ old: OLD, changes: { limits: { quote_daily_max: 10 } } }, deps(as).d))
      .rejects.toMatchObject({ code: 'no_change' });
  });

  it('refuses a limit the area does not have', async () => {
    const { as } = asWithMandate(true);
    await expect(planMandateChange({ old: OLD, changes: { limits: { totally_new: 1 } } }, deps(as).d))
      .rejects.toThrow(/`limits.totally_new`/);
  });

  it('a mandate on an older version: fields new in the newest version must be given, then appear as New', async () => {
    const older = { ...SALES, id: SALES.id.replace('@0.4', '@0.3'), version: '0.3' };
    const { as } = asWithMandate(true);
    const oldBounds: Record<string, string | number> = { ...LIMITS, profile: older.id };
    delete oldBounds.quote_daily_max; // pretend this limit is new in 0.4
    const fetching: CeremonyDeps['as'] = async (m, p, b) => (p === `/api/profiles/${encodeURIComponent(older.id)}` ? { status: 200, body: older } : as(m, p, b));
    const old = { ...OLD, profileId: older.id, bounds: oldBounds };
    await expect(planMandateChange({ old, changes: {} }, deps(fetching).d)).rejects.toThrow(/needs a value/);
    const { diff } = await planMandateChange({ old, changes: { limits: { quote_daily_max: 7 } } }, deps(fetching).d);
    expect(diff.rows.find((r) => r.field === 'quote_daily_max')).toMatchObject({ tag: 'New', before: null, after: 7 });
    expect(diff.versionMove).toEqual({ from: older.id, to: SALES.id });
  });

  it('a mandate that would differ from what the person saw is refused before signing', async () => {
    const { as, calls } = asWithMandate(true);
    const { diff } = await planMandateChange({ old: OLD, changes: { limits: { quote_daily_max: 15 } } }, deps(as).d);
    await expect(changeMandate({ old: OLD, changes: { limits: { quote_daily_max: 16 } }, sealedDiff: diff }, deps(as).d))
      .rejects.toMatchObject({ code: 'changed_since_proposal' });
    expect(calls.some((c) => c.path === '/api/as/mandate')).toBe(false);
  });

  it('a sealed copy that only changed key order is still the same change', async () => {
    const { as, calls } = asWithMandate(true);
    const { diff } = await planMandateChange({ old: OLD, changes: { limits: { quote_daily_max: 15 } } }, deps(as).d);
    const reorder = (v: any): any => (Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().reverse().map((k) => [k, reorder(v[k])])) : v);
    await changeMandate({ old: OLD, changes: { limits: { quote_daily_max: 15 } }, sealedDiff: reorder(diff) }, deps(as).d);
    expect(calls.some((c) => c.path === '/api/as/mandate')).toBe(true);
  });

  it('after approval: signs with `replaces`, keeps the signed title, reports a failed revoke', async () => {
    const { as, calls } = asWithMandate(true);
    const failing: CeremonyDeps['as'] = async (m, p, b) => (p.endsWith('/revoke') ? { status: 500, body: { error: 'down' } } : as(m, p, b));
    const { diff } = await planMandateChange({ old: OLD, changes: { limits: { quote_daily_max: 15 } } }, deps(as).d);
    const r = await changeMandate({ old: OLD, changes: { limits: { quote_daily_max: 15 } }, sealedDiff: diff }, deps(failing).d);
    expect(r.revokeError).toBe('down');
    expect(calls.find((c) => c.path === '/api/as/mandate')!.body).toMatchObject({ replaces: 'authz_old', title: 'Quotes' });
  });
});
