/**
 * Gatekeeper must DROP revoked authorizations (v0.6).
 *
 * A revoked-but-unexpired attestation can't issue a receipt, so listing/matching
 * it only produces dead proposals. syncAuthorization (the path that runs on every
 * gate-content push / restart re-sync) must drop it once the AS reports `revoked`.
 */
import { describe, it, expect } from 'vitest';
import { AttestationCache } from '../src/lib/attestation-cache';

const future = Math.floor(Date.now() / 1000) + 3600;
const baseResult = (revoked: boolean) => ({
  frame_hash: revoked ? 'sha256:revoked' : 'sha256:active',
  profile_id: 'email@0.4',
  frame: { recipient_max: 1 },
  attestations: [{ domain: 'owner', blob: 'unparseable-blob', expires_at: future }],
  complete: true,
  revoked,
});

function fakeSP(result: unknown) {
  return { getAttestations: async () => result } as unknown as ConstructorParameters<typeof AttestationCache>[0];
}

describe('AttestationCache.syncAuthorization — revoked filtering', () => {
  it('drops a revoked authorization (returns null, not cached)', async () => {
    const cache = new AttestationCache(fakeSP(baseResult(true)));
    const auth = await cache.syncAuthorization('sha256:revoked');
    expect(auth).toBeNull();
    expect(cache.getAllAuthorizations().some(a => a.frameHash === 'sha256:revoked')).toBe(false);
  });

  it('caches a non-revoked authorization', async () => {
    const cache = new AttestationCache(fakeSP(baseResult(false)));
    const auth = await cache.syncAuthorization('sha256:active');
    expect(auth).not.toBeNull();
    expect(cache.getAllAuthorizations().some(a => a.frameHash === 'sha256:active')).toBe(true);
  });
});
