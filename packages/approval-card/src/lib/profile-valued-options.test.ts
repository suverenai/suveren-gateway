import { describe, it, expect } from 'vitest';
import { newestPerShortName, profileValuedOptions, valuesFromProfiles } from './profile-valued-options';

// Fixtures are made-up catalog entries: the point is that NOTHING here is a
// list in code — every choice comes from the catalog + the workspace.
const P = 'example.com/profiles';
const p = (name: string, version: string, actionTypes: string[] = ['act']) => ({
  id: `${P}/${name}@${version}`,
  boundsSchema: { actionTypes, keyOrder: [], fields: {} },
});
// delegation 0.6's allowed_profiles: subset, requiredFor the mandate action.
const FIELD = { valuesFrom: 'profiles', constraint: { requiredFor: ['mandate'] } };

describe('profile-valued scope options (delegation 0.6 allowed_profiles)', () => {
  const catalog = [p('sales', '0.4'), p('invoicing', '0.1'), p('charge', '0.7'), p('delegating', '0.6', ['brief', 'mandate'])];

  it('an enabled area that no fixed list names (invoicing) is offered', () => {
    const enabled = new Set([`${P}/sales@0.4`, `${P}/invoicing@0.1`]);
    expect(profileValuedOptions(FIELD, catalog, id => enabled.has(id))).toEqual(['invoicing', 'sales']);
  });

  it('an area not enabled in the team is not offered', () => {
    const enabled = new Set([`${P}/sales@0.4`]);
    expect(profileValuedOptions(FIELD, catalog, id => enabled.has(id))).not.toContain('charge');
  });

  it('an area outside the catalog is never offered (nothing is invented)', () => {
    expect(profileValuedOptions(FIELD, catalog, () => true)).not.toContain('nosuch');
  });

  it('a profile that governs the constrained action (grants mandate creation) is never offered — derived, not named', () => {
    expect(profileValuedOptions(FIELD, catalog, () => true)).toEqual(['charge', 'invoicing', 'sales']);
  });

  it('personal workspace: every catalog area except a delegating one', () => {
    expect(profileValuedOptions(FIELD, catalog, () => true)).toHaveLength(3);
  });

  it('one option per short name, from its newest version', () => {
    expect(newestPerShortName([{ id: `${P}/sales@0.4` }, { id: `${P}/sales@0.10` }, { id: `${P}/sales@0.9` }]))
      .toEqual([`${P}/sales@0.10`]);
  });

  it('only a field that declares valuesFrom "profiles" is treated this way (0.5 keeps its enum)', () => {
    expect(valuesFromProfiles(FIELD)).toBe(true);
    expect(valuesFromProfiles({ enum: ['sales'], constraint: { enforceable: ['subset'] } })).toBe(false);
  });
});
