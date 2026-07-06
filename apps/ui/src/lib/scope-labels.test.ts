/**
 * formatScopeValue — discovered display names on scope surfaces.
 * Raw values (e.g. Google calendar ids) stay the enforced truth; labels are
 * ceremony-time sugar. Missing labels must degrade to the raw value.
 */
import { describe, it, expect } from 'vitest';
import { formatScopeValue } from './scope-labels';

const CAL_ID = '4d3f0153c607bdd61c2423f8b340db971fb65ce9f86c65ee866913787c46c118@group.calendar.google.com';

describe('formatScopeValue', () => {
  it('renders the label with a shortened id', () => {
    const labels = { allowed_calendars: { [CAL_ID]: 'Emma' } };
    expect(formatScopeValue('allowed_calendars', CAL_ID, labels)).toBe(`Emma (${CAL_ID.slice(0, 10)}…)`);
  });

  it('falls back to the raw value without a label (manual entry, old grants)', () => {
    expect(formatScopeValue('allowed_calendars', CAL_ID, undefined)).toBe(CAL_ID);
    expect(formatScopeValue('allowed_calendars', CAL_ID, { other_field: { x: 'Y' } })).toBe(CAL_ID);
  });

  it('handles comma-joined multi-values, labeling each part independently', () => {
    const labels = { allowed_calendars: { [CAL_ID]: 'Emma' } };
    const value = `${CAL_ID}, primary`;
    expect(formatScopeValue('allowed_calendars', value, labels))
      .toBe(`Emma (${CAL_ID.slice(0, 10)}…), primary`);
  });

  it('short values are never truncated', () => {
    const labels = { allowed_recipients: { 'a@b.com': 'Alice' } };
    expect(formatScopeValue('allowed_recipients', 'a@b.com', labels)).toBe('Alice (a@b.com)');
  });
});
