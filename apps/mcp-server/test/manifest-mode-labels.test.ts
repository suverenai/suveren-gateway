/**
 * Manifest validation for `modeLabels`/`adapterField` (mode display labels —
 * see simulation-mode.ts's doc comment and content/integrations/erp.json) —
 * manifest-loader.ts's `invalidModeLabelsReason`, and that a malformed
 * manifest is refused WHOLE at load time, same discipline as every other
 * manifest-shape check here.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifests, getManifest, invalidModeLabelsReason } from '../src/lib/manifest-loader';

const MANIFESTS_DIR = join(import.meta.dirname, '..', '..', '..', 'content', 'integrations');

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const BASE = {
  name: 'Test',
  version: '1',
  profile: 'sales',
  mcp: { command: 'node', args: [] },
  toolGating: { default: { executionMapping: {} }, overrides: {} },
  oauth: null,
};

const ERP_SHAPED = {
  ...BASE,
  credentials: {
    fields: [
      { key: 'mode', label: 'Mode', type: 'text', optional: true },
      { key: 'liveAdapter', label: 'Live adapter', type: 'text', optional: true },
    ],
    envMapping: { ERP_MODE: 'mode', ERP_LIVE_ADAPTER: 'liveAdapter' },
  },
  simulation: { field: 'mode', default: 'simulation' },
};

describe('invalidModeLabelsReason', () => {
  it('null when modeLabels is absent', () => {
    expect(invalidModeLabelsReason({ credentials: { fields: [], envMapping: {} } })).toBeNull();
  });

  it('refuses modeLabels without a `simulation` marker — nothing to key the mode off', () => {
    const reason = invalidModeLabelsReason({
      modeLabels: { simulation: 'Test data' },
      credentials: { fields: [], envMapping: {} },
    });
    expect(reason).toMatch(/simulation/);
  });

  it('accepts a plain string label (e.g. mail\'s "Test mailbox")', () => {
    const reason = invalidModeLabelsReason({
      modeLabels: { simulation: 'Test mailbox' },
      simulation: { field: 'mode', default: 'simulation' },
      credentials: { fields: [{ key: 'mode', label: 'Mode', type: 'text' }], envMapping: {} },
    });
    expect(reason).toBeNull();
  });

  it('refuses an empty string label', () => {
    const reason = invalidModeLabelsReason({
      modeLabels: { simulation: '' },
      simulation: { field: 'mode', default: 'simulation' },
      credentials: { fields: [], envMapping: {} },
    });
    expect(reason).toMatch(/non-empty/);
  });

  it('accepts an adapter-keyed object entry WITH a valid adapterField (erp.json\'s shape)', () => {
    const reason = invalidModeLabelsReason({
      modeLabels: { simulation: 'Test data', live: { local: 'Built-in' } },
      adapterField: 'liveAdapter',
      simulation: { field: 'mode', default: 'simulation' },
      credentials: {
        fields: [{ key: 'mode', label: 'Mode', type: 'text' }, { key: 'liveAdapter', label: 'Live adapter', type: 'text' }],
        envMapping: {},
      },
    });
    expect(reason).toBeNull();
  });

  it('refuses an adapter-keyed entry with NO adapterField declared', () => {
    const reason = invalidModeLabelsReason({
      modeLabels: { live: { local: 'Built-in' } },
      simulation: { field: 'mode', default: 'simulation' },
      credentials: { fields: [{ key: 'mode', label: 'Mode', type: 'text' }], envMapping: {} },
    });
    expect(reason).toMatch(/adapterField/);
  });

  it('refuses an adapterField that does not name a declared credential field', () => {
    const reason = invalidModeLabelsReason({
      modeLabels: { live: { local: 'Built-in' } },
      adapterField: 'nonexistentField',
      simulation: { field: 'mode', default: 'simulation' },
      credentials: { fields: [{ key: 'mode', label: 'Mode', type: 'text' }], envMapping: {} },
    });
    expect(reason).toMatch(/nonexistentField/);
  });

  it('refuses a non-string, non-object label value', () => {
    const reason = invalidModeLabelsReason({
      modeLabels: { simulation: 42 as unknown as string },
      simulation: { field: 'mode', default: 'simulation' },
      credentials: { fields: [], envMapping: {} },
    });
    expect(reason).toMatch(/string or an object/);
  });

  it('end to end: loadManifests refuses a manifest whose modeLabels is malformed', () => {
    dir = mkdtempSync(join(tmpdir(), 'hap-mode-labels-'));
    mkdirSync(join(dir, 'bad'));
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ integrations: { bad: 'bad/manifest.json' } }));
    writeFileSync(join(dir, 'bad/manifest.json'), JSON.stringify({
      id: 'bad',
      icon: 'mail',
      description: 'test',
      modeLabels: { live: { local: 'Built-in' } }, // no adapterField
      ...ERP_SHAPED,
    }));
    loadManifests(dir);
    expect(getManifest('bad')).toBeUndefined();
  });

  it('end to end: loadManifests accepts erp.json\'s own shape', () => {
    dir = mkdtempSync(join(tmpdir(), 'hap-mode-labels-ok-'));
    mkdirSync(join(dir, 'erp'));
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ integrations: { erp: 'erp/manifest.json' } }));
    writeFileSync(join(dir, 'erp/manifest.json'), JSON.stringify({
      id: 'erp',
      icon: 'briefcase',
      description: 'test',
      modeLabels: { simulation: 'Test data', live: { local: 'Built-in' } },
      adapterField: 'liveAdapter',
      ...ERP_SHAPED,
    }));
    loadManifests(dir);
    expect(getManifest('erp')).toBeDefined();
    expect(getManifest('erp')?.modeLabels).toEqual({ simulation: 'Test data', live: { local: 'Built-in' } });
  });
});

describe('bundled manifests — content/integrations', () => {
  it('every bundled manifest\'s modeLabels (if any) passes validation', () => {
    const files = readdirSync(MANIFESTS_DIR).filter(f => f.endsWith('.json') && f !== 'index.json');
    let withLabels = 0;
    for (const f of files) {
      const m = JSON.parse(readFileSync(join(MANIFESTS_DIR, f), 'utf8'));
      expect(invalidModeLabelsReason(m), f).toBeNull();
      if (m.modeLabels) withLabels += 1;
    }
    expect(withLabels).toBeGreaterThanOrEqual(3); // erp, crm, mail
  });

  it('erp.json: live/local answers "Built-in", unset/simulation answers "Test data"', () => {
    const erp = JSON.parse(readFileSync(join(MANIFESTS_DIR, 'erp.json'), 'utf8'));
    expect(erp.modeLabels).toEqual({ simulation: 'Test data', live: { local: 'Built-in' } });
    expect(erp.adapterField).toBe('liveAdapter');
  });

  it('crm.json: same shape as erp.json, and its own npmVersion is untouched by this change', () => {
    const crm = JSON.parse(readFileSync(join(MANIFESTS_DIR, 'crm.json'), 'utf8'));
    expect(crm.modeLabels).toEqual({ simulation: 'Test data', live: { local: 'Built-in' } });
    expect(crm.adapterField).toBe('liveAdapter');
    expect(crm.credentials.envMapping.CRM_LIVE_ADAPTER).toBe('liveAdapter');
    expect(crm.npmVersion).toBe('1.5.0');
  });

  it('mail.json: simulation only — "Test mailbox"', () => {
    const mail = JSON.parse(readFileSync(join(MANIFESTS_DIR, 'mail.json'), 'utf8'));
    expect(mail.modeLabels).toEqual({ simulation: 'Test mailbox' });
  });
});
