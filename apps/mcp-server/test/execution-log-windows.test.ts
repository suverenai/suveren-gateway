/**
 * Cumulative windows must mean the same thing here as at the Authority Server.
 *
 * The AS enforces: daily/weekly ROLLING, monthly CALENDAR (anchored to the 1st
 * at 00:00 UTC — see receipts-store). The gateway computes the figure shown to
 * the agent, and used a rolling 30 days for monthly — so just after a month
 * boundary the agent could be told "48 of 50 used" and hold back while the AS
 * had already reset to zero, and the reverse near month end. Nothing unsafe,
 * since the enforcing side was the strict one, but the number reported did not
 * describe the rule being applied.
 *
 * Tests the cutoff function directly rather than through ExecutionLog: record()
 * prunes anything older than 31 days from the real clock, so a log-level test
 * of month boundaries would either be pruned away or drift with today's date.
 */
import { describe, it, expect } from 'vitest';
import { windowCutoff } from '../src/lib/execution-log';

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const iso = (secs: number) => new Date(secs * 1000).toISOString();

describe('monthly window is the calendar month, not a rolling 30 days', () => {
  it('anchors to the 1st at 00:00 UTC, one hour into a new month', () => {
    // A rolling 30-day window here would still be counting most of March.
    const cutoff = windowCutoff('monthly', at('2026-04-01T01:00:00Z'));
    expect(iso(cutoff)).toBe('2026-04-01T00:00:00.000Z');
  });

  it('anchors to the 1st even at the very end of a 31-day month', () => {
    const cutoff = windowCutoff('monthly', at('2026-01-31T23:59:59Z'));
    expect(iso(cutoff)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('resets across a short month — February', () => {
    const cutoff = windowCutoff('monthly', at('2026-03-01T00:00:01Z'));
    expect(iso(cutoff)).toBe('2026-03-01T00:00:00.000Z');
  });

  it('handles the year boundary', () => {
    const cutoff = windowCutoff('monthly', at('2027-01-01T12:00:00Z'));
    expect(iso(cutoff)).toBe('2027-01-01T00:00:00.000Z');
  });

  it('is idempotent exactly on the boundary', () => {
    const boundary = at('2026-09-01T00:00:00Z');
    expect(windowCutoff('monthly', boundary)).toBe(boundary);
  });

  it('never exceeds the 31-day retention the log prunes at', () => {
    // If the window could start earlier than retention, the figure shown would
    // silently under-count on the last days of a long month.
    const MAX_AGE = 31 * 24 * 60 * 60;
    for (const when of ['2026-01-31T23:59:59Z', '2026-03-31T23:59:59Z', '2026-12-31T23:59:59Z']) {
      const now = at(when);
      expect(now - windowCutoff('monthly', now)).toBeLessThanOrEqual(MAX_AGE);
    }
  });
});

describe('daily and weekly stay rolling — they already matched the AS', () => {
  it('daily is a trailing 24 hours, not a calendar day', () => {
    const now = at('2026-06-10T10:00:00Z');
    expect(iso(windowCutoff('daily', now))).toBe('2026-06-09T10:00:00.000Z');
  });

  it('weekly is a trailing 7 days', () => {
    const now = at('2026-06-10T10:00:00Z');
    expect(iso(windowCutoff('weekly', now))).toBe('2026-06-03T10:00:00.000Z');
  });
});
