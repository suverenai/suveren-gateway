import { describe, it, expect } from 'vitest';
import { groupIntegrationsForDisplay } from './integration-grouping';
import type { IntegrationEntry } from '../contexts/IntegrationStatusContext';

function entry(o: { name: string; simulation?: unknown; state: IntegrationEntry['state'] }): IntegrationEntry {
  return {
    id: o.name,
    manifest: { id: o.name, name: o.name, simulation: o.simulation ?? null } as unknown as IntegrationEntry['manifest'],
    integration: undefined,
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
