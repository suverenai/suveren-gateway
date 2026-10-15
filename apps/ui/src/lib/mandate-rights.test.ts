import { describe, it, expect } from 'vitest';
import { mandateRight } from './mandate-rights';

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
