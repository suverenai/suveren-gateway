import { describe, it, expect } from 'vitest';
import { groupIntegrationsForDisplay, connectorAreas, sortConnectors, splitByUse } from './integration-grouping';
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

describe('connectorAreas — one card per connector, areas from the manifest', () => {
  const catalog: AreaCatalogEntry[] = [{ id: 'customers@0.10', name: 'Customers' }];

  it('a connector with one area has one chip, named from the catalog', () => {
    const crm = entry({ name: 'CRM', state: 'running', profile: 'customers' });
    const a = connectorAreas(crm.manifest, catalog);
    expect(a.map(x => x.name)).toEqual(['Customers']);
    expect(a[0].icon).toBe('customers');
  });

  it('a connector serving several areas (area per tool) lists them all, alphabetical by name', () => {
    const erp = entry({ name: 'ERP', state: 'running', profile: 'sales', overrideProfiles: ['invoicing', 'master-data'] });
    expect(connectorAreas(erp.manifest, catalog).map(a => a.shortId)).toEqual(['invoicing', 'master-data', 'sales']);
  });

  it('repeated override profiles, or the manifest\'s own, are not listed twice', () => {
    const erp = entry({ name: 'ERP', state: 'running', profile: 'sales', overrideProfiles: ['sales', 'invoicing', 'invoicing'] });
    expect(connectorAreas(erp.manifest, catalog).map(a => a.shortId)).toEqual(['invoicing', 'sales']);
  });

  it('sortConnectors orders by name and keeps one entry per connector', () => {
    const erp = entry({ name: 'ERP', state: 'running', profile: 'sales', overrideProfiles: ['invoicing', 'master-data'] });
    const crm = entry({ name: 'CRM', state: 'running' });
    expect(sortConnectors([erp, crm])).toEqual([crm, erp]);
  });
});

describe('splitByUse — "In use" / "Not set up" (UI spec §20.3)', () => {
  const running = entry({ name: 'CRM', state: 'running' });
  const stopped = entry({ name: 'Records', state: 'not-running' });
  const crashed = entry({ name: 'Mollie', state: 'error' });
  const starting = entry({ name: 'Deploy', state: 'starting' });
  const noAccount = { ...entry({ name: 'Gmail', state: 'running' }), authStatus: 'not_connected' as const };
  const revoked = { ...entry({ name: 'Calendar', state: 'running' }), authStatus: 'failed' as const };

  it('in use = running with the authentication it needs; everything else is not set up', () => {
    const { inUse, notSetUp } = splitByUse([running, stopped, crashed, starting]);
    expect(inUse).toEqual([running]);
    expect(notSetUp).toEqual([stopped, crashed, starting]);
  });

  it('a running OAuth connector whose account is not connected cannot do anything yet: not in use', () => {
    expect(splitByUse([noAccount]).notSetUp).toEqual([noAccount]);
  });

  it('a running connector whose token was revoked stays in use — its card opens to the problem', () => {
    expect(splitByUse([revoked]).inUse).toEqual([revoked]);
  });

  it('keeps every entry exactly once', () => {
    const all = [running, stopped, crashed, starting, noAccount, revoked];
    const { inUse, notSetUp } = splitByUse(all);
    expect(inUse.length + notSetUp.length).toBe(all.length);
  });
});

describe('splitByUse — Paused group', () => {
  it('a connector the gateway paused is neither in use nor not set up', () => {
    const paused = entry({ name: 'CRM', state: 'paused' });
    const running = entry({ name: 'Records', state: 'running' });
    const r = splitByUse([paused, running]);
    expect(r.paused).toEqual([paused]);
    expect(r.inUse).toEqual([running]);
    expect(r.notSetUp).toEqual([]);
  });
});

describe('groupIntegrationsForDisplay — a localOnly connector (Files) in simulation mode', () => {
  it('is a full card with the connectors that run, never under "paused" real systems', () => {
    const files = {
      id: 'files', state: 'running',
      manifest: { id: 'files', name: 'Files', profile: 'files', simulation: null, localOnly: true },
      integration: { id: 'files', name: 'Files', running: true, toolCount: 4 },
    } as unknown as IntegrationEntry;
    const g = groupIntegrationsForDisplay([files], true);
    expect(g.testSystems.map(e => e.id)).toEqual(['files']);
    expect(g.pausedReal).toEqual([]);
    expect(g.realErrors).toEqual([]);
  });
});
