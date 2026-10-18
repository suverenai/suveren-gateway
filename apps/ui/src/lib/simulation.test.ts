/**
 * The "Simulation" badge must be truthful in both directions: shown whenever the
 * connector answers from its simulated system (including the unset default), and
 * never on a connector that declares nothing or is set to live.
 */
import { describe, it, expect } from 'vitest';
import { isSimulated, declaresSimulation, modeLabel, modeNote } from './simulation';

const erp = { simulation: { field: 'mode', default: 'simulation' } };

describe('isSimulated', () => {
  it('unset mode falls back to the declared default — simulation', () => {
    expect(isSimulated(erp, {})).toBe(true);
    expect(isSimulated(erp, undefined)).toBe(true);
    expect(isSimulated(erp, { mode: '   ' })).toBe(true);
  });

  it('explicit simulation, any case', () => {
    expect(isSimulated(erp, { mode: 'Simulation' })).toBe(true);
  });

  it('live is not simulated', () => {
    expect(isSimulated(erp, { mode: 'live' })).toBe(false);
  });

  it('a connector that declares no simulation is never badged', () => {
    expect(isSimulated({ simulation: null }, { mode: 'simulation' })).toBe(false);
    expect(isSimulated({}, { mode: 'simulation' })).toBe(false);
  });

  it('a default of live means unset is live', () => {
    expect(isSimulated({ simulation: { field: 'mode', default: 'live' } }, {})).toBe(false);
  });
});

describe('declaresSimulation', () => {
  it('true whenever the manifest carries a simulation marker, regardless of its current mode', () => {
    expect(declaresSimulation(erp)).toBe(true);
    // Unlike isSimulated, the current field value is irrelevant here — a
    // connector CAN run simulated even while its credential says "live".
  });

  it('false for a manifest with no marker at all (e.g. gmail) — a real system', () => {
    expect(declaresSimulation({ simulation: null })).toBe(false);
    expect(declaresSimulation({})).toBe(false);
    expect(declaresSimulation(undefined)).toBe(false);
    expect(declaresSimulation(null)).toBe(false);
  });
});

describe('modeLabel', () => {
  const erpWithLabels = {
    simulation: { field: 'mode', default: 'simulation' },
    modeLabels: { simulation: 'Test data', live: { local: 'Built-in' } },
    adapterField: 'liveAdapter',
  };

  it('unset mode falls back to the declared default — "Test data"', () => {
    expect(modeLabel(erpWithLabels, {})).toBe('Test data');
    expect(modeLabel(erpWithLabels, undefined)).toBe('Test data');
  });

  it('live mode with a labelled adapter — "Built-in"', () => {
    expect(modeLabel(erpWithLabels, { mode: 'live', liveAdapter: 'local' })).toBe('Built-in');
  });

  it('live mode with an UNlabelled adapter has no label', () => {
    expect(modeLabel(erpWithLabels, { mode: 'live', liveAdapter: 'sap' })).toBeUndefined();
  });

  it('live mode with no adapter set has no label', () => {
    expect(modeLabel(erpWithLabels, { mode: 'live' })).toBeUndefined();
  });

  it('a plain string label applies regardless of adapter (mail\'s "Test mailbox")', () => {
    const mail = { simulation: { field: 'mode', default: 'simulation' }, modeLabels: { simulation: 'Test mailbox' } };
    expect(modeLabel(mail, {})).toBe('Test mailbox');
  });

  it('no modeLabels declared at all — undefined', () => {
    expect(modeLabel({ simulation: { field: 'mode', default: 'simulation' } }, {})).toBeUndefined();
  });

  it('no simulation marker at all — undefined, even if modeLabels were somehow present', () => {
    expect(modeLabel({ simulation: null, modeLabels: { simulation: 'Test data' } }, {})).toBeUndefined();
  });
});

describe('modeNote — a short line for the current mode', () => {
  const erp = {
    simulation: { field: 'mode', default: 'simulation' },
    modeNotes: { live: { local: 'On this computer — no shared access' } },
    adapterField: 'liveAdapter',
  } as never;
  it('live + local → the note; simulation → none', () => {
    expect(modeNote(erp, { mode: 'live', liveAdapter: 'local' })).toBe('On this computer — no shared access');
    expect(modeNote(erp, { mode: 'simulation' })).toBeUndefined();
    expect(modeNote(erp, {})).toBeUndefined();
  });
});

