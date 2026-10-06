/**
 * Report display formatters (polish 2026-10-05: "no raw technical values
 * anywhere a manager reads") — see src/lib/report/format.ts's own doc
 * comment for why these exist and where they are used.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registerProfile, clearProfiles, type AgentProfile } from '@hap/core';
import {
  formatDateTime, formatDuration, formatCurrency, formatBoundValue, formatBoundLabel,
  formatOwnerLabel, profileShortLabel, formatActionLabel, formatMetricValue, METRIC_LABELS,
} from '../../src/lib/report/format';

describe('formatDateTime', () => {
  it('renders a human "D Mon, HH:MM" shape, never raw unix seconds', () => {
    const out = formatDateTime(1_800_000_000);
    expect(out).toMatch(/^\d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}$/);
    expect(out).not.toContain('1800000000');
  });

  it('is deterministic for a fixed instant (same local calendar date/time every run)', () => {
    // 2024-01-01T00:00:00Z — picked away from any DST boundary.
    const out = formatDateTime(1_704_067_200);
    expect(out).toMatch(/^(31 Dec|1 Jan), \d{2}:\d{2}$/);
  });

  it('REFUSAL: a non-numeric value never produces "NaN" or an empty string', () => {
    expect(formatDateTime('not-a-time')).toBe('unknown time');
    expect(formatDateTime(undefined)).toBe('unknown time');
  });
});

describe('formatDuration', () => {
  it('under an hour: plain minutes', () => {
    expect(formatDuration(1800)).toBe('30 min');
  });

  it('an hour or more: "H h MM min", zero-padded minutes', () => {
    expect(formatDuration(3900)).toBe('1 h 05 min'); // 65 minutes
    expect(formatDuration(7200)).toBe('2 h 00 min');
  });

  it('never a raw second count', () => {
    expect(formatDuration(1800)).not.toContain('1800');
  });

  it('REFUSAL: negative or non-numeric durations are reported as unknown, not "NaN min"', () => {
    expect(formatDuration(-5)).toBe('unknown duration');
    expect(formatDuration('x')).toBe('unknown duration');
  });
});

describe('formatCurrency', () => {
  it('known currencies render with their symbol and a space-grouped amount', () => {
    expect(formatCurrency(4380, 'EUR')).toBe('€ 4 380');
    expect(formatCurrency(5000, 'usd')).toBe('$ 5 000');
  });

  it('an unknown currency code shows the code itself, not a silently wrong symbol', () => {
    expect(formatCurrency(100, 'CHF')).toBe('CHF 100');
  });

  it('no currency at all still groups the number', () => {
    expect(formatCurrency(5000, undefined)).toBe('5 000');
  });
});

describe('formatBoundValue', () => {
  it('formats each known unit with its own suffix/symbol', () => {
    expect(formatBoundValue('minutes', 90)).toBe('90 min');
    expect(formatBoundValue('hours', 4)).toBe('4 h');
    expect(formatBoundValue('days', 7)).toBe('7 d');
    expect(formatBoundValue('percent', 15)).toBe('15%');
    expect(formatBoundValue('currency:EUR', 5000)).toBe('€ 5 000');
    expect(formatBoundValue('count', 3)).toBe('3');
  });

  it('a bound with no unit at all falls back to the mandate context currency when given', () => {
    expect(formatBoundValue(undefined, 5000, 'EUR')).toBe('€ 5 000');
  });

  it('a bound with no unit and no fallback currency is a plain grouped number', () => {
    expect(formatBoundValue(undefined, 5000)).toBe('5 000');
  });
});

describe('formatBoundLabel — reads displayName/unit from the profile registry (getProfile)', () => {
  const PROFILE_ID = 'test-format-profile@0.1';

  beforeEach(() => {
    registerProfile(PROFILE_ID, {
      id: PROFILE_ID,
      boundsSchema: {
        keyOrder: ['value_max'],
        fields: {
          value_max: { type: 'number', required: true, displayName: 'Max value per quote', unit: 'currency:EUR' },
        },
      },
    } as unknown as AgentProfile);
  });

  afterEach(() => clearProfiles());

  it('uses the profile\'s own displayName and unit', () => {
    expect(formatBoundLabel(PROFILE_ID, 'value_max', 5000)).toBe('Max value per quote: € 5 000');
  });

  it('REFUSAL: a field with no declared displayName falls back to a humanized key, never the bare key', () => {
    expect(formatBoundLabel(PROFILE_ID, 'order_daily_max', 10)).toBe('Order Daily Max: 10');
  });

  it('REFUSAL: an unknown/unregistered profile also falls back to a humanized key', () => {
    expect(formatBoundLabel('no-such-profile@9.9', 'send_daily_max', 5)).toBe('Send Daily Max: 5');
  });
});

describe('formatOwnerLabel — a did:key is never shown bare', () => {
  it('labels a did:key with its own truncated tail', () => {
    expect(formatOwnerLabel('did:key:zOwner9')).toBe('Owner (key …Owner9)');
  });

  it('never returns the raw did string unlabeled', () => {
    const out = formatOwnerLabel('did:key:zSomeLongKeyMaterial');
    expect(out).not.toBe('did:key:zSomeLongKeyMaterial');
    expect(out).toContain('Owner');
  });

  it('an empty id is "Unknown owner", not a blank label', () => {
    expect(formatOwnerLabel('')).toBe('Unknown owner');
  });
});

describe('profileShortLabel', () => {
  it('capitalizes the short profile name, dropping the version', () => {
    expect(profileShortLabel('reporting@0.1')).toBe('Reporting');
    expect(profileShortLabel('github.com/humanagencyprotocol/hap-profiles/sales@0.3')).toBe('Sales');
  });

  it('an unknown profile id is reported as such, not left blank', () => {
    expect(profileShortLabel(undefined)).toBe('Unknown profile');
  });
});

describe('formatActionLabel — human labels for tool names (raw name stays in the technical details only)', () => {
  it('maps the known actions the brief calls out by name', () => {
    expect(formatActionLabel('erp__create_quote')).toBe('Quote created');
    expect(formatActionLabel('erp__convert_quote_to_order')).toBe('Order placed');
    expect(formatActionLabel('mail__send_message')).toBe('Reply sent');
    expect(formatActionLabel('email__send_message')).toBe('Reply sent');
  });

  it('falls back to a generic verb+object split for an action it does not know', () => {
    expect(formatActionLabel('calendar__book_meeting')).toBe('Meeting booked');
  });

  it('REFUSAL: never renders the raw system-prefixed tool name itself', () => {
    expect(formatActionLabel('erp__create_quote')).not.toContain('erp__');
  });

  it('irregular verbs read as English — "Report written", never "Report writed" (review SR6, 2026-10-06)', () => {
    expect(formatActionLabel('report__write_report')).toBe('Report written');
    expect(formatActionLabel('mail__send_reminder')).toBe('Reminder sent');
    expect(formatActionLabel('deploy__run_workflow')).toBe('Workflow run');
    expect(formatActionLabel('erp__set_price')).toBe('Price set');
    expect(formatActionLabel('erp__make_offer')).toBe('Offer made');
    expect(formatActionLabel('ci__build_release')).toBe('Release built');
    expect(formatActionLabel('erp__pay_invoice')).toBe('Invoice paid');
    expect(formatActionLabel('crm__apply_discount')).toBe('Discount applied');
    expect(formatActionLabel('deploy__stop_service')).toBe('Service stopped');
    expect(formatActionLabel('erp__submit_order')).toBe('Order submitted');
    // Regular verbs are unchanged.
    expect(formatActionLabel('calendar__book_meeting')).toBe('Meeting booked');
    expect(formatActionLabel('erp__approve_quote')).toBe('Quote approved');
  });

  it('an empty/missing action is reported as "Action", not blank', () => {
    expect(formatActionLabel(undefined)).toBe('Action');
    expect(formatActionLabel('')).toBe('Action');
  });
});

describe('formatMetricValue — shared between the drawn card and "Checked values"', () => {
  it('"without-approval" renders as a rounded percentage', () => {
    expect(formatMetricValue('without-approval', 0.625)).toBe('63%');
  });

  it('time-based kinds render as a duration, never raw seconds', () => {
    expect(formatMetricValue('median-time', 1800)).toBe('30 min');
    expect(formatMetricValue('average-time', 3900)).toBe('1 h 05 min');
    expect(formatMetricValue('median-approval-wait', 1800)).toBe('30 min');
  });

  it('a plain count kind renders as-is', () => {
    expect(formatMetricValue('completed', 8)).toBe('8');
  });
});

describe('METRIC_LABELS', () => {
  it('covers every metric kind the brief defines', () => {
    for (const kind of ['completed', 'median-time', 'average-time', 'without-approval', 'approvals', 'median-approval-wait', 'tickets', 'refusals']) {
      expect(METRIC_LABELS[kind]).toBeTruthy();
    }
  });
});
