/**
 * v0.8 proposal readers are named by DID (protocol.md → Proposals, rule 2).
 *
 *  - AttestationCache reads, from the SIGNED payload of the most recently
 *    issued mandate (the one the AS checks against), the version, the owner
 *    DID and the signed `above_cap_approvers`.
 *  - tool-proxy's review path hands those to submitProposal under a 0.8
 *    mandate only; under a 0.7 mandate nothing is added (readers by account id).
 */
import { describe, it, expect, vi } from 'vitest';
import { AttestationCache } from '../src/lib/attestation-cache';
import { v08ProposalReaders } from '../src/lib/tool-proxy';

function blob(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ payload, signature: 'sig' })).toString('base64url');
}

function fakeSP(attestations: Array<{ domain: string; blob: string; expires_at: number }>) {
  return {
    getAttestations: vi.fn().mockResolvedValue({
      authorization_id: 'authz_x',
      profile_id: 'p@1',
      bounds_hash: 'sha256:b',
      bounds: {},
      attestations,
      required_domains: ['owner'],
      attested_domains: ['owner'],
      deferred_commitment_domains: ['owner'],
      complete: true,
    }),
    getAuthorizationSummary: vi.fn().mockResolvedValue({ group_id: 'g' }),
  } as unknown as ConstructorParameters<typeof AttestationCache>[0];
}

const now = Math.floor(Date.now() / 1000);
const base = { profile_id: 'p@1', commitment_mode: 'review', issuer: 'did:key:as', bounds_hash: 'sha256:b' };

describe('AttestationCache — proposalReaders from the signed mandate', () => {
  it('takes the most recently issued mandate\'s version, owner DID and signed deciders', async () => {
    const cache = new AttestationCache(fakeSP([
      { domain: 'owner', expires_at: now + 3600, blob: blob({ ...base, mandate_id: 'm-old', version: '0.8', issued_at: now - 100,
        mandate_owners: [{ did: 'did:key:z6MkOwner' }], above_cap_approvers: ['did:key:z6MkOldAppr'] }) },
      { domain: 'owner', expires_at: now + 7200, blob: blob({ ...base, mandate_id: 'm-new', version: '0.8', issued_at: now,
        mandate_owners: [{ did: 'did:key:z6MkOwner' }], above_cap_approvers: ['did:key:z6MkAppr'] }) },
    ]));
    const auth = await cache.syncAuthorization('authz_x');
    expect(auth?.proposalReaders).toEqual({ version: '0.8', ownerDid: 'did:key:z6MkOwner', deciders: ['did:key:z6MkAppr'] });
  });

  it('a personal review mandate has no deciders', async () => {
    const cache = new AttestationCache(fakeSP([
      { domain: 'owner', expires_at: now + 3600, blob: blob({ ...base, mandate_id: 'm', version: '0.8', issued_at: now, mandate_owners: [{ did: 'did:key:z6MkOwner' }] }) },
    ]));
    const auth = await cache.syncAuthorization('authz_x');
    expect(auth?.proposalReaders).toEqual({ version: '0.8', ownerDid: 'did:key:z6MkOwner', deciders: [] });
  });
});

describe('v08ProposalReaders — only under a 0.8 mandate', () => {
  it('0.8: names the owner DID and the signed deciders', () => {
    expect(v08ProposalReaders({ proposalReaders: { version: '0.8', ownerDid: 'did:key:o', deciders: ['did:key:a'] } }))
      .toEqual({ readers: { ownerDid: 'did:key:o', deciders: ['did:key:a'] } });
  });
  it('0.7 or unknown: nothing — readers stay by account id', () => {
    expect(v08ProposalReaders({ proposalReaders: { version: '0.7', ownerDid: 'did:key:o', deciders: [] } })).toEqual({});
    expect(v08ProposalReaders({})).toEqual({});
  });
});
