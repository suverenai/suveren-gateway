import { describe, it, expect } from 'vitest';
import { denialView, sourceName, relativeTime, type Severity } from './RecentBlocks';
import type { DenialReason } from '../lib/sp-client';

// Pure logic only (the JSX sentence is presentation, verified in the browser
// layer). This covers the reason→severity/chip/fix mapping, source names, and
// the relative-time formatter — the parts where a mistake changes behaviour.

describe('denialView — reason → chip / severity / fix route', () => {
  const cases: Array<[DenialReason, string, Severity, string | undefined]> = [
    ['resource',     'Restricted',    'warn', undefined],
    ['spam',         'Spam / Trash',  'info', undefined],
    ['age',          'Too old',       'warn', undefined],
    ['unset_age',    'Needs setup',   'act',  '/integrations'],
    ['read_gate',    'Not granted',   'act',  '/authorizations'],
    ['ungoverned',   'Unconfigured',  'act',  undefined],
    ['query_unsafe', 'Unsafe search', 'info', undefined],
  ];
  it.each(cases)('%s → %s / %s / fix=%s', (reason, chip, sev, fixTo) => {
    const v = denialView(reason);
    expect(v.chip).toBe(chip);
    expect(v.sev).toBe(sev);
    expect(v.fixTo).toBe(fixTo);
  });

  it('only actionable reasons carry a fix link', () => {
    const withFix = cases.filter(([, , , fix]) => fix).map(([r]) => r);
    expect(withFix.sort()).toEqual(['read_gate', 'unset_age']);
  });

  it('every actionable (red) reason has somewhere to send the user', () => {
    for (const [reason, , sev, fixTo] of cases) {
      if (reason === 'unset_age' || reason === 'read_gate') expect(fixTo).toBeTruthy();
      // ungoverned is a manifest defect (no user fix) → red but no route, by design
      if (sev === 'act' && reason === 'ungoverned') expect(fixTo).toBeUndefined();
    }
  });

  it('falls back to a neutral view for an unknown reason', () => {
    const v = denialView('nonsense' as DenialReason);
    expect(v).toEqual({ chip: 'Blocked', sev: 'info' });
  });
});

describe('sourceName', () => {
  it('maps known integration ids to display names', () => {
    expect(sourceName('gmail')).toBe('Gmail');
    expect(sourceName('calendar')).toBe('Google Calendar');
  });
  it('falls back to the raw id for an unknown integration', () => {
    expect(sourceName('weird-mcp')).toBe('weird-mcp');
  });
});

describe('relativeTime', () => {
  const NOW = 1_700_000_000_000;
  const min = 60_000, hr = 3_600_000, day = 86_400_000;
  it('formats buckets', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('Just now');
    expect(relativeTime(NOW - 5 * min, NOW)).toBe('5 min ago');
    expect(relativeTime(NOW - 2 * hr, NOW)).toBe('2 hr ago');
    expect(relativeTime(NOW - 1 * day, NOW)).toBe('Yesterday');
    expect(relativeTime(NOW - 3 * day, NOW)).toBe('3 days ago');
  });
  it('never returns a negative/future time', () => {
    expect(relativeTime(NOW + 5 * min, NOW)).toBe('Just now');
  });
});
