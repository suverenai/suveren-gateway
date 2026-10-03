import { describe, it, expect } from 'vitest';
import { deriveSimulationPolicy } from './useSimulationPolicy';

// SimulationLockCard renders nothing unless `locked` is true, and shows the
// current on/off state when known — these are the two facts this derivation
// must get right from raw /health JSON.
describe('deriveSimulationPolicy', () => {
  it('locked + on: reports both', () => {
    expect(deriveSimulationPolicy({ simulation: true, policyLocked: ['simulation', 'asUrl'] }))
      .toEqual({ simulation: true, locked: true });
  });

  it('locked + off: reports both', () => {
    expect(deriveSimulationPolicy({ simulation: false, policyLocked: ['simulation'] }))
      .toEqual({ simulation: false, locked: true });
  });

  it('not locked: policyLocked present but without "simulation"', () => {
    expect(deriveSimulationPolicy({ simulation: true, policyLocked: ['asUrl', 'pinTls'] }))
      .toEqual({ simulation: true, locked: false });
  });

  it('older control-plane: no policyLocked field at all — must behave like "not locked", never throw', () => {
    expect(deriveSimulationPolicy({ simulation: true }))
      .toEqual({ simulation: true, locked: false });
  });

  it('missing / malformed payload survives instead of throwing', () => {
    expect(deriveSimulationPolicy(null)).toEqual({ simulation: null, locked: false });
    expect(deriveSimulationPolicy(undefined)).toEqual({ simulation: null, locked: false });
    // @ts-expect-error — defensive at runtime even if the type doesn't allow it
    expect(deriveSimulationPolicy('nonsense')).toEqual({ simulation: null, locked: false });
  });

  it('non-array policyLocked does not crash or falsely report locked', () => {
    // @ts-expect-error — a malformed /health response should never throw
    expect(deriveSimulationPolicy({ simulation: false, policyLocked: 'simulation' }))
      .toEqual({ simulation: false, locked: false });
  });
});
