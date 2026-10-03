import { describe, it, expect } from 'vitest';
import { isPolicyLocked } from './policy-lock';

// AuthorityServerCard and SimulationLockCard both gate their "Set by your IT"
// badge on this predicate — the one place that decides "locked vs unlocked"
// across both Settings surfaces.
describe('isPolicyLocked', () => {
  it('is true only when the backend explicitly says true', () => {
    expect(isPolicyLocked(true)).toBe(true);
  });

  it('is false when the backend explicitly says false', () => {
    expect(isPolicyLocked(false)).toBe(false);
  });

  it('is false when the field is missing (older control-plane) — today\'s behaviour, never a guess', () => {
    expect(isPolicyLocked(undefined)).toBe(false);
    expect(isPolicyLocked(null)).toBe(false);
  });
});
