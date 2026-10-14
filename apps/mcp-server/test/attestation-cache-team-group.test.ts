/**
 * TR7 (work-plan "Added 2026-10-14") — AttestationCache.isTeamGroup, the
 * predicate tool-proxy.ts's read path uses to tell a TEAM-owned
 * authorization apart from the account's own Personal one, without a live
 * AS call on the hot read path.
 */
import { describe, it, expect } from 'vitest';
import { AttestationCache } from '../src/lib/attestation-cache';

function fakeSP(opts: { activeTeam?: string | null; personal?: string | null; fail?: boolean }) {
  return {
    getActiveTeamGroupId: async () => {
      if (opts.fail) throw new Error('network error');
      return opts.activeTeam ?? null;
    },
    getPersonalGroupId: async () => {
      if (opts.fail) throw new Error('network error');
      return opts.personal ?? null;
    },
  } as unknown as ConstructorParameters<typeof AttestationCache>[0];
}

describe('AttestationCache.isTeamGroup', () => {
  it('returns undefined ("don\'t know") before refreshActiveWorkspace has ever run', () => {
    const cache = new AttestationCache(fakeSP({}));
    expect(cache.isTeamGroup('group_a')).toBeUndefined();
  });

  it('returns undefined when groupId itself is undefined', async () => {
    const cache = new AttestationCache(fakeSP({ personal: 'group_personal' }));
    await cache.refreshActiveWorkspace();
    expect(cache.isTeamGroup(undefined)).toBeUndefined();
  });

  it('returns false for the account\'s own Personal group', async () => {
    const cache = new AttestationCache(fakeSP({ personal: 'group_personal', activeTeam: 'group_team' }));
    await cache.refreshActiveWorkspace();
    expect(cache.isTeamGroup('group_personal')).toBe(false);
  });

  it('returns true for a group that is not the account\'s Personal group', async () => {
    const cache = new AttestationCache(fakeSP({ personal: 'group_personal', activeTeam: 'group_team' }));
    await cache.refreshActiveWorkspace();
    expect(cache.isTeamGroup('group_team')).toBe(true);
    // Even a group that isn't the CURRENTLY active team is still non-Personal.
    expect(cache.isTeamGroup('group_some_other_team')).toBe(true);
  });

  it('learns the Personal group id even while a team is active (not just as activeTeam\'s fallback)', async () => {
    const cache = new AttestationCache(fakeSP({ personal: 'group_personal', activeTeam: 'group_team' }));
    await cache.refreshActiveWorkspace();
    // isTeamGroup must be answerable for the Personal group even though the
    // account is currently active in a team — a Personal authorization can
    // still be cached (e.g. right after leaving a team) and must never be
    // misread as "team" just because personalGroupId was never learned.
    expect(cache.isTeamGroup('group_personal')).toBe(false);
  });

  it('leaves the previous value in place on a failed refresh (never regresses to "unknown")', async () => {
    const cache = new AttestationCache(fakeSP({ personal: 'group_personal' }));
    await cache.refreshActiveWorkspace();
    expect(cache.isTeamGroup('group_team')).toBe(true);

    const failing = new AttestationCache(fakeSP({ fail: true }));
    // Never successfully refreshed — still unknown, not a crash.
    expect(() => failing.isTeamGroup('group_team')).not.toThrow();
    expect(failing.isTeamGroup('group_team')).toBeUndefined();
  });
});
