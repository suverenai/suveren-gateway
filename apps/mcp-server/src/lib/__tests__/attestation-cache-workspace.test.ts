/**
 * WS3 defence-in-depth (work-plan "Added 2026-10-11 — an account is
 * Personal OR in one team"): AttestationCache must never SELECT (list or
 * match) a mandate whose group is not the account's current active
 * workspace — a second, local check independent of the Authority Server's
 * own filtering (decision 6, WS2), for the window a stale/buggy cache
 * entry could otherwise slip through in.
 */
import { describe, it, expect } from 'vitest';
import { AttestationCache } from '../attestation-cache';
import type { SPClient, SPAttestationsResult, SPAuthorizationSummary } from '../sp-client';

const now = Math.floor(Date.now() / 1000);

function attestationsResult(authorizationId: string, profileId = 'sales@1.0'): SPAttestationsResult {
  return {
    authorization_id: authorizationId,
    attestations: [{ domain: 'owner', blob: '', expires_at: now + 3600 }],
    complete: true,
    profile_id: profileId,
    bounds: {},
    required_domains: ['owner'],
    attested_domains: ['owner'],
  };
}

/** A minimal fake implementing only what AttestationCache actually calls. */
function fakeSpClient(opts: {
  groupIdByAuthz?: Record<string, string>;
  activeTeamGroupId?: string | null | (() => Promise<string | null>);
  personalGroupId?: string | null;
  summaryFails?: boolean;
  workspaceCallsFail?: boolean;
}): SPClient {
  return {
    async getAttestations(authorizationId: string) {
      return attestationsResult(authorizationId);
    },
    async getAuthorizationSummary(authorizationId: string): Promise<SPAuthorizationSummary | null> {
      if (opts.summaryFails) throw new Error('network blip');
      const groupId = opts.groupIdByAuthz?.[authorizationId];
      if (!groupId) return null;
      return { authorization_id: authorizationId, profile_id: 'sales@1.0', group_id: groupId };
    },
    async getActiveTeamGroupId(): Promise<string | null> {
      if (opts.workspaceCallsFail) throw new Error('network blip');
      if (typeof opts.activeTeamGroupId === 'function') return opts.activeTeamGroupId();
      return opts.activeTeamGroupId ?? null;
    },
    async getPersonalGroupId(): Promise<string | null> {
      if (opts.workspaceCallsFail) throw new Error('network blip');
      return opts.personalGroupId ?? null;
    },
  } as unknown as SPClient;
}

describe('AttestationCache — WS3 workspace filtering', () => {
  it('before any refreshActiveWorkspace(), does not filter (unknown ⇒ no filter)', async () => {
    const cache = new AttestationCache(fakeSpClient({ groupIdByAuthz: { authz_1: 'grp_team' } }));
    await cache.syncAuthorization('authz_1');
    expect(cache.getAllAuthorizations().map(a => a.authorizationId)).toEqual(['authz_1']);
  });

  it('keeps a mandate whose group IS the active team', async () => {
    const sp = fakeSpClient({ groupIdByAuthz: { authz_1: 'grp_team' }, activeTeamGroupId: 'grp_team' });
    const cache = new AttestationCache(sp);
    await cache.refreshActiveWorkspace();
    await cache.syncAuthorization('authz_1');
    expect(cache.getAllAuthorizations().map(a => a.authorizationId)).toEqual(['authz_1']);
    expect(cache.getAuthorization('authz_1')).not.toBeNull();
  });

  it('DROPS a mandate whose group is a DIFFERENT team than the active one', async () => {
    const sp = fakeSpClient({ groupIdByAuthz: { authz_1: 'grp_other_team' }, activeTeamGroupId: 'grp_team' });
    const cache = new AttestationCache(sp);
    await cache.refreshActiveWorkspace();
    await cache.syncAuthorization('authz_1');
    expect(cache.getAllAuthorizations()).toEqual([]);
    expect(cache.getAuthorization('authz_1')).toBeNull();
  });

  it('DROPS a Personal mandate while the account is active in a team', async () => {
    const sp = fakeSpClient({
      groupIdByAuthz: { authz_personal: 'grp_personal' },
      activeTeamGroupId: 'grp_team',
    });
    const cache = new AttestationCache(sp);
    await cache.refreshActiveWorkspace();
    await cache.syncAuthorization('authz_personal');
    expect(cache.getAllAuthorizations()).toEqual([]);
  });

  it('keeps a Personal mandate when the account is Personal (no active team)', async () => {
    const sp = fakeSpClient({
      groupIdByAuthz: { authz_personal: 'grp_personal' },
      activeTeamGroupId: null,
      personalGroupId: 'grp_personal',
    });
    const cache = new AttestationCache(sp);
    await cache.refreshActiveWorkspace();
    await cache.syncAuthorization('authz_personal');
    expect(cache.getAllAuthorizations().map(a => a.authorizationId)).toEqual(['authz_personal']);
  });

  it('does not filter when the per-authorization groupId lookup itself failed (unknown ⇒ no filter)', async () => {
    const sp = fakeSpClient({ activeTeamGroupId: 'grp_team', summaryFails: true });
    const cache = new AttestationCache(sp);
    await cache.refreshActiveWorkspace();
    await cache.syncAuthorization('authz_1');
    // groupId stayed undefined — never guessed — so this is NOT treated as foreign.
    expect(cache.getAllAuthorizations().map(a => a.authorizationId)).toEqual(['authz_1']);
  });

  it('refreshActiveWorkspace() keeps the previous value when the Authority Server calls fail', async () => {
    let fail = false;
    const sp = fakeSpClient({
      groupIdByAuthz: { authz_1: 'grp_team' },
      activeTeamGroupId: () => (fail ? Promise.reject(new Error('down')) : Promise.resolve('grp_team')),
      workspaceCallsFail: false,
    });
    const cache = new AttestationCache(sp);
    await cache.refreshActiveWorkspace(); // learns grp_team
    await cache.syncAuthorization('authz_1');
    expect(cache.getAllAuthorizations()).toHaveLength(1); // matches — kept

    fail = true;
    await cache.refreshActiveWorkspace(); // AS unreachable this time
    expect(cache.getAllAuthorizations()).toHaveLength(1); // still kept — stale value, not cleared
  });

  it('never throws from refreshActiveWorkspace() itself on a network failure', async () => {
    const sp = fakeSpClient({ workspaceCallsFail: true });
    const cache = new AttestationCache(sp);
    await expect(cache.refreshActiveWorkspace()).resolves.toBeUndefined();
  });
});
