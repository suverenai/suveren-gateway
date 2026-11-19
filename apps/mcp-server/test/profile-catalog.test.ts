/**
 * The gateway's own profile catalog (`GET /internal/profiles[/:id]`, DEC-77):
 * what the control plane and the UI read instead of the Authority Server's copy.
 * Runs against the REAL loader and the real profiles; fails, never skips, without them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearProfiles, computeProfileHash } from '@hap/core';
import { loadProfiles } from '../src/lib/profile-loader';
import { localProfile, localProfileSummaries } from '../src/lib/profile-catalog';

const PROFILES_DIR = process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');
const index = (): { profiles: Record<string, string> } => JSON.parse(readFileSync(join(PROFILES_DIR, 'index.json'), 'utf8'));

beforeAll(() => { expect(loadProfiles(PROFILES_DIR), `no profiles in ${PROFILES_DIR}`).toBeGreaterThan(10); });
afterAll(() => clearProfiles());

describe('localProfileSummaries', () => {
  it('lists every shipped version exactly once, by full id, and no short-name alias', () => {
    const ids = localProfileSummaries().map((s) => s.id);
    expect([...ids].sort()).toEqual(Object.keys(index().profiles).sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.includes('/') && id.includes('@'))).toBe(true);
  });

  it('carries what the picker and the upgrade prompt need: name, version, description, whatsNew', () => {
    const email = localProfileSummaries().filter((s) => s.id.includes('/email@'));
    expect(email.length).toBeGreaterThan(1);
    for (const s of email) {
      expect(s.name).toBe('Email');
      expect(s.id.endsWith(`@${s.version}`)).toBe(true);
      expect(typeof s.description).toBe('string');
    }
    expect(email.some((s) => typeof s.whatsNew === 'string' && s.whatsNew.length > 0)).toBe(true);
  });
});

describe('localProfile', () => {
  it('serves each shipped profile as loaded from disk — the same content, so the same profile_hash', () => {
    for (const [id, rel] of Object.entries(index().profiles)) {
      const answer = localProfile(id);
      expect(answer.status, id).toBe(200);
      const onDisk = JSON.parse(readFileSync(join(PROFILES_DIR, rel), 'utf8'));
      expect(answer.body).toEqual(onDisk);
      expect(computeProfileHash(answer.body as never), id).toBe(computeProfileHash(onDisk));
    }
  });

  it('answers 404 with a plain reason for an id the gateway does not ship (it is not fetched anywhere)', () => {
    for (const id of ['example.org/profiles/offered-by-the-as@3', 'email', 'github.com/humanagencyprotocol/hap-profiles/email@99']) {
      const a = localProfile(id);
      expect(a.status, id).toBe(404);
      expect(a.body).toMatchObject({ error: 'profile_not_shipped', message: expect.stringContaining('This gateway does not include the area') });
    }
  });

  it('does not serve a short-name alias as a catalog entry', () => {
    expect(localProfile('email').status).toBe(404);
  });
});
