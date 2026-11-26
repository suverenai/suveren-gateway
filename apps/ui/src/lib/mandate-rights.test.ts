import { describe, it, expect } from 'vitest';
import { isTeamAdmin, mandateRight } from './mandate-rights';

/**
 * The mandate screen used to say "Not enabled for <team>" only on its last page,
 * after the person had filled in scope, limits and intent — and it missed the
 * second refusal entirely: a profile WITH grantors, but not this person. Both
 * are the Authority Server's rule; the screen must apply it at selection.
 *
 * TR5 (work-plan "Added 2026-10-14"): `approvers` → `grantors` — who may
 * GRANT a mandate, not who may approve an above-cap proposal.
 */
const base = { configLoaded: true, userId: 'u_me', profileName: 'Sales', teamName: 'Sales Vienna' };

describe('mandateRight', () => {
  it('a personal workspace can always, config or not', () => {
    expect(mandateRight({ ...base, isPersonal: true, grantors: undefined })).toEqual({ can: true });
    expect(mandateRight({ ...base, isPersonal: true, grantors: [] })).toEqual({ can: true });
  });

  it('team, no grantors configured → not enabled, an admin fixes it', () => {
    for (const grantors of [undefined, []] as const) {
      const r = mandateRight({ ...base, isPersonal: false, grantors });
      expect(r).toMatchObject({ can: false, code: 'PROFILE_NOT_ENABLED_FOR_GROUP' });
      if (!r.can) {
        expect(r.reason).toContain('"Sales Vienna"');
        expect(r.fix).toMatch(/Ask an admin of .* to enable /);
      }
    }
  });

  it('team, not enabled, the person IS an admin → told to enable it themselves, never to ask an admin', () => {
    for (const grantors of [undefined, []] as const) {
      const r = mandateRight({ ...base, isPersonal: false, grantors, isAdmin: true });
      expect(r).toMatchObject({ can: false, code: 'PROFILE_NOT_ENABLED_FOR_GROUP', adminCanEnable: true });
      if (!r.can) {
        expect(r.fix).not.toMatch(/Ask an admin/);
        expect(r.fix).toMatch(/You are an admin of "Sales Vienna": enable .* in the team's settings/);
      }
    }
    // a non-admin keeps today's text and no link
    const n = mandateRight({ ...base, isPersonal: false, grantors: [], isAdmin: false });
    expect(n).not.toHaveProperty('adminCanEnable');
  });

  it('team, grantors configured but not me → refused like the AS (OWNER_NOT_APPROVER)', () => {
    const r = mandateRight({ ...base, isPersonal: false, grantors: ['u_bernd'] });
    expect(r).toMatchObject({ can: false, code: 'OWNER_NOT_APPROVER' });
  });

  it('team, I am a grantor → can', () => {
    expect(mandateRight({ ...base, isPersonal: false, grantors: ['u_bernd', 'u_me'] })).toEqual({ can: true });
  });

  it('grantors: "all" → can, for every member (no explicit list to check against)', () => {
    expect(mandateRight({ ...base, isPersonal: false, grantors: 'all' })).toEqual({ can: true });
    expect(mandateRight({ ...base, isPersonal: false, grantors: 'all', userId: undefined })).toEqual({ can: true });
  });

  it('no user id known (and grantors is an explicit list) → not a grantor (the safe side)', () => {
    expect(mandateRight({ ...base, isPersonal: false, grantors: ['u_me'], userId: undefined })).toMatchObject({ can: false });
  });

  it('while the config is loading → can (no flicker; the AS still decides)', () => {
    expect(mandateRight({ ...base, isPersonal: false, configLoaded: false, grantors: undefined })).toEqual({ can: true });
  });

  it('a snapshot without isPersonal is treated as a team — the safe side', () => {
    expect(mandateRight({ ...base, grantors: [] })).toMatchObject({ can: false });
  });
});

describe('isTeamAdmin (the Authority Server: the creator is the admin)', () => {
  it('the creator is the admin even when the membership carries no role', () => {
    expect(isTeamAdmin({ createdBy: 'u_me' }, { role: undefined }, 'u_me')).toBe(true);
    expect(isTeamAdmin({ createdBy: 'u_other' }, {}, 'u_me')).toBe(false);
  });
  it('a membership role of admin also counts; nothing known means no', () => {
    expect(isTeamAdmin({}, { role: 'admin' }, 'u_me')).toBe(true);
    expect(isTeamAdmin(null, null, 'u_me')).toBe(false);
    expect(isTeamAdmin({ createdBy: 'u_me' }, null, undefined)).toBe(false);
  });
});

describe('a new profile version the team has not enabled yet (DEC-105)', () => {
  const base = { configLoaded: true, grantors: undefined, userId: 'u1', profileName: 'Email', teamName: 'Muster GmbH', olderEnabledVersion: '0.10' } as const;
  it('a member is told an admin must copy the settings from the older version', () => {
    const r = mandateRight(base);
    expect(r).toMatchObject({ can: false, code: 'PROFILE_NOT_ENABLED_FOR_GROUP', reason: 'A new version of Email is not enabled in "Muster GmbH" yet.', fix: 'Ask an admin of "Muster GmbH" to copy its settings from 0.10 to the new version.' });
  });
  it('an admin is told to copy them, with the link to the team settings', () => {
    const r = mandateRight({ ...base, isAdmin: true });
    expect(r).toMatchObject({ can: false, adminCanEnable: true, fix: 'You are an admin of "Muster GmbH": in the team\'s settings, copy the settings from 0.10 to the new version.' });
  });
  it('without an older enabled version, the plain "not enabled" stays', () => {
    expect(mandateRight({ ...base, olderEnabledVersion: null })).toMatchObject({ reason: 'Not enabled in "Muster GmbH".' });
  });
});
