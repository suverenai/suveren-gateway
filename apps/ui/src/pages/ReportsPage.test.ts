import { describe, it, expect, vi } from 'vitest';
import {
  extractReportTitle,
  findMandateLabel,
  formatCheckedTime,
  narrowSummaryLine,
  coverageCasesLine,
  periodStartNote,
  missingSummary,
  resolveDetailTicketId,
  buildSrcDoc,
  proofCountLine,
  formatDateTimeClient,
  formatCurrencyClient,
  formatDetailValue,
  factSummaryLines,
  runExportAndRefresh,
  REPORT_IFRAME_SANDBOX,
  AI_ANALYSIS_LABEL_CLIENT,
  detailSearchParams,
  unverifiableRows,
  caseDetailSteps,
} from './ReportsPage';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReportElement, ReportProof, ReportCoverage } from '../lib/sp-client';

// Pure logic only — this file has no DOM test runner (see other *.test.ts in
// this directory); the JSX is presentation, these are the decisions that are
// easy to get silently wrong: what title shows, what counts as "known"
// mandate, what the narrow summary says, which ticket a click resolves to.

describe('extractReportTitle', () => {
  it('uses the AI\'s first <h1>', () => {
    expect(extractReportTitle('<h1>Three-week test</h1><p>x</p>')).toBe('Three-week test');
  });

  it('strips nested markup from the heading', () => {
    expect(extractReportTitle('<h1>Case <b>C7</b> summary</h1>')).toBe('Case C7 summary');
  });

  it('falls back to "Report" when there is no <h1>', () => {
    expect(extractReportTitle('<p>no heading here</p>')).toBe('Report');
  });

  it('falls back to "Report" for a blank/empty <h1>', () => {
    expect(extractReportTitle('<h1>   </h1>')).toBe('Report');
  });
});

function ticketEl(overrides: Partial<ReportElement> = {}): ReportElement {
  return { id: 'sv-ticket-0', kind: 'sv-ticket', attrs: { ref: 't1' }, status: 'verified', ...overrides };
}

describe('findMandateLabel — "written by the AI under mandate X" only when known', () => {
  it('prefers the server\'s own profileLabel', () => {
    const elements: ReportElement[] = [
      { id: 'sv-mandate-0', kind: 'sv-mandate', attrs: { ticket: 't1' }, status: 'verified', data: { profile: 'github.com/humanagencyprotocol/hap-profiles/sales@0.3', profileLabel: 'Sales' } },
    ];
    expect(findMandateLabel(elements)).toBe('Sales');
  });

  it('falls back to deriving a name from the raw profile id when no profileLabel is present', () => {
    const elements: ReportElement[] = [
      { id: 'sv-mandate-0', kind: 'sv-mandate', attrs: { ticket: 't1' }, status: 'verified', data: { profile: 'reporting@0.1' } },
    ];
    expect(findMandateLabel(elements)).toBe('Reporting');
  });

  it('REFUSAL: a full qualified profile id with no profileLabel never leaks the whole path as the mandate name', () => {
    const elements: ReportElement[] = [
      { id: 'sv-mandate-0', kind: 'sv-mandate', attrs: { ticket: 't1' }, status: 'verified', data: { profile: 'github.com/humanagencyprotocol/hap-profiles/sales@0.3' } },
    ];
    expect(findMandateLabel(elements)).toBe('Sales');
  });

  it('returns null (omit the phrase) when no sv-mandate element is present', () => {
    expect(findMandateLabel([ticketEl()])).toBeNull();
  });

  it('REFUSAL: an UNVERIFIABLE sv-mandate must not be reported as "known"', () => {
    const elements: ReportElement[] = [
      { id: 'sv-mandate-0', kind: 'sv-mandate', attrs: { ticket: 't1' }, status: 'unverifiable', reason: 'no archived mandate' },
    ];
    expect(findMandateLabel(elements)).toBeNull();
  });
});

describe('formatCheckedTime', () => {
  it('renders an HH:MM time', () => {
    const out = formatCheckedTime(1_700_000_000);
    expect(out).toMatch(/^\d{1,2}:\d{2}\s?(AM|PM)?$/i);
  });
});

