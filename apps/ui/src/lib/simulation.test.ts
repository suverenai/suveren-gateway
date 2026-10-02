/**
 * The "Simulation" badge must be truthful in both directions: shown whenever the
 * connector answers from its simulated system (including the unset default), and
 * never on a connector that declares nothing or is set to live.
 */
import { describe, it, expect } from 'vitest';
import { isSimulated, declaresSimulation } from './simulation';

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
