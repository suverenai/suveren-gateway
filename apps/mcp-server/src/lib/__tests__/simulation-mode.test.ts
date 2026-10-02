import { describe, it, expect, afterEach } from 'vitest';
import { isSimulationMode, manifestIsSimulated } from '../simulation-mode';

afterEach(() => {
  delete process.env.SUVEREN_SIMULATION;
});

describe('isSimulationMode', () => {
  it('off by default — a normal install is unaffected', () => {
    delete process.env.SUVEREN_SIMULATION;
    expect(isSimulationMode()).toBe(false);
  });

  it('on only for the exact value "1" — never any other truthy-looking string', () => {
    process.env.SUVEREN_SIMULATION = '1';
    expect(isSimulationMode()).toBe(true);
    process.env.SUVEREN_SIMULATION = 'true';
    expect(isSimulationMode()).toBe(false);
    process.env.SUVEREN_SIMULATION = '0';
    expect(isSimulationMode()).toBe(false);
  });
});

describe('manifestIsSimulated', () => {
  it('false for a manifest with no simulation marker (e.g. gmail)', () => {
    expect(manifestIsSimulated({ simulation: null })).toBe(false);
    expect(manifestIsSimulated(undefined)).toBe(false);
  });

  it('true for a manifest that declares one (e.g. erp/crm/mail)', () => {
    expect(manifestIsSimulated({ simulation: { field: 'mode', default: 'simulation' } })).toBe(true);
  });
});