function coverage(overrides: Partial<ReportCoverage> = {}): ReportCoverage {
  return {
    loadedCases: ['C1', 'C2'],
    coveredCases: ['C1'],
    missingCases: ['C2'],
    periodStart: null,
    ticketsInPeriod: ['t1', 't2'],
    ticketsReferenced: ['t1'],
    ticketsNotReferenced: ['t2'],
    ...overrides,
  };
}

function proof(overrides: Partial<ReportProof> = {}): ReportProof {
  return {
    ticketsReferenced: ['t1'],
    signaturesValid: 1,
    recordsChecked: 0,
    unverifiableCount: 0,
    verifiedValues: [],
    ...overrides,
  };
}

describe('narrowSummaryLine', () => {
  it('summarizes tickets/cases/coverage in one line', () => {
    const line = narrowSummaryLine(proof({ signaturesValid: 14 }), coverage({ coveredCases: ['C1'], loadedCases: ['C1', 'C2'], ticketsReferenced: ['t1'], ticketsInPeriod: ['t1', 't2'] }));
    expect(line).toContain('14');
    expect(line).toContain('1/2');
  });

  it('REFUSAL: says "cases unknown" rather than "0/0" when the email export failed', () => {
    const line = narrowSummaryLine(proof(), coverage({ emailExportError: 'ENOENT', loadedCases: [], coveredCases: [] }));
    expect(line).toContain('cases unknown');
    expect(line).not.toMatch(/0\/0 cases/);
  });
});

describe('coverageCasesLine — "0 of 0" must never stand in for "unknown"', () => {
  it('REFUSAL: an unreadable email export is a tagged error, not a bare "0 of 0" — and never shows the raw connector error inline', () => {
    const line = coverageCasesLine(coverage({ emailExportError: 'email-mcp export failed: ENOENT', loadedCases: [], coveredCases: [] }));
    expect(line.kind).toBe('error');
    expect(line.text).not.toContain('ENOENT');
    expect(line.text).not.toMatch(/spawn|ENOENT|export failed/i);
    expect(line.text).not.toMatch(/^0 of 0$/);
    // The raw reason still travels, just not in the sentence a manager reads.
    expect(line.detail).toBe('email-mcp export failed: ENOENT');
  });

  it('genuinely zero loaded cases (no export error) is a normal "0 of 0" with no technical detail', () => {
    const line = coverageCasesLine(coverage({ loadedCases: [], coveredCases: [] }));
    expect(line.kind).toBe('ok');
    expect(line.text).toBe('0 of 0');
    expect(line.detail).toBeUndefined();
  });

  it('a readable export with partial coverage reports the real counts', () => {
    const line = coverageCasesLine(coverage({ loadedCases: ['C1', 'C2'], coveredCases: ['C1'] }));
    expect(line.kind).toBe('ok');
    expect(line.text).toBe('1 of 2');
  });
});

describe('periodStartNote', () => {
  it('is null when the period start is known', () => {
    expect(periodStartNote(coverage({ periodStart: 1_700_000_000 }))).toBeNull();
  });

  it('explains the inclusive fallback when the period start is unknown', () => {
    const note = periodStartNote(coverage({ periodStart: null }));
    expect(note?.text).toMatch(/test period start unknown/i);
    expect(note?.text).toMatch(/all saved tickets were counted/i);
    expect(note?.detail).toBeUndefined();
  });

  it('REFUSAL: never shows the raw connector error inline — it travels in `detail` only', () => {
    const note = periodStartNote(coverage({ periodStart: null, emailExportError: 'email-mcp export failed: ENOENT' }));
    expect(note?.text).not.toContain('ENOENT');
    expect(note?.text).not.toMatch(/spawn|ENOENT|export failed/i);
    expect(note?.text).toMatch(/email simulator could not be read/i);
    expect(note?.detail).toBe('email-mcp export failed: ENOENT');
  });
});

