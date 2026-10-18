import { describe, it, expect } from 'vitest';
import { groupIntegrationsForDisplay, groupEntriesByArea } from './integration-grouping';
import type { IntegrationEntry } from '../contexts/IntegrationStatusContext';
import type { AreaCatalogEntry } from './area';

function entry(o: {
  name: string;
  simulation?: unknown;
  state: IntegrationEntry['state'];
  profile?: string;
  /** Area per tool — a per-tool override's own profile (UI spec §13.3: "a
   *  tool serving several areas appears under each"). */
  overrideProfiles?: string[];
  /** The gateway's own (current-mode-aware) block signal — set on a
   *  connector that declares `simulation` but is currently SET to a real
   *  mode (ERP's mode=live), same as a connector with no capability at all. */
  paused?: 'simulation';
}): IntegrationEntry {
  const overrides = Object.fromEntries(
    (o.overrideProfiles ?? []).map((p, i) => [`tool_${i}`, { profile: p }]),
  );
  return {
    id: o.name,
    manifest: {
      id: o.name,
      name: o.name,
      profile: o.profile ?? 'customers',
      simulation: o.simulation ?? null,
      toolGating: { overrides },
    } as unknown as IntegrationEntry['manifest'],
    integration: o.paused
      ? ({ id: o.name, name: o.name, running: false, toolCount: 0, paused: o.paused } as unknown as IntegrationEntry['integration'])
      : undefined,
    state: o.state,
  };
}

const sim = { field: 'mode', default: 'simulation' };

describe('groupIntegrationsForDisplay', () => {
  it('simulation OFF: no grouping — the flat list passes through unchanged', () => {
    const entries = [
      entry({ name: 'ERP', simulation: sim, state: 'running' }),
      entry({ name: 'Gmail', state: 'running' }),
    ];
    const g = groupIntegrationsForDisplay(entries, false);
    expect(g.grouped).toBe(false);
    expect(g.ungrouped).toEqual(entries);
    expect(g.testSystems).toEqual([]);
    expect(g.pausedReal).toEqual([]);
    expect(g.realErrors).toEqual([]);
  });

  it('simulation ON: splits test systems (declare `simulation`) from real systems', () => {
    const erp = entry({ name: 'ERP', simulation: sim, state: 'running' });
    const crm = entry({ name: 'CRM', simulation: sim, state: 'running' });
    const gmail = entry({ name: 'Gmail', state: 'paused' });
    const g = groupIntegrationsForDisplay([erp, crm, gmail], true);
    expect(g.grouped).toBe(true);
    expect(g.testSystems).toEqual([erp, crm]);
    expect(g.pausedReal).toEqual([gmail]);
    expect(g.realErrors).toEqual([]);
    expect(g.ungrouped).toEqual([]);
  });

  it('a real connector with a GENUINE error stays visible as an error — not folded into the paused group', () => {
    const mollie = entry({ name: 'Mollie', state: 'error' });
    const gmail = entry({ name: 'Gmail', state: 'paused' });
    const g = groupIntegrationsForDisplay([mollie, gmail], true);
    expect(g.realErrors).toEqual([mollie]);
    expect(g.pausedReal).toEqual([gmail]);
  });

  it('a real connector never configured at all (not-running, no status entry) is grouped with paused — it cannot run either way', () => {
    const neverConfigured = entry({ name: 'LinkedIn', state: 'not-running' });
    const g = groupIntegrationsForDisplay([neverConfigured], true);
    expect(g.pausedReal).toEqual([neverConfigured]);
    expect(g.realErrors).toEqual([]);
  });

  it('a test system that is not yet activated stays a test system, not a paused real row', () => {
    const emailSim = entry({ name: 'Email (simulation)', simulation: sim, state: 'not-running' });
    const g = groupIntegrationsForDisplay([emailSim], true);
    expect(g.testSystems).toEqual([emailSim]);
    expect(g.pausedReal).toEqual([]);
  });

  it('a connector that declares `simulation` but is currently SET TO LIVE is a real system, not a test system — the core fix', () => {
    const erpLive = entry({ name: 'ERP', simulation: sim, state: 'paused', paused: 'simulation' });
    const g = groupIntegrationsForDisplay([erpLive], true);
    expect(g.testSystems).toEqual([]);
    expect(g.pausedReal).toEqual([erpLive]);
    expect(g.realErrors).toEqual([]);
  });

  it('a connector that declares `simulation`, is currently SET TO LIVE, and ALSO genuinely errors lands in realErrors, not testSystems', () => {
    const erpLiveErrored = entry({ name: 'ERP', simulation: sim, state: 'error', paused: 'simulation' });
    const g = groupIntegrationsForDisplay([erpLiveErrored], true);
    expect(g.testSystems).toEqual([]);
    expect(g.realErrors).toEqual([erpLiveErrored]);
  });

  it('counts match the mockup fixture: 3 test systems, 6 real (one erroring, five paused)', () => {
    const entries: IntegrationEntry[] = [
      entry({ name: 'ERP', simulation: sim, state: 'running' }),
      entry({ name: 'CRM', simulation: sim, state: 'running' }),
      entry({ name: 'Email (simulation)', simulation: sim, state: 'not-running' }),
      entry({ name: 'Gmail', state: 'paused' }),
      entry({ name: 'Google Calendar', state: 'paused' }),
      entry({ name: 'Mollie', state: 'error' }),
      entry({ name: 'LinkedIn', state: 'paused' }),
      entry({ name: 'Records', state: 'paused' }),
      entry({ name: 'Deploy (GitHub)', state: 'paused' }),
    ];
    const g = groupIntegrationsForDisplay(entries, true);
    expect(g.testSystems).toHaveLength(3);
    expect(g.realErrors).toHaveLength(1);
    expect(g.pausedReal).toHaveLength(5);
  });
});

