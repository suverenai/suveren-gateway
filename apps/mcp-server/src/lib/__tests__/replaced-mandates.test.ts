/**
 * A replaced mandate is no longer honoured on this gateway, even while the
 * Authority Server still serves it (its revoke there failed): the attestation
 * cache never lists or matches it, and the record survives a restart.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttestationCache } from '../attestation-cache';
import { ReplacedMandates } from '../replaced-mandates';
import type { SPClient, SPAttestationsResult } from '../sp-client';

const now = Math.floor(Date.now() / 1000);

/** The AS still serves every authorization — as after a failed revoke. */
function asStillServing(): SPClient {
  return {
    async getAttestations(authorizationId: string): Promise<SPAttestationsResult> {
      return {
        authorization_id: authorizationId,
        attestations: [{ domain: 'owner', blob: '', expires_at: now + 3600 }],
        complete: true,
        profile_id: 'sales@1.0',
        bounds: {},
        required_domains: ['owner'],
        attested_domains: ['owner'],
      };
    },
    async getAuthorizationSummary() { return null; },
  } as unknown as SPClient;
}

describe('replaced mandates are not honoured locally', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'replaced-')); });

  it('the AS still serves the old mandate, but the cache neither syncs, lists nor matches it', async () => {
    const store = new ReplacedMandates(dir);
    const cache = new AttestationCache(asStillServing());
    cache.useReplacedMandates((id) => store.has(id));

    expect(await cache.syncAuthorization('authz_old')).not.toBeNull();
    expect(await cache.syncAuthorization('authz_new')).not.toBeNull();
    expect(cache.getAllAuthorizations().map((a) => a.authorizationId).sort()).toEqual(['authz_new', 'authz_old']);

    store.record('authz_old', 'authz_new');

    expect(cache.getAuthorization('authz_old')).toBeNull();
    expect(cache.getAllAuthorizations().map((a) => a.authorizationId)).toEqual(['authz_new']);
    // A resync against the AS (which still serves it) does not bring it back.
    expect(await cache.syncAuthorization('authz_old')).toBeNull();
    expect(cache.getAllAuthorizations().map((a) => a.authorizationId)).toEqual(['authz_new']);
  });

  it('the record survives a restart (a new store reads the same file)', () => {
    const a = new ReplacedMandates(dir);
    a.record('authz_old', 'authz_new', 1000);
    a.noteAttempt('authz_old', 'status 503', 2000);
    const b = new ReplacedMandates(dir);
    expect(b.has('authz_old')).toBe(true);
    expect(b.get('authz_old')).toEqual({ authorizationId: 'authz_old', replacedBy: 'authz_new', since: 1000, attempts: 1, lastError: 'status 503', lastAttemptAt: 2000 });
    const cache = new AttestationCache(asStillServing());
    cache.useReplacedMandates((id) => b.has(id));
    return cache.syncAuthorization('authz_old').then((r) => expect(r).toBeNull());
  });

  it('cleared once the AS confirmed the revoke, also after a restart', () => {
    const a = new ReplacedMandates(dir);
    a.record('authz_old', 'authz_new');
    a.clear('authz_old');
    expect(new ReplacedMandates(dir).list()).toEqual([]);
  });

  it('an unreadable record fails visibly instead of honouring old mandates again', () => {
    writeFileSync(join(dir, 'replaced-mandates.json'), '{not json');
    expect(() => new ReplacedMandates(dir)).toThrow(/unreadable/);
  });
});
