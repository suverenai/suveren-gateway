import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getProfile, clearProfiles } from '@hap/core';
import { loadProfiles } from '../src/lib/profile-loader';
import { join } from 'node:path';

/**
 * The deploy profile has to survive the real loader, not just `JSON.parse`.
 * A profile that parses but exposes the wrong shape fails at the first gated
 * call — which is a bad place to discover a typo in `boundType`.
 */
const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/deploy@0.7';
const PROFILES_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');

beforeAll(() => { loadProfiles(PROFILES_DIR); });
afterAll(() => clearProfiles());

describe('deploy@0.6', () => {
  const p = () => getProfile(PROFILE_ID) as unknown as {
    id: string; version: string;
    boundsSchema: { keyOrder: string[]; fields: Record<string, { boundType?: { kind: string; window?: string } }> };
    contextSchema: { keyOrder: string[]; fields: Record<string, { constraint?: { enforceable?: string[] } }> };
    content_binding?: { version: string; kind: string };
  };

  it('loads through the profile loader', () => {
    expect(p()).toBeTruthy();
    expect(p().version).toBe('0.7');
  });

  it('carries the FULLY QUALIFIED id, like every other profile', () => {
    // The Authority Server serves its profile list from this field. A bare
    // 'deploy' here made the authorization wizard store that as the profile id,
    // fail to fetch it, and bounce the user back to the start with no error
    // shown. The original version of this test asserted the bare name, so it
    // confirmed the bug instead of catching it.
    expect(p().id).toBe(PROFILE_ID);
  });

  it('counts PROMOTIONS cumulatively — the Authority Server enforces this one', () => {
    // A per_transaction bound here would mean the daily cap was never counted
    // across calls, which is the difference between a limit and a suggestion.
    expect(p().boundsSchema.fields.promote_daily_max.boundType)
      .toEqual({ kind: 'cumulative_count', window: 'daily' });
  });

  it('does NOT limit builds — only publication', () => {
    // deploy_daily_max is deliberately gone. Creating a preview harms nobody;
    // spending a publication limit on it would make the cap mean two different
    // things and run out before anything went live.
    expect(p().boundsSchema.fields).not.toHaveProperty('deploy_daily_max');
  });

  it('keeps scope in context, not in bounds', () => {
    // Repos, environments and workflows are scope. Putting them in bounds would
    // ship their values to the Authority Server and make them look like
    // AS-enforced limits, which they are not.
    for (const k of ['allowed_repos', 'allowed_environments', 'allowed_workflows', 'allowed_branches']) {
      expect(p().contextSchema.fields).toHaveProperty(k);
      expect(p().boundsSchema.fields).not.toHaveProperty(k);
    }
  });

  it('every scope field is subset-enforceable', () => {
    for (const k of p().contextSchema.keyOrder) {
      expect(p().contextSchema.fields[k].constraint?.enforceable).toContain('subset');
    }
  });

  it('does NOT pin environment names to an enum', () => {
    // Hosts disagree: GitHub names are user-defined, Vercel has production and
    // preview, Netlify has deploy-preview. An enum here would bake one vendor's
    // vocabulary into the protocol and immediately misfit the others.
    expect(p().contextSchema.fields.allowed_environments).not.toHaveProperty('enum');
  });

  it('declares content binding, so a receipt can commit to a specific commit', () => {
    expect(p().content_binding).toEqual({ version: '1', kind: 'text' });
  });

  it('EVERY bound declares a boundType — undefined semantics fail closed', () => {
    // The Gatekeeper refuses any bound whose enforcement semantics are
    // undefined, so a missing boundType blocks every action under the profile.
    // rollback_allowed shipped without one: the profile loaded, had the right
    // shape, and passed eight tests, because they all asked whether bounds were
    // PRESENT and none asked whether they were ENFORCEABLE.
    for (const [name, def] of Object.entries(p().boundsSchema.fields)) {
      if (name === 'profile') continue; // the profile pointer is not a limit
      expect(def.boundType, `bound "${name}" has no boundType — the Gatekeeper will reject every call`)
        .toBeTruthy();
      expect(typeof def.boundType?.kind).toBe('string');
    }
  });

  it('keyOrder covers exactly the declared fields — hashes depend on it', () => {
    expect(new Set(p().boundsSchema.keyOrder)).toEqual(new Set(Object.keys(p().boundsSchema.fields)));
    expect(new Set(p().contextSchema.keyOrder)).toEqual(new Set(Object.keys(p().contextSchema.fields)));
  });
});
