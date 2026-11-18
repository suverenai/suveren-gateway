/**
 * Limits only test-data tools use are hidden outside simulation (Andreas,
 * 2026-11-11). Invented manifests and profiles: nothing in the code under test
 * knows these names.
 */
import { describe, it, expect } from 'vitest';
import type { AgentProfile } from '@hap/core';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hiddenLimitKeys, simulationOnlyActionTypes, type ManifestGatingLike } from './simulation-only-limits';

const profile = (id: string, fields: Record<string, unknown>) => ({ id, boundsSchema: { keyOrder: [], fields } }) as unknown as AgentProfile;

const P = profile('example.org/p/things@1.2', {
  make_daily_max: { displayName: 'Things per day', appliesTo: ['make'], boundType: { kind: 'cumulative_count', window: 'daily' } },
  seed_daily_max: { displayName: 'Seeds per day', appliesTo: ['seed'], boundType: { kind: 'cumulative_count', window: 'daily' } },
  any_max: { displayName: 'Anything', boundType: { kind: 'per_transaction', of: 'n' } },
});

const M: ManifestGatingLike = {
  profile: 'things',
  toolGating: {
    default: { staticExecution: {} },
    overrides: {
      make_thing: { staticExecution: { action_type: 'make' } },
      seed_things: { simulationOnly: true, staticExecution: { action_type: 'seed' } },
      unseed_things: { simulationOnly: true, staticExecution: { action_type: 'seed' } },
    },
  },
};

describe('simulationOnlyActionTypes', () => {
  it('an action type only simulation-only tools serve', () => {
    expect([...simulationOnlyActionTypes([M], P.id)]).toEqual(['seed']);
  });
  it('one ordinary tool serving the type in another manifest of the same profile keeps it', () => {
    const other: ManifestGatingLike = { profile: 'other', toolGating: { overrides: { real_seed: { profile: 'things', staticExecution: { action_type: 'seed' } } } } };
    expect(simulationOnlyActionTypes([M, other], P.id).size).toBe(0);
  });
  it('a tool that takes its action type from its arguments makes nothing provably simulation-only', () => {
    const dyn: ManifestGatingLike = { profile: 'things', toolGating: { overrides: { x: { executionMapping: { action_type: 'kind' } } } } };
    expect(simulationOnlyActionTypes([M, dyn], P.id).size).toBe(0);
  });
  it('manifests of other profiles do not count', () => {
    expect(simulationOnlyActionTypes([M], 'example.org/p/else@1').size).toBe(0);
  });
});

describe('hiddenLimitKeys', () => {
  it('outside simulation: the limit whose action types are all simulation-only is hidden', () => {
    expect([...hiddenLimitKeys(P, [M], false)]).toEqual(['seed_daily_max']);
  });
  it('in simulation, or while the mode is not known, everything shows', () => {
    expect(hiddenLimitKeys(P, [M], true).size).toBe(0);
    expect(hiddenLimitKeys(P, [M], null).size).toBe(0);
  });
  it('the shipped manifests: outside simulation the Customers test-data limit is hidden, its write and delete limits are not', () => {
    const dir = join(import.meta.dirname, '..', '..', '..', '..', 'content', 'integrations');
    const manifests = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json')
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as ManifestGatingLike);
    const profilesDir = process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', '..', 'hap-profiles');
    const customers = JSON.parse(readFileSync(join(profilesDir, 'customers', '0.11.profile.json'), 'utf8')) as AgentProfile;
    const hidden = hiddenLimitKeys(customers, manifests, false);
    const appliesTo = (k: string) => (customers.boundsSchema!.fields as Record<string, { appliesTo?: string[] }>)[k].appliesTo;
    expect([...hidden].map(appliesTo)).toEqual([['setup']]);
    expect(hiddenLimitKeys(customers, manifests, true).size).toBe(0);
  });
});