/**
 * 2026-10-06 regression report: a real click-through screenshot
 * (temp/report-export-click.png) showed the LIVE page's Coverage panel
 * reading "Cases 0 of 0" next to a grey "Test period start unknown" note,
 * while the file that same click had just exported correctly read "Cases:
 * unknown — the email simulator could not be read." Two hypotheses were
 * named: (a) `coverageCasesLine`'s refactor broke the live page, or (b) the
 * live page simply never received a payload WITH `emailExportError` — it was
 * still showing whatever `GET /api/report` returned at page-LOAD time, from
 * BEFORE the export's own fresh recheck ran.
 *
 * This block pins down (b): given the EXACT payload shape the live page was
 * actually holding at that moment — `coverage.emailExportError` undefined,
 * because the on-screen check predated the export's recheck — "0 of 0" is
 * the CORRECT rendering (no bug in `coverageCasesLine` itself: given a
 * payload that DOES carry `emailExportError`, the suite above already proves
 * it is tagged 'error', never "0 of 0"). The real defect was that nothing
 * re-fetched `/api/report` after a successful export, so the page kept
 * showing that now-superseded payload — fixed by `runExportAndRefresh`
 * (below), not by this function.
 */
describe('REGRESSION PIN (2026-10-06): "Cases 0 of 0" next to a just-exported "unknown" — confirmed root cause', () => {
  it('is NOT a coverageCasesLine bug: a payload that already carries emailExportError is never "0 of 0"', () => {
    const line = coverageCasesLine(coverage({ emailExportError: 'email-mcp export failed: spawn email-mcp ENOENT', loadedCases: [], coveredCases: [] }));
    expect(line.kind).toBe('error');
    expect(line.text).not.toMatch(/^0 of 0$/);
  });

  it('IS a stale-payload bug: a payload from BEFORE the connector failure genuinely has no error, and "0 of 0" is the honest answer for THAT payload', () => {
    // This is exactly the shape GET /api/report returned at page-load time in
    // the regression: loadedCases/coveredCases empty, but no emailExportError
    // — because the stored check predated the export route's own recheck.
    const stalePayload = coverage({ emailExportError: undefined, loadedCases: [], coveredCases: [] });
    const line = coverageCasesLine(stalePayload);
    expect(line.kind).toBe('ok');
    expect(line.text).toBe('0 of 0'); // correct for THIS payload — the bug was never refreshing to the NEXT one
  });
});

describe('runExportAndRefresh — the export-then-refresh sequence (fixes the regression above)', () => {
  it('REFUSAL (this is the actual 2026-10-06 bug, reproduced): skipping the refresh step leaves the page on stale data — asserts the real fix calls it', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const download = vi.fn();
    await runExportAndRefresh({
      exportReport: async () => ({ html: '<html></html>', filename: 'x.html' }),
      download,
      refresh,
    });
    // Before the fix, `handleExport` never called anything like `refresh` —
    // the live page's `report` state was never updated after a successful
    // export. This assertion is exactly what would have failed on the
    // pre-fix code (refresh was not part of the export flow at all).
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith('<html></html>', 'x.html');
  });

  it('downloads BEFORE refreshing (the file itself must never wait on the refresh)', async () => {
    const order: string[] = [];
    await runExportAndRefresh({
      exportReport: async () => ({ html: '<html></html>', filename: 'x.html' }),
      download: () => { order.push('download'); },
      refresh: async () => { order.push('refresh'); },
    });
    expect(order).toEqual(['download', 'refresh']);
  });

  it('REFUSAL: an export failure never calls refresh or download', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const download = vi.fn();
    await expect(runExportAndRefresh({
      exportReport: async () => { throw new Error('No Authority Server key available'); },
      download,
      refresh,
    })).rejects.toThrow('No Authority Server key available');
    expect(download).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('propagates a refresh failure too (the caller still learns something went wrong)', async () => {
    await expect(runExportAndRefresh({
      exportReport: async () => ({ html: '<html></html>', filename: 'x.html' }),
      download: () => {},
      refresh: async () => { throw new Error('report unavailable'); },
    })).rejects.toThrow('report unavailable');
  });
});

