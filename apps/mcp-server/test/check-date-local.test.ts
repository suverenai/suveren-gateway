import { describe, it, expect } from 'vitest';
import { localDay } from '../src/lib/checks';

describe('a check\'s |date is the person\'s own day', () => {
  it('uses this computer\'s time zone, not UTC', () => {
    // 2026-11-20 23:30 UTC is already 2026-11-21 in Vienna; the formatter follows the process time zone.
    const d = new Date('2026-11-20T23:30:00Z');
    const expected = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    expect(localDay(d)).toBe(expected);
  });
});

describe('in Vienna', () => {
  it.runIf(process.env.TZ === 'Europe/Vienna')('a check at 00:30 Vienna time shows that day, not yesterday', () => {
    expect(localDay(new Date('2026-11-20T23:30:00Z'))).toBe('2026-11-21');
  });
});
