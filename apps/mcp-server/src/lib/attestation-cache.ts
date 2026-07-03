/**
 * Attestation Cache — local cache of attestations and SP public key.
 *
 * Fetches from SP on-demand and caches with TTL awareness.
 */

import { decodeAttestationBlob, type Subject } from '@hap/core';
import { SPClient, type SPAttestationsResult, type SPPendingItem } from './sp-client';

/**
 * True when the SIGNED commitment_mode requires review but the AS supplied no
 * pending approvers — an inconsistency between the signature and the AS's
 * unsigned routing metadata (a possible commitment-mode downgrade). The
 * Gatekeeper MUST refuse to auto-execute in this case (fail-closed).
 */
export function isCommitmentDowngrade(
  auth: Pick<CachedAuthorization, 'signedCommitmentMode' | 'deferredCommitmentDomains'>,
): boolean {
  const requiresReview =
    auth.signedCommitmentMode === 'review' || auth.signedCommitmentMode === 'review_above_cap';
  return requiresReview && (auth.deferredCommitmentDomains ?? []).length === 0;
}

export interface CachedAuthorization {
  // Per-ceremony identity — THE key for every SP lookup (receipt, proposals,
  // intent, revoke) and for joining local gate content.
  authorizationId: string;
  // Content fingerprint. May collide across grants with identical bounds.
  // Use only for hash-equality checks (e.g. the receipt cross-check).
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
  /**
   * Commitment mode read from the SIGNED attestation payload — NOT from the
   * AS's unsigned JSON. The routing decision (review vs automatic) is enforced
   * against this so a compromised/buggy AS cannot downgrade 'review' →
   * 'automatic' via inconsistent unsigned metadata. Undefined for legacy
   * (v0.3/v0.4) attestations whose payload omits commitment_mode.
   */
  signedCommitmentMode?: 'automatic' | 'review' | 'review_above_cap';
  /**
   * v0.6 Identity Assurance — the signed verified-identity overlay from the
   * attestation (one per owner). Used to render the verification footer's
   * identity line. Absent ⇒ low/pseudonymous (no name).
   */
  subjects?: Subject[];
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
  async syncAuthorization(authorizationId: string): Promise<CachedAuthorization | null> {
    const result = await this.spClient.getAttestations(authorizationId);
    if (!result.profile_id) return null;

    // v0.6 — drop a REVOKED authorization so it is never listed or matched. A
    // revoked-but-unexpired attestation can't issue a receipt, so matching it for
    // a new action only produces dead proposals. Remove any cached copy too.
    if (result.revoked) {
      this.authorizations.delete(authorizationId);
      return null;
    }

    // Lockstep guard: an AS without per-ceremony identity would silently
    // reintroduce fingerprint-merge behavior. Fail loudly, never quietly.
    if (!result.authorization_id) {
      throw new Error(
        'Authority Server response lacks authorization_id — the AS predates ' +
        'per-ceremony identity. Update the Authority Server (lockstep deploy).',
      );
    }
    const bounds = result.bounds ?? result.frame ?? {};

    // Read the commitment mode from the SIGNED payload (all of an authorization's
    // attestations share it). This — not the AS's unsigned deferred_commitment_domains
    // — is the authoritative review-vs-automatic signal.
    let signedCommitmentMode: CachedAuthorization['signedCommitmentMode'];
    let subjects: CachedAuthorization['subjects'];
    const firstBlob = result.attestations[0]?.blob;
    if (firstBlob) {
      try {
        const payload = decodeAttestationBlob(firstBlob).payload;
        signedCommitmentMode = payload.commitment_mode;
        subjects = payload.subjects; // v0.6 Identity Assurance — signed verified identity
      } catch {
        signedCommitmentMode = undefined; // undecodable → no enforcement signal (treated as legacy)
      }
    }

    const auth: CachedAuthorization = {
      authorizationId: result.authorization_id,
      boundsHash: result.bounds_hash,  // content fingerprint (undefined for pre-v0.4 records)
      contextHash: result.context_hash,
      profileId: result.profile_id,
      path: result.profile_id,
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
      signedCommitmentMode,
      subjects,
      complete: result.complete,
    };

    // Key by the per-ceremony id — grants can never merge or overwrite.
    this.authorizations.set(auth.authorizationId, auth);
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
    // Key by the per-ceremony id — grants can never merge or overwrite.
    this.authorizations.set(auth.authorizationId, auth);
  }

  /**
   * Remove a cached authorization by path. Called when the SP reports the
   * attestation has been revoked, so subsequent list calls reflect reality.
   */
  invalidate(path: string): void {
    this.authorizations.delete(path);
  }
}