describe('missingSummary — "not in the report"', () => {
  it('names missing cases and counts unreferenced tickets', () => {
    const summary = missingSummary(coverage({ missingCases: ['C4', 'C9'], ticketsNotReferenced: ['a', 'b', 'c'] }));
    expect(summary).toContain('C4, C9');
    expect(summary).toContain('3 tickets');
  });

  it('is null when the report covers everything — no false "missing" claim', () => {
    expect(missingSummary(coverage({ missingCases: [], ticketsNotReferenced: [] }))).toBeNull();
  });

  it('uses singular "ticket" for exactly one', () => {
    const summary = missingSummary(coverage({ missingCases: [], ticketsNotReferenced: ['a'] }));
    expect(summary).toContain('1 ticket');
    expect(summary).not.toContain('1 tickets');
  });
});

describe('resolveDetailTicketId', () => {
  it('prefers an explicit ?ticket= query param (a case step link) over the element', () => {
    expect(resolveDetailTicketId(ticketEl({ attrs: { ref: 'other' } }), 'step-ticket')).toBe('step-ticket');
  });

  it('falls back to sv-ticket\'s own ref attribute', () => {
    expect(resolveDetailTicketId(ticketEl({ attrs: { ref: 't1' } }), null)).toBe('t1');
  });

  it('falls back to sv-approval/sv-mandate\'s ticket attribute', () => {
    expect(resolveDetailTicketId({ id: 'sv-approval-0', kind: 'sv-approval', attrs: { ticket: 't2' }, status: 'verified' }, null)).toBe('t2');
  });

  it('falls back to a case\'s own goal ticket when no step was clicked', () => {
    const el: ReportElement = {
      id: 'sv-case-0', kind: 'sv-case', attrs: {}, status: 'verified',
      data: { goal: { ticketId: 'goal1' } },
    };
    expect(resolveDetailTicketId(el, null)).toBe('goal1');
  });

  it('returns null for sv-record/sv-metric — no ticket to resolve', () => {
    expect(resolveDetailTicketId({ id: 'sv-record-0', kind: 'sv-record', attrs: {}, status: 'verified' }, null)).toBeNull();
  });

  it('returns null when neither a param nor an element is available', () => {
    expect(resolveDetailTicketId(undefined, null)).toBeNull();
  });
});

describe('proofCountLine — zero must never look like success', () => {
  it('a positive count gets the green checkmark', () => {
    expect(proofCountLine(14)).toEqual({ kind: 'ok', text: '14 ✓' });
  });

  it('REFUSAL: zero gets neutral styling and no checkmark, with a plain-language note', () => {
    const line = proofCountLine(0);
    expect(line.kind).toBe('neutral');
    expect(line.text).not.toContain('✓');
    expect(line.text).toBe('none in this report');
  });

  it('a custom "none" label is honored', () => {
    expect(proofCountLine(0, 'nothing checked')).toEqual({ kind: 'neutral', text: 'nothing checked' });
  });
});

describe('narrowSummaryLine — zero tickets must not carry a checkmark either', () => {
  it('REFUSAL: zero signatures valid renders without a tick', () => {
    const line = narrowSummaryLine(proof({ signaturesValid: 0 }), coverage());
    expect(line).toContain('0 tickets');
    expect(line).not.toMatch(/0 ✓/);
  });
});

describe('formatDateTimeClient', () => {
  it('renders a human "D Mon, HH:MM" shape, never raw unix seconds', () => {
    const out = formatDateTimeClient(1_800_000_000);
    expect(out).toMatch(/^\d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}$/);
  });

  it('REFUSAL: a non-numeric value never renders "NaN"', () => {
    expect(formatDateTimeClient('nonsense')).toBe('unknown time');
  });
});

describe('formatCurrencyClient', () => {
  it('known currencies render with a symbol and space-grouped amount', () => {
    expect(formatCurrencyClient(4380, 'EUR')).toBe('€ 4 380');
  });

  it('an unrecognized code shows the code itself', () => {
    expect(formatCurrencyClient(100, 'CHF')).toBe('CHF 100');
  });
});

