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
