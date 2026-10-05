import { describe, it, expect } from 'vitest';
import { mandateRight } from './mandate-rights';

/**
 * The mandate screen used to say "Not enabled for <team>" only on its last page,
 * after the person had filled in scope, limits and intent — and it missed the
 * second refusal entirely: a profile WITH approvers, but not this person. Both
 * are the Authority Server's rule; the screen must apply it at selection.
 */
const base = { configLoaded: true, userId: 'u_me', profileName: 'Sales', teamName: 'Sales Vienna' };

describe('mandateRight', () => {
  it('a personal workspace can always, config or not', () => {
    expect(mandateRight({ ...base, isPersonal: true, approvers: undefined })).toEqual({ can: true });
    expect(mandateRight({ ...base, isPersonal: true, approvers: [] })).toEqual({ can: true });
  });

  it('team, no approvers configured → not enabled, an admin fixes it', () => {
    for (const approvers of [undefined, []]) {
      const r = mandateRight({ ...base, isPersonal: false, approvers });
      expect(r).toMatchObject({ can: false, code: 'PROFILE_NOT_ENABLED_FOR_GROUP' });
      if (!r.can) {
        expect(r.reason).toContain('"Sales Vienna"');
        expect(r.fix).toMatch(/team admin/);
      }
    }
  });

  it('team, approvers configured but not me → refused like the AS (OWNER_NOT_APPROVER)', () => {
    const r = mandateRight({ ...base, isPersonal: false, approvers: ['u_bernd'] });
    expect(r).toMatchObject({ can: false, code: 'OWNER_NOT_APPROVER' });
  });

  it('team, I am an approver → can', () => {
    expect(mandateRight({ ...base, isPersonal: false, approvers: ['u_bernd', 'u_me'] })).toEqual({ can: true });
  });

  it('no user id known → not an approver (the safe side)', () => {
    expect(mandateRight({ ...base, isPersonal: false, approvers: ['u_me'], userId: undefined })).toMatchObject({ can: false });
  });

  it('while the config is loading → can (no flicker; the AS still decides)', () => {
    expect(mandateRight({ ...base, isPersonal: false, configLoaded: false, approvers: undefined })).toEqual({ can: true });
  });

  it('a snapshot without isPersonal is treated as a team — the safe side', () => {
    expect(mandateRight({ ...base, approvers: [] })).toMatchObject({ can: false });
  });
});
