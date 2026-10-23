import { describe, it, expect } from 'vitest';
import { expiryOf } from './sp-client';

describe('expiryOf — a mandate row\'s earliest expiry', () => {
  it('reads the v0.7 entries (and the older ones the same way)', () => {
    const at = Math.floor(Date.now() / 1000);
    const r = expiryOf([{ expiresAt: at + 7200 }, { expiresAt: at + 3600 }]);
    expect(r.earliest_expiry).toBe(new Date((at + 3600) * 1000).toISOString());
    expect(r.remaining_seconds).toBeGreaterThan(3500);
    expect(r.remaining_seconds).toBeLessThanOrEqual(3600);
  });
  it('no entries → no expiry; past → 0 remaining', () => {
    expect(expiryOf(undefined)).toEqual({ earliest_expiry: null, remaining_seconds: null });
    expect(expiryOf([])).toEqual({ earliest_expiry: null, remaining_seconds: null });
    expect(expiryOf([{ expiresAt: 1000 }]).remaining_seconds).toBe(0);
  });
});
