/**
 * Attestation Cache — local cache of attestations and SP public key.
 *
 * Fetches from SP on-demand and caches with TTL awareness.
 */

import { SPClient, type SPAttestationsResult, type SPPendingItem } from './sp-client';

export interface CachedAuthorization {
  // SP storage key. v0.4 post-b228e58: per-user scoped (`${boundsHash}:${userId}`).
  // Use this for all SP read-by-hash lookups (revoke, intent, receipt, proposals).
  frameHash: string;
  // Content fingerprint. May collide across users with identical bounds.
  // Use only for hash-equality checks and gate-store path-scoping fallback.
  boundsHash?: string;
  contextHash?: string;         // v0.4
  profileId: string;
  path: string;
  frame: Record<string, string | number>;     // v0.3 compat (= bounds for v0.4)
  bounds?: Record<string, string | number>;   // v0.4 bounds
  context?: Record<string, string | number>;  // v0.4 context (from local store)
  attestations: Array<{ domain: string; blob: string; expiresAt: number }>;
  requiredDomains: string[];
  attestedDomains: string[];
  deferredCommitmentDomains: string[];
  complete: boolean;
}

export class AttestationCache {
  private spPublicKey: string | null = null;
  private spPublicKeyFetchedAt = 0;
  private readonly SP_PUBKEY_TTL = 300; // 5 minutes

  /** Cache of authorizations by path (e.g., "payment-routine") */
  private authorizations = new Map<string, CachedAuthorization>();
  private lastSync = 0;

  constructor(private spClient: SPClient) {}

  /**
   * Get the SP public key, fetching from SP if not cached or expired.
   */
  async getPublicKey(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.spPublicKey && (now - this.spPublicKeyFetchedAt) < this.SP_PUBKEY_TTL) {
      return this.spPublicKey;
    }

    this.spPublicKey = await this.spClient.getPublicKey();
    this.spPublicKeyFetchedAt = now;
    return this.spPublicKey;
  }

  /**
   * Get a cached authorization by path. If not cached, returns null.
   * Use syncAuthorization() to fetch from SP.
   */
  getAuthorization(path: string): CachedAuthorization | null {
    const auth = this.authorizations.get(path);
    if (!auth) return null;

    // Check if all attestations have expired
    const now = Math.floor(Date.now() / 1000);
    const hasValid = auth.attestations.some(a => a.expiresAt > now);
    if (!hasValid) {
      this.authorizations.delete(path);
      return null;
    }

    return auth;
  }

  /**
   * Fetch attestation data from SP for a frame hash and cache it.
   */
  async syncAuthorization(frameHash: string): Promise<CachedAuthorization | null> {
    const result = await this.spClient.getAttestations(frameHash);
    if (!result.profile_id || !result.frame) return null;

    // SP returns frame_hash (storage key, per-user) and bounds_hash (content).
    // Track them separately. For v0.3 records that lack bounds_hash, fall back
    // to frame_hash for the content-equivalent.
    const storageHash = result.frame_hash ?? result.bounds_hash;
    const bounds = result.bounds ?? result.frame;

    const auth: CachedAuthorization = {
      frameHash: storageHash,
      boundsHash: result.bounds_hash,  // content fingerprint (undefined for pre-v0.4 records)
      contextHash: result.context_hash,
      profileId: result.profile_id,
      path: result.path ?? result.profile_id,
      frame: bounds,                   // compat alias
      bounds: result.bounds,           // v0.4 (undefined for v0.3)
      attestations: result.attestations.map(a => ({
        domain: a.domain,
        blob: a.blob,
        expiresAt: a.expires_at,
      })),
      requiredDomains: result.required_domains ?? [],
      attestedDomains: result.attested_domains ?? [],
      deferredCommitmentDomains: result.deferred_commitment_domains ?? [],
      complete: result.complete,
    };

    // Key by frameHash (unique per authorization) so multiple grants under the
    // same profile coexist instead of overwriting each other. Fall back to path
    // for legacy records that lack a frameHash.
    this.authorizations.set(auth.frameHash ?? auth.path, auth);
    return auth;
  }

  /**
   * Get all cached authorizations (both active and pending).
   */
  getAllAuthorizations(): CachedAuthorization[] {
    const now = Math.floor(Date.now() / 1000);
    const results: CachedAuthorization[] = [];

    for (const [path, auth] of this.authorizations) {
      const hasValid = auth.attestations.some(a => a.expiresAt > now);
      if (hasValid) {
        results.push(auth);
      } else {
        this.authorizations.delete(path);
      }
    }

    return results;
  }

  /**
   * Fetch pending attestations from SP for a domain.
   */
  async getPendingAttestations(domain: string): Promise<SPPendingItem[]> {
    return this.spClient.getPendingAttestations(domain);
  }

  /**
   * Cache an authorization directly (e.g., from SP response after creation).
   */
  cacheAuthorization(auth: CachedAuthorization): void {
    // Key by frameHash (unique per authorization) so multiple grants under the
    // same profile coexist instead of overwriting each other. Fall back to path
    // for legacy records that lack a frameHash.
    this.authorizations.set(auth.frameHash ?? auth.path, auth);
  }

  /**
   * Remove a cached authorization by path. Called when the SP reports the
   * attestation has been revoked, so subsequent list calls reflect reality.
   */
  invalidate(path: string): void {
    this.authorizations.delete(path);
  }
}
