/**
 * Commitment-mode downgrade defense (#7).
 *
 * The review-vs-automatic routing must be driven by the SIGNED commitment_mode,
 * not the AS's unsigned deferred_commitment_domains. If the signed payload says
 * review but the AS supplied no pending approvers, the Gatekeeper fails closed.
 */
import { describe, it, expect } from 'vitest';
import { encodeAttestationBlob, decodeAttestationBlob, type Attestation } from '@hap/core';
import { isCommitmentDowngrade } from '../src/lib/attestation-cache';

describe('isCommitmentDowngrade — signed commitment_mode enforcement', () => {
  it('flags review with NO deferred approvers (the downgrade)', () => {
    expect(isCommitmentDowngrade({ signedCommitmentMode: 'review', deferredCommitmentDomains: [] })).toBe(true);
  });

  it('flags review_above_cap with no deferred approvers', () => {
    expect(isCommitmentDowngrade({ signedCommitmentMode: 'review_above_cap', deferredCommitmentDomains: [] })).toBe(true);
  });

  it('allows honest review (signed review + deferred approvers present)', () => {
    expect(isCommitmentDowngrade({ signedCommitmentMode: 'review', deferredCommitmentDomains: ['owner'] })).toBe(false);
  });

  it('allows automatic mode', () => {
    expect(isCommitmentDowngrade({ signedCommitmentMode: 'automatic', deferredCommitmentDomains: [] })).toBe(false);
  });

  it('does not enforce on legacy attestations (no signed mode)', () => {
    expect(isCommitmentDowngrade({ signedCommitmentMode: undefined, deferredCommitmentDomains: [] })).toBe(false);
  });
});

describe('signed commitment_mode is readable from the attestation blob', () => {
  it('round-trips commitment_mode through the signed payload (the cache source)', () => {
    const attestation: Attestation = {
      header: { typ: 'HAP-attestation', alg: 'EdDSA' },
      payload: {
        attestation_id: 'a1',
        version: '0.5',
        profile_id: 'records@0.5',
        bounds_hash: 'sha256:00',
        context_hash: 'sha256:00',
        execution_context_hash: 'sha256:00',
        resolved_owners: ['did:key:alice'],
        gate_content_hashes: { intent: 'sha256:00' },
        commitment_mode: 'review',
        issued_at: 1,
        expires_at: 2,
      },
      signature: 'unsigned-test-blob',
    };
    const blob = encodeAttestationBlob(attestation);
    expect(decodeAttestationBlob(blob).payload.commitment_mode).toBe('review');
  });
});
