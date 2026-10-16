import { describe, it, expect } from 'vitest';
import { isNewReport, reportTitle, reportCheckCounts } from './report-news';

describe('report news', () => {
  it('new = saved after the last visit (savedAt is seconds, the cutoff ms)', () => {
    expect(isNewReport({ savedAt: 2000 }, 1_999_000)).toBe(true);
    expect(isNewReport({ savedAt: 2000 }, 2_000_000)).toBe(false);
    expect(isNewReport(null, 0)).toBe(false);
  });
  it('title = first heading, plain text, else "Report"', () => {
    expect(reportTitle('<div><h1>Wochen<b>bericht</b> KW 42</h1><p>x</p></div>')).toBe('Wochenbericht KW 42');
    expect(reportTitle('<p>no heading</p>')).toBe('Report');
  });
  it('counts verified values and elements that could not be checked', () => {
    expect(reportCheckCounts({
      proof: { verifiedValues: [{ elementId: 'a', kind: 'x', summary: '' }, { elementId: 'b', kind: 'x', summary: '' }] } as never,
      elements: [{ status: 'verified' }, { status: 'unverifiable' }] as never,
    })).toEqual({ verified: 2, unchecked: 1 });
  });
});

import { reportPeriod, writtenLabel } from './report-news';
describe('report period and age', () => {
  const start = Math.floor(new Date(2026, 9, 9, 9, 12, 5).getTime() / 1000);
  const end = Math.floor(new Date(2026, 9, 16, 9, 12, 40).getTime() / 1000);
  it('date-time to date-time, days, exact seconds and the tolerance in the title', () => {
    const p = reportPeriod({ window: { start, end, days: 7 } }, 'en-GB');
    expect(p.text).toMatch(/^Covers 9 Oct 2026, 09:12 → 16 Oct 2026, 09:12 \(7 days\)$/);
    expect(p.title).toMatch(/09:12:05/);
    expect(p.title).toMatch(/09:12:40/);
    expect(p.title).toMatch(/2 minutes/);
  });
  it('never invents a period', () => {
    expect(reportPeriod({}).text).toBe('Period not recorded');
  });
  it('the age shows once a report is old', () => {
    const now = new Date(2026, 9, 25, 10, 0).getTime();
    expect(writtenLabel(end, now, 'en-GB')).toMatch(/\(9 days ago\)$/);
    expect(writtenLabel(Math.floor(now / 1000) - 60, now, 'en-GB')).toMatch(/^today /);
  });
});
