import { describe, it, expect } from 'vitest';
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
} from './ReportsPage';
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
  it('REFUSAL: an unreadable email export is a tagged error, not a bare "0 of 0"', () => {
    const line = coverageCasesLine(coverage({ emailExportError: 'email-mcp export failed: ENOENT', loadedCases: [], coveredCases: [] }));
    expect(line.kind).toBe('error');
    expect(line.text).toContain('ENOENT');
    expect(line.text).not.toMatch(/^0 of 0$/);
  });

  it('genuinely zero loaded cases (no export error) is a normal "0 of 0"', () => {
    const line = coverageCasesLine(coverage({ loadedCases: [], coveredCases: [] }));
    expect(line.kind).toBe('ok');
    expect(line.text).toBe('0 of 0');
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
    expect(note).toMatch(/period start unknown/i);
    expect(note).toMatch(/all archived tickets counted/i);
  });

  it('folds in the email export error as the reason, when there is one', () => {
    const note = periodStartNote(coverage({ periodStart: null, emailExportError: 'ENOENT' }));
    expect(note).toContain('ENOENT');
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
