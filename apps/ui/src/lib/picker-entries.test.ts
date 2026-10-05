import { describe, it, expect } from 'vitest';
import { pickerEntries } from './picker-entries';
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