describe('formatDetailValue — the generic sv-record/sv-metric detail dump', () => {
  it('formats a currency amount using the sibling currency field, dropping the bare currency row', () => {
    const data = { net_total: 4380, currency: 'EUR' };
    expect(formatDetailValue('net_total', data)).toBe('€ 4 380');
    expect(formatDetailValue('currency', data)).toBeNull();
  });

  it('formats a recognized date field as human time, never the raw ISO string', () => {
    const data = { received_at: '2027-01-15T08:10:00.000Z' };
    const out = formatDetailValue('received_at', data);
    expect(out).not.toContain('2027-01-15T08:10:00');
    expect(out).toMatch(/^\d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}$/);
  });

  it('an unrecognized field is stringified as-is', () => {
    expect(formatDetailValue('status', { status: 'sent' })).toBe('sent');
  });

  it('a missing/empty value renders as null (the caller skips the row)', () => {
    expect(formatDetailValue('subject', { subject: '' })).toBeNull();
    expect(formatDetailValue('subject', {})).toBeNull();
  });
});

describe('factSummaryLines — human-first ticket/mandate/approval detail summary', () => {
  it('Ticket: uses the server\'s own actionLabel/timeLabel/profileLabel when present', () => {
    const lines = factSummaryLines('Ticket', { actionLabel: 'Quote created', timeLabel: '5 Oct, 14:26', profileLabel: 'Sales' });
    expect(lines).toContainEqual({ label: 'Action', value: 'Quote created' });
    expect(lines).toContainEqual({ label: 'When', value: '5 Oct, 14:26' });
    expect(lines).toContainEqual({ label: 'Mandate', value: 'Sales' });
  });

  it('Mandate: owners and limits are already display-ready strings, joined for reading', () => {
    const lines = factSummaryLines('Mandate', {
      profileLabel: 'Sales', owners: ['M. Huber'], limits: ['Max value per quote: € 5 000'], mode: 'review',
    });
    expect(lines).toContainEqual({ label: 'Owners', value: 'M. Huber' });
    expect(lines).toContainEqual({ label: 'Limits', value: 'Max value per quote: € 5 000' });
    expect(lines).toContainEqual({ label: 'Commitment mode', value: 'review' });
  });

  it('Mandate: an empty owners list reads as "unknown owner", not blank', () => {
    const lines = factSummaryLines('Mandate', { profileLabel: 'Sales', owners: [] });
    expect(lines).toContainEqual({ label: 'Owners', value: 'unknown owner' });
  });

  it('Approval: "asked ... approved ... waited ..." from the server\'s own labels', () => {
    const lines = factSummaryLines('Approval', {
      whoLabel: 'M. Huber', createdAtLabel: '5 Oct, 09:20', decidedAtLabel: '5 Oct, 09:44', waitLabel: '24 min',
    });
    expect(lines).toContainEqual({ label: 'Approved by', value: 'M. Huber' });
    expect(lines).toContainEqual({ label: 'Asked', value: '5 Oct, 09:20' });
    expect(lines).toContainEqual({ label: 'Approved', value: '5 Oct, 09:44' });
    expect(lines).toContainEqual({ label: 'Waited', value: '24 min' });
  });
});

describe('buildSrcDoc — CSP meta for the sandboxed iframe', () => {
  it('injects the CSP meta into an existing <head>', () => {
    const out = buildSrcDoc('<html><head><title>x</title></head><body>hi</body></html>');
    expect(out).toMatch(/<head><meta http-equiv="Content-Security-Policy"/);
    expect(out).toContain('hi');
  });

  it('adds a <head> when only <html> exists', () => {
    const out = buildSrcDoc('<html><body>hi</body></html>');
    expect(out).toMatch(/<html><head><meta http-equiv="Content-Security-Policy"/);
  });

  it('wraps a bare fragment in a full document with the CSP meta', () => {
    const out = buildSrcDoc('<h1>Report</h1>');
    expect(out).toMatch(/^<!doctype html>/i);
    expect(out).toContain('Content-Security-Policy');
    expect(out).toContain('<h1>Report</h1>');
  });

  it('the CSP forbids everything but inline style and data: images — no script, no network', () => {
    const out = buildSrcDoc('<p>x</p>');
    expect(out).toContain("default-src 'none'");
    expect(out).toContain("style-src 'unsafe-inline'");
    expect(out).toContain('img-src data:');
  });
});

