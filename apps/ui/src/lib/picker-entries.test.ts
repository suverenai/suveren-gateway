import { describe, it, expect } from 'vitest';
import { pickerEntries, findPreselectedEntry } from './picker-entries';
import type { ProfileSummary, IntegrationManifest, McpIntegrationStatus, BuiltinStatus } from './sp-client';

const P = 'github.com/humanagencyprotocol/hap-profiles';
const prof = (id: string): ProfileSummary => ({ id, version: id.split('@')[1], description: `${id} desc`, paths: [] });
const PROFILES = [prof(`${P}/sales@0.2`), prof(`${P}/sales@0.10`), prof(`${P}/delegation@0.1`), prof(`${P}/records@0.5`)];
const MANIFESTS = [
  { id: 'erp', name: 'ERP', profile: 'sales', description: 'Quotes and orders' },
  { id: 'records', name: 'Records', profile: 'records', description: '' },
] as unknown as IntegrationManifest[];
const RUNNING = [{ id: 'erp', running: true }] as unknown as McpIntegrationStatus[];
const SETUP: BuiltinStatus = { id: 'setup', name: 'Test setup', description: 'AI proposes its setup.', profile: `${P}/delegation@0.1`, available: false };

describe('pickerEntries', () => {
  it('one entry per connector, newest profile version, running state', () => {
    const e = pickerEntries(PROFILES, MANIFESTS, RUNNING, []);
    expect(e.map((x) => [x.key, x.profile.id, x.ready])).toEqual([
      ['connector:erp', `${P}/sales@0.10`, true],
      ['connector:records', `${P}/records@0.5`, false],
    ]);
    expect(e[1]).toMatchObject({ setupId: 'records', description: `${P}/records@0.5 desc` });
  });

  it('offers a built-in tool group — it has no manifest, so it was never offered before', () => {
    const e = pickerEntries(PROFILES, MANIFESTS, RUNNING, [SETUP]);
    expect(e.at(-1)).toMatchObject({
      key: 'builtin:setup', name: 'Test setup', kind: 'builtin', profile: { id: `${P}/delegation@0.1` },
      ready: false, unavailableReason: expect.stringMatching(/simulation mode/),
    });
    expect(pickerEntries(PROFILES, [], [], [{ ...SETUP, available: true }])[0]).toMatchObject({ ready: true, unavailableReason: undefined });
  });

  it('leaves out a built-in whose profile the Authority Server does not serve', () => {
    expect(pickerEntries([prof(`${P}/sales@0.2`)], [], [], [SETUP])).toEqual([]);
  });
});

// The dashboard first-run card's "Give the Delegation mandate" button jumps
// straight here via `?profile=delegation` — these are the rules for whether
// that skip is safe, or whether it should fall through to the normal grid.
describe('findPreselectedEntry', () => {
  const entries = pickerEntries(PROFILES, MANIFESTS, RUNNING, [{ ...SETUP, available: true }]);
  const canGive = () => true;

  it('no preselect requested: undefined', () => {
    expect(findPreselectedEntry(entries, null, canGive)).toBeUndefined();
    expect(findPreselectedEntry(entries, undefined, canGive)).toBeUndefined();
  });

  it('matches by short id regardless of the version in the full id', () => {
    expect(findPreselectedEntry(entries, 'delegation', canGive)?.key).toBe('builtin:setup');
    expect(findPreselectedEntry(entries, `${P}/delegation@0.1`, canGive)?.key).toBe('builtin:setup');
  });

  it('not found: falls through (undefined), never throws', () => {
    expect(findPreselectedEntry(entries, 'nonexistent', canGive)).toBeUndefined();
  });

  it('found but not ready (e.g. simulation mode off): falls through', () => {
    const notReady = pickerEntries(PROFILES, MANIFESTS, RUNNING, [SETUP]); // available: false
    expect(findPreselectedEntry(notReady, 'delegation', canGive)).toBeUndefined();
  });

  it('found and ready but canGive refuses (team approver rule): falls through', () => {
    expect(findPreselectedEntry(entries, 'delegation', () => false)).toBeUndefined();
  });
});

describe('intentHint', () => {
  it('carries the manifest\'s and the built-in\'s starter text for the intent', () => {
    const manifests = [{ ...MANIFESTS[0], intentHint: 'Quotes up to my limit.' }] as unknown as IntegrationManifest[];
    const e = pickerEntries(PROFILES, manifests, RUNNING, [{ ...SETUP, intentHint: 'Why — test.' }]);
    expect(e.find((x) => x.key === 'connector:erp')?.intentHint).toBe('Quotes up to my limit.');
    expect(e.find((x) => x.key === 'builtin:setup')?.intentHint).toBe('Why — test.');
  });
  it('no hint → none on the entry', () => {
    expect(pickerEntries(PROFILES, MANIFESTS, RUNNING, [SETUP]).every((x) => x.intentHint === undefined)).toBe(true);
  });
});
