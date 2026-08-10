/**
 * Single source of truth for authorization status across every UI
 * surface (Dashboard, Sidebar badge, Authorizations page, cards).
 * Without this module, three separate React components each re-derived
 * "what's an active / expired / revoked authorization" inline, and the
 * counts visibly drifted whenever any one of them got patched in
 * isolation.
 *
 * The SP's `/api/attestations/mine` endpoint is the authoritative
 * source — it computes `status` per row based on revoke + expiry +
 * completeness state. The gateway maps that to `PendingItem.sp_status`.
 * `getAuthStatus` honours `sp_status` first, with a time-based fallback
 * for clients that received a stale snapshot.
 *
 * Anything that buckets, counts, or filters authorities by status
 * MUST go through this module. Inline `remaining_seconds` /
 * `sp_status` expressions in components are forbidden — fix the
 * helper here instead.
 */

import type { PendingItem } from './sp-client';

export type AuthStatus = 'active' | 'pending' | 'expired' | 'revoked';

export interface AuthStatusOptions {
  /**
   * Per-session optimistic revocations. When the user clicks "Revoke"
   * in the gateway UI, we add the authorization_id to a local Set so the
   * row flips to revoked immediately without waiting for the SSE
   * event. Other surfaces (Dashboard, Sidebar) don't need this — they
   * catch up on the next SSE refresh.
   */
  revokedSet?: Set<string>;
}

export function getAuthStatus(item: PendingItem, opts?: AuthStatusOptions): AuthStatus {
  if (opts?.revokedSet?.has(item.authorization_id)) return 'revoked';
  // The SP's verdict is authoritative for ALL statuses when present. The
  // previous version let the time-based fallback below override
  // sp_status === 'active': it re-derived a different answer from the same
  // data (earliest-expiry heuristic vs the SP's any-live rule), so the
  // gateway and SP dashboards disagreed about identical rows.
  switch (item.sp_status) {
    case 'revoked': return 'revoked';
    case 'expired': return 'expired';
    case 'active':  return 'active';
    case 'pending': return 'pending';
  }
  // No sp_status (stale snapshot / older SP): derive locally as a fallback.
  if (item.remaining_seconds === null || item.remaining_seconds <= 0) return 'expired';
  if (item.missing_domains.length > 0) return 'pending';
  return 'active';
}

export interface AuthBuckets {
  active: PendingItem[];
  pending: PendingItem[];
  expired: PendingItem[];
  revoked: PendingItem[];
}

export function bucketAuths(items: PendingItem[], opts?: AuthStatusOptions): AuthBuckets {
  const buckets: AuthBuckets = { active: [], pending: [], expired: [], revoked: [] };
  for (const item of items) {
    buckets[getAuthStatus(item, opts)].push(item);
  }
  return buckets;
}

/**
 * Which timestamp belongs next to a status badge, and what it means.
 *
 * Extracted because getting it wrong is invisible: the Authorizations page
 * rendered `created_at` beside the "Expired" badge, so an authority created
 * on Jul 3 and expired on Aug 9 read as "Expired · Jul 3" — weeks off, and
 * indistinguishable from a correct date unless you knew the creation date.
 *
 * Returns null when the meaningful timestamp is unknown; showing the other
 * one "so the row isn't empty" is exactly how that bug happened.
 */
export function statusTimestamp(
  item: Pick<PendingItem, 'created_at' | 'earliest_expiry'>,
  status: AuthStatus,
): { iso: string; meaning: 'expired' | 'created' } | null {
  if (status === 'expired') {
    return item.earliest_expiry ? { iso: item.earliest_expiry, meaning: 'expired' } : null;
  }
  return item.created_at ? { iso: item.created_at, meaning: 'created' } : null;
}
