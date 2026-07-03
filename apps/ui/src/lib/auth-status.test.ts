/**
 * getAuthStatus — pins the "SP verdict is authoritative" contract.
 *
 * Regression history: the time-based fallback used to override
 * sp_status === 'active' (remaining_seconds ≤ 0 or null → 'expired'), so the
 * gateway re-derived a different status than the SP from the same row and the
 * two dashboards disagreed. sp_status now wins whenever present; the local
 * time/completeness derivation applies only to snapshots lacking sp_status.
 */
import { describe, it, expect } from 'vitest';
import { getAuthStatus, bucketAuths } from './auth-status';
import type { PendingItem } from './sp-client';

function item(overrides: Partial<PendingItem>): PendingItem {
  return {
    authorization_id: 'sha256:abc:group-1',
    profile_id: 'email@0.4',
    path: 'email',
    title: null,
    sp_status: 'active',
    frame: {},
    required_domains: ['owner'],
    attested_domains: ['owner'],
    missing_domains: [],
    deferred_commitment_domains: [],
    created_at: '2026-06-04T00:00:00.000Z',
    earliest_expiry: null,
    remaining_seconds: 3600,
    approvers_frozen: [],
    above_cap: false,
    ...overrides,
  };
}

describe('getAuthStatus — sp_status is authoritative when present', () => {
  it("sp_status 'active' wins even when remaining_seconds is null (the old override bug)", () => {
    expect(getAuthStatus(item({ sp_status: 'active', remaining_seconds: null }))).toBe('active');
  });

  it("sp_status 'active' wins even when remaining_seconds is 0", () => {
    expect(getAuthStatus(item({ sp_status: 'active', remaining_seconds: 0 }))).toBe('active');
  });

  it("sp_status 'expired' wins even with time remaining", () => {
    expect(getAuthStatus(item({ sp_status: 'expired', remaining_seconds: 9999 }))).toBe('expired');
  });

  it("sp_status 'revoked' and 'pending' pass through", () => {
    expect(getAuthStatus(item({ sp_status: 'revoked' }))).toBe('revoked');
    expect(getAuthStatus(item({ sp_status: 'pending' }))).toBe('pending');
  });

  it('optimistic local revoke (revokedSet) beats everything', () => {
    const it1 = item({ sp_status: 'active' });
    expect(getAuthStatus(it1, { revokedSet: new Set([it1.authorization_id]) })).toBe('revoked');
  });
});

describe('getAuthStatus — local fallback only when sp_status is absent', () => {
  it('null sp_status + no time remaining → expired', () => {
    expect(getAuthStatus(item({ sp_status: null, remaining_seconds: 0 }))).toBe('expired');
    expect(getAuthStatus(item({ sp_status: null, remaining_seconds: null }))).toBe('expired');
  });

  it('null sp_status + time remaining + missing domains → pending', () => {
    expect(getAuthStatus(item({ sp_status: null, missing_domains: ['owner'] }))).toBe('pending');
  });

  it('null sp_status + time remaining + complete → active', () => {
    expect(getAuthStatus(item({ sp_status: null }))).toBe('active');
  });

  it('unknown sp_status string falls through to the local derivation', () => {
    expect(getAuthStatus(item({ sp_status: 'weird-future-status', remaining_seconds: 10 }))).toBe('active');
  });
});

describe('bucketAuths', () => {
  it('counts follow the same rules (no drift between counting and cards)', () => {
    const items = [
      item({ authorization_id: 'a', sp_status: 'active', remaining_seconds: null }), // old bug: counted expired
      item({ authorization_id: 'b', sp_status: 'expired' }),
      item({ authorization_id: 'c', sp_status: 'revoked' }),
      item({ authorization_id: 'd', sp_status: null, remaining_seconds: 100 }),
    ];
    const buckets = bucketAuths(items);
    expect(buckets.active.map(i => i.authorization_id)).toEqual(['a', 'd']);
    expect(buckets.expired.map(i => i.authorization_id)).toEqual(['b']);
    expect(buckets.revoked.map(i => i.authorization_id)).toEqual(['c']);
  });
});
