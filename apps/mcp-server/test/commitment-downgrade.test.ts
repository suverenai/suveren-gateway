/**
 * Commitment-mode downgrade defense (#7).
 *
 * The review-vs-automatic routing must be driven by the SIGNED commitment_mode,
 * not the AS's unsigned deferred_commitment_domains. If the signed payload says
 * review but the AS supplied no pending approvers, the Gatekeeper fails closed.
 */
import { describe, it, expect } from 'vitest';
import { encodeMandateBlob, decodeMandateBlob, type Mandate } from '@hap/core';
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
    const mandate: Mandate = {
      header: { typ: 'HAP-mandate', alg: 'EdDSA' },
      payload: {
        mandate_id: 'a1',
        version: '0.7',
        profile_id: 'records@0.5',
        bounds_hash: 'sha256:00',
        scope_hash: 'sha256:00',
        execution_context_hash: 'sha256:00',
        profile_hash: 'sha256:00',
        issuer: 'did:key:zTest',
        mandate_owners: [{ did: 'did:key:alice' }],
        gate_content_hashes: { intent: 'sha256:00' },
        commitment_mode: 'review',
        issued_at: 1,
        expires_at: 2,
      },
      signature: 'unsigned-test-blob',
    };
    const blob = encodeMandateBlob(mandate);
    expect(decodeMandateBlob(blob).payload.commitment_mode).toBe('review');
  });
});
