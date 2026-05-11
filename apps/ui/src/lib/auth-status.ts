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
   * in the gateway UI, we add the frame_hash to a local Set so the
   * row flips to revoked immediately without waiting for the SSE
   * event. Other surfaces (Dashboard, Sidebar) don't need this — they
   * catch up on the next SSE refresh.
   */
  revokedSet?: Set<string>;
}

export function getAuthStatus(item: PendingItem, opts?: AuthStatusOptions): AuthStatus {
  if (opts?.revokedSet?.has(item.frame_hash)) return 'revoked';
  if (item.sp_status === 'revoked') return 'revoked';
  if (item.sp_status === 'expired') return 'expired';
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
