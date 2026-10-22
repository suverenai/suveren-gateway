import { describe, it, expect } from 'vitest';
import { standOut } from './approval-row';
import type { PreviewResponse } from './sp-client';

const ok = (checks: unknown): PreviewResponse => ({ status: 'ok', integration: 'erp', readAt: 1, reads: [], checks } as unknown as PreviewResponse);

describe('standOut — the one thing a list row shows (UI spec §17.1)', () => {
  it('is nothing before the card has read anything, or when all checks pass', () => {
    expect(standOut(undefined)).toBeUndefined();
    expect(standOut({ status: 'none' })).toBeUndefined();
    expect(standOut(ok([{ key: 'a', label: 'Totals match', status: 'pass' }]))).toBeUndefined();
    expect(standOut(ok(undefined))).toBeUndefined();
  });
  it('names a notice, e.g. "Price above list"', () => {
    expect(standOut(ok([{ key: 'p', label: 'Price above list', status: 'notice' }, { key: 'a', label: 'ok', status: 'pass' }]))).toBe('Price above list');
  });
  it('a failed check outranks a not-checked line, which outranks a notice', () => {
    const checks = [
      { key: 'n', label: 'A notice', status: 'notice' },
      { key: 'c', label: 'Not checked one', status: 'not_checked' },
      { key: 'f', label: 'Failed one', status: 'fail' },
    ];
    expect(standOut(ok(checks))).toBe('Failed one');
    expect(standOut(ok(checks.slice(0, 2)))).toBe('Not checked one');
  });
});
