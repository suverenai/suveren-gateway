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
import { loadManifests, getManifest, invalidModeLabelsReason, invalidModeOptionsReason } from '../src/lib/manifest-loader';

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
    expect(erp.modeLabels).toEqual({ simulation: 'Test data', live: { local: 'Local' } });
    expect(erp.adapterField).toBe('liveAdapter');
  });

  it('crm.json: same shape as erp.json, and its own npmVersion is untouched by this change', () => {
    const crm = JSON.parse(readFileSync(join(MANIFESTS_DIR, 'crm.json'), 'utf8'));
    expect(crm.modeLabels).toEqual({ simulation: 'Test data', live: { local: 'Local' } });
    expect(crm.adapterField).toBe('liveAdapter');
    expect(crm.credentials.envMapping.CRM_LIVE_ADAPTER).toBe('liveAdapter');
    // crm-mcp 1.6.0 brings live mode 'local' (CRM_LIVE_ADAPTER=local).
    expect(crm.npmVersion.localeCompare('1.6.0', undefined, { numeric: true })).toBeGreaterThanOrEqual(0);
  });

  it('mail.json: simulation only — "Test mailbox"', () => {
    const mail = JSON.parse(readFileSync(join(MANIFESTS_DIR, 'mail.json'), 'utf8'));
    expect(mail.modeLabels).toEqual({ simulation: 'Test mailbox' });
  });
});

describe('modeNotes — shipped manifests', () => {
  it('CRM says "On this computer — no shared access"; ERP names its outside VAT-ID check (R5); both pass validation', () => {
    const expected: Record<string, string> = {
      'crm.json': 'On this computer — no shared access',
      // ERP Local calls EU VIES (declared in its `network`) — no unqualified "no shared access".
      'erp.json': 'On this computer. VAT-ID checks ask the EU VIES service.',
    };
    for (const f of ['erp.json', 'crm.json']) {
      const m = JSON.parse(readFileSync(join(MANIFESTS_DIR, f), 'utf8'));
      expect(m.modeNotes, f).toEqual({ live: { local: expected[f] } });
      expect(invalidModeLabelsReason({ ...m, modeLabels: m.modeNotes }), f).toBeNull();
    }
  });
});



describe('invalidModeOptionsReason (the mode choice on the connector card)', () => {
  const base = {
    modeLabels: { simulation: 'Test data', live: { local: 'Local' } },
    adapterField: 'liveAdapter',
    simulation: { field: 'mode', default: 'simulation' },
    credentials: {
      fields: [
        { key: 'mode', label: 'Mode', type: 'text' as const },
        { key: 'liveAdapter', label: 'Live adapter', type: 'text' as const },
        { key: 'companyFile', label: 'File', type: 'text' as const },
      ],
      envMapping: {},
    },
  };
  it('null when absent', () => expect(invalidModeOptionsReason(base)).toBeNull());
  it('accepts erp.json\'s shape', () => {
    expect(invalidModeOptionsReason({ ...base, modeOptions: { live: { local: { label: 'On this computer', fields: ['companyFile'] } } } })).toBeNull();
  });
  it('accepts an option object on a string-labelled mode', () => {
    expect(invalidModeOptionsReason({ ...base, modeOptions: { simulation: { explanation: 'Made-up data.' } } })).toBeNull();
  });
  it('refuses a mode that modeLabels does not have', () => {
    expect(invalidModeOptionsReason({ ...base, modeOptions: { staging: { label: 'x' } } })).toMatch(/staging/);
  });
  it('refuses an adapter that modeLabels does not have', () => {
    expect(invalidModeOptionsReason({ ...base, modeOptions: { live: { sap: { label: 'x' } } } })).toMatch(/sap/);
  });
  it('refuses fields that are not declared credential fields', () => {
    expect(invalidModeOptionsReason({ ...base, modeOptions: { live: { local: { fields: ['nope'] } } } })).toMatch(/nope/);
  });
  it('refuses the choice\'s own fields (mode / adapter)', () => {
    expect(invalidModeOptionsReason({ ...base, modeOptions: { live: { local: { fields: ['mode'] } } } })).toMatch(/choice itself/);
  });
  it('refuses unknown keys, empty labels and empty field lists', () => {
    expect(invalidModeOptionsReason({ ...base, modeOptions: { live: { local: { colour: 'red' } } } as never })).toMatch(/unknown key/);
    expect(invalidModeOptionsReason({ ...base, modeOptions: { live: { local: { label: '' } } } })).toMatch(/non-empty/);
    expect(invalidModeOptionsReason({ ...base, modeOptions: { live: { local: { fields: [] } } } })).toMatch(/non-empty/);
  });
  it('refuses a flat object where an adapter-keyed one is needed', () => {
    expect(invalidModeOptionsReason({ ...base, modeOptions: { live: 'x' as never } })).toMatch(/adapter/);
  });
  it('the shipped manifests all pass the full loader', () => {
    dir = undefined;
    for (const id of ['crm', 'erp', 'mail']) {
      const m = JSON.parse(readFileSync(join(MANIFESTS_DIR, `${id}.json`), 'utf8'));
      expect(invalidModeOptionsReason(m)).toBeNull();
    }
  });
});