describe('REPORT_IFRAME_SANDBOX — no top navigation, popups only for the public check link (2026-10-06)', () => {
  const tokens = REPORT_IFRAME_SANDBOX.split(/\s+/);

  it('REFUSAL: grants no top-level navigation of any kind (a page load logs the user out)', () => {
    expect(REPORT_IFRAME_SANDBOX).not.toMatch(/top-navigation/);
  });

  it('allows the "Check on suveren.ai" link to open a normal new tab', () => {
    expect(tokens).toContain('allow-popups');
    expect(tokens).toContain('allow-popups-to-escape-sandbox');
  });

  it('REFUSAL: still no scripts, no same-origin, no forms', () => {
    expect(tokens).not.toContain('allow-scripts');
    expect(tokens).not.toContain('allow-same-origin');
    expect(tokens).not.toContain('allow-forms');
  });

  it('the page actually uses this constant (not a stale literal) and keeps the CSP meta', () => {
    const src = readFileSync(resolve(__dirname, 'ReportsPage.tsx'), 'utf-8');
    expect(src).toContain('sandbox={REPORT_IFRAME_SANDBOX}');
    expect(src).not.toMatch(/sandbox="/);
    expect(buildSrcDoc('<p>x</p>')).toContain("default-src 'none'");
  });

  it('the CSP does not restrict navigation, so the check link is not blocked by it', () => {
    // CSP has no navigation directive in default-src's fallback set; this pins
    // that we never add one (navigate-to / form-action would need review).
    expect(buildSrcDoc('<p>x</p>')).not.toMatch(/navigate-to|form-action/);
  });
});

describe('detailSearchParams — details open in place through the router', () => {
  it('sets element (and ticket when given), keeping other params', () => {
    const next = detailSearchParams(new URLSearchParams('foo=1&ticket=old'), 'sv-case-0', 'goal1');
    expect(next.get('element')).toBe('sv-case-0');
    expect(next.get('ticket')).toBe('goal1');
    expect(next.get('foo')).toBe('1');
  });

  it('drops a stale ticket when opening a different element', () => {
    const next = detailSearchParams(new URLSearchParams('element=sv-case-0&ticket=goal1'), 'sv-ticket-2');
    expect(next.get('element')).toBe('sv-ticket-2');
    expect(next.has('ticket')).toBe(false);
  });
});

describe('unverifiableRows — the not-verifiable proof count opens each element', () => {
  it('one plain row per unverifiable element, with its reason', () => {
    const rows = unverifiableRows([
      ticketEl(),
      { id: 'sv-metric-1', kind: 'sv-metric', attrs: {}, status: 'unverifiable', reason: 'No verified cases — no figure.' },
    ]);
    expect(rows).toEqual([{ elementId: 'sv-metric-1', text: 'Figure: No verified cases — no figure.' }]);
  });
});

describe('caseDetailSteps — the case detail\'s step buttons replace the in-frame step links', () => {
  it('lists steps then goal, in time order, with the human action label', () => {
    const el: ReportElement = {
      id: 'sv-case-0', kind: 'sv-case', attrs: {}, status: 'verified',
      data: {
        steps: [{ ticketId: 's2', time: 30, actionLabel: 'Quote sent' }, { ticketId: 's1', time: 10, actionLabel: 'Quote created' }],
        goal: { ticketId: 'g', time: 50, actionLabel: 'Reply sent' },
      },
    };
    expect(caseDetailSteps(el)).toEqual([
      { ticketId: 's1', label: 'Quote created', isGoal: false },
      { ticketId: 's2', label: 'Quote sent', isGoal: false },
      { ticketId: 'g', label: 'Reply sent', isGoal: true },
    ]);
  });

  it('is empty for anything but a resolved case', () => {
    expect(caseDetailSteps(ticketEl())).toEqual([]);
    expect(caseDetailSteps(undefined)).toEqual([]);
  });
});

describe('AI analysis legend outside the frame', () => {
  it('uses the same words the gateway draws inside the frame and the export', () => {
    expect(AI_ANALYSIS_LABEL_CLIENT).toBe('AI analysis — not verified');
    const src = readFileSync(resolve(__dirname, 'ReportsPage.tsx'), 'utf-8');
    expect(src).toMatch(/className="reports-legend"/);
  });
});
