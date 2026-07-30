import { describe, it, expect } from 'vitest';
import { readAgeOf } from '../src/lib/integration-manager';

/**
 * `readAgeOf` is the single definition of "this integration carries a usable
 * local read window". Everything downstream — the status endpoint, the read
 * path's fallback to the signed grant bound — branches on its answer, so the
 * null/0 distinction it draws is load-bearing.
 */
describe('readAgeOf', () => {
  it('treats 0 as a real window ("read nothing"), never as unset', () => {
    // The bug this exists to prevent: a truthiness check (`days || fallback`)
    // turns "read nothing" into "fall back to the grant bound" — reading far
    // MORE than the owner allowed, silently.
    expect(readAgeOf({ readAgeDays: 0 })).toBe(0);
    expect(readAgeOf({ readAgeDays: 0 })).not.toBeNull();
  });

  it('returns the window when one is set', () => {
    expect(readAgeOf({ readAgeDays: 30 })).toBe(30);
    expect(readAgeOf({ readAgeDays: 365 })).toBe(365);
  });

  it('returns null when no local window is set', () => {
    expect(readAgeOf({})).toBeNull();
    expect(readAgeOf({ readAgeDays: undefined })).toBeNull();
  });

  it('rejects values it could not enforce, rather than passing them through', () => {
    // Each of these would otherwise reach the read path as a window. NaN and
    // Infinity matter most: `newer_than:NaNd` is not a constraint, and an
    // infinite window is precisely the unbounded read F11 closed.
    const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.5];
    for (const v of bad) {
      expect(readAgeOf({ readAgeDays: v })).toBeNull();
    }
  });

  it('falls back to null for non-numeric junk from a hand-edited config file', () => {
    // integrations.json is plain JSON on disk and users do edit it.
    const junk = ['30', true, null, {}, []] as unknown[];
    for (const v of junk) {
      expect(readAgeOf({ readAgeDays: v as number })).toBeNull();
    }
  });
});