describe('groupEntriesByArea — UI spec §13.3', () => {
  const catalog: AreaCatalogEntry[] = [{ id: 'customers@0.10', name: 'Customers' }];

  it('groups connectors under their manifest-declared area, alphabetically', () => {
    const crm = entry({ name: 'CRM', state: 'running', profile: 'customers' });
    const gmail = entry({ name: 'Gmail', state: 'running', profile: 'email' });
    const g = groupEntriesByArea([crm, gmail], catalog);
    expect(g.map(a => a.name)).toEqual(['Customers', 'Email']);
    expect(g[0].entries).toEqual([crm]);
    expect(g[0].icon).toBe('customers');
  });

  it('two connectors serving the same area both appear under it', () => {
    const gmail = entry({ name: 'Gmail', state: 'running', profile: 'email' });
    const mail = entry({ name: 'Mail (simulation)', state: 'running', profile: 'email' });
    const g = groupEntriesByArea([gmail, mail], catalog);
    expect(g).toHaveLength(1);
    expect(g[0].entries).toEqual([gmail, mail]);
  });

  it('a connector serving several areas (area per tool) appears under each, full entry both times', () => {
    const erp = entry({ name: 'ERP', state: 'running', profile: 'sales', overrideProfiles: ['invoicing'] });
    const gmail = entry({ name: 'Gmail', state: 'running', profile: 'email' });
    const g = groupEntriesByArea([erp, gmail], catalog);
    expect(g.map(a => a.shortId).sort()).toEqual(['email', 'invoicing', 'sales']);
    const sales = g.find(a => a.shortId === 'sales');
    const invoicing = g.find(a => a.shortId === 'invoicing');
    expect(sales?.entries).toEqual([erp]);
    expect(invoicing?.entries).toEqual([erp]);
  });

  it('a connector whose overrides repeat the manifest\'s own profile is not listed twice under it', () => {
    const erp = entry({ name: 'ERP', state: 'running', profile: 'sales', overrideProfiles: ['sales', 'sales'] });
    const g = groupEntriesByArea([erp], catalog);
    expect(g).toHaveLength(1);
    expect(g[0].entries).toEqual([erp]);
  });
});
