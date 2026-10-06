import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { spClient, type ReportModel, type ReportElement, type ReportProof, type ReportCoverage, type TicketDetail } from '../lib/sp-client';
import { EmptyState } from '../components/EmptyState';

// ─── Pure helpers (exported for unit tests — see ReportsPage.test.ts) ──────

/** The report's title: the first <h1> the AI wrote, else "Report" (plan: R5 UI). */
export function extractReportTitle(html: string): string {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (!m) return 'Report';
  const text = m[1].replace(/<[^>]+>/g, '').trim();
  return text || 'Report';
}

/**
 * "written by the AI under mandate X" — only when an sv-mandate element in
 * the report actually verified, so the subtitle never asserts a mandate the
 * report did not prove. Returns null (caller omits the phrase) otherwise.
 *
 * Prefers the server's own `profileLabel` (already the short, capitalized
 * name resolved from the profile registry) — the full profile id this used
 * to split by hand reads as a raw technical value once a real mandate's id
 * is the full qualified form (polish 2026-10-05, caught in the first real
 * screenshot: "written by the AI under mandate
 * Github.com/humanagencyprotocol/hap-profiles/sales").
 */
export function findMandateLabel(elements: ReportElement[]): string | null {
  const found = elements.find(
    e => e.kind === 'sv-mandate' && e.status !== 'unverifiable' && typeof e.data?.profile === 'string',
  );
  if (!found) return null;
  const data = found.data as { profile: string; profileLabel?: unknown };
  if (typeof data.profileLabel === 'string' && data.profileLabel) return data.profileLabel;
  const name = data.profile.split('@')[0].split('/').pop();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : null;
}

export function formatCheckedTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The narrow-layout one-line summary (plan: "proof and coverage collapse into one line"). */
export function narrowSummaryLine(proof: ReportProof, coverage: ReportCoverage): string {
  const casesPart = coverage.emailExportError ? 'cases unknown' : `${coverage.coveredCases.length}/${coverage.loadedCases.length} cases`;
  // Zero must not look like success here either — no checkmark on "0 tickets".
  const ticketsPart = proof.signaturesValid > 0 ? `${proof.signaturesValid} ✓ tickets` : `${proof.signaturesValid} tickets`;
  return `${ticketsPart} · ${casesPart} · ${coverage.ticketsReferenced.length}/${coverage.ticketsInPeriod.length} tickets covered`;
}

/**
 * The Coverage panel's "Cases" line — a tagged result, never a bare number,
 * so a caller cannot accidentally render "0 of 0" for "we don't know"
 * (review 2026-10-05: that read as "fully covered", the opposite of true).
 */
export function coverageCasesLine(coverage: ReportCoverage): { kind: 'ok' | 'error'; text: string } {
  if (coverage.emailExportError) {
    return { kind: 'error', text: `Cases: unknown — email simulator not readable: ${coverage.emailExportError}` };
  }
  return { kind: 'ok', text: `${coverage.coveredCases.length} of ${coverage.loadedCases.length}` };
}

/** Explains an unknown test-period start rather than silently falling back —
 *  "all archived tickets counted" is a deliberate, inclusive fallback (never
 *  excludes a ticket it isn't sure about), not a bug, but it must be stated. */
export function periodStartNote(coverage: ReportCoverage): string | null {
  if (coverage.periodStart !== null) return null;
  return coverage.emailExportError
    ? `Period start unknown (${coverage.emailExportError}) — all archived tickets counted.`
    : 'Period start unknown — all archived tickets counted.';
}

/**
 * A proof/coverage COUNT must never look like success just because it is
 * zero (polish 2026-10-05: "Records checked 0 ✓" reads as a good result when
 * it is really "there was nothing to check"). Used for "Signatures valid" and
 * "Records checked" — any zero gets neutral styling and no checkmark.
 */
export function proofCountLine(count: number, noneText = 'none in this report'): { kind: 'ok' | 'neutral'; text: string } {
  if (count > 0) return { kind: 'ok', text: `${count} ✓` };
  return { kind: 'neutral', text: noneText };
}

// ─── Client-side display formatting (mirrors apps/mcp-server/src/lib/report/
// format.ts's pure, profile-independent helpers — NOT cross-imported, same
// convention as the ReportElement/ReportProof types above: this file never
// imports server code directly. Only the bits that need no profile registry
// (time/currency) are duplicated; bound-label formatting stays server-side,
// already baked into `data` by the time it reaches here). ──────────────────

const MONTHS_CLIENT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Unix seconds -> "5 Oct, 14:26", in the browser's own local time zone. */
export function formatDateTimeClient(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 'unknown time';
  const d = new Date(n * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS_CLIENT[d.getMonth()]}, ${hh}:${mm}`;
}

/** Parses a connector export's date string (SQLite `datetime('now')` or ISO
 *  8601) to unix seconds — same two shapes apps/mcp-server/src/lib/report/
 *  time.ts handles server-side. Returns undefined, never NaN, on anything else. */
function parseTimestampSecondsClient(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(value) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function groupThousandsClient(n: number): string {
  const sign = n < 0 ? '-' : '';
  const [intPart, frac] = Math.abs(n).toString().split('.');
  return sign + intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (frac ? `.${frac}` : '');
}

const CURRENCY_SYMBOLS_CLIENT: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };

export function formatCurrencyClient(amount: unknown, currencyCode: string | undefined): string {
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) return String(amount ?? '');
  if (!currencyCode) return groupThousandsClient(n);
  const code = currencyCode.toUpperCase();
  const symbol = CURRENCY_SYMBOLS_CLIENT[code];
  return symbol ? `${symbol} ${groupThousandsClient(n)}` : `${code} ${groupThousandsClient(n)}`;
}

const RECORD_TIME_KEYS = new Set(['received_at', 'created_at', 'sent_at']);

/**
 * A raw fact's value for the GENERIC detail dump (sv-record / sv-metric —
 * kinds with no per-field formatting of their own from the server). Returns
 * null for a field that should not render at all (the `currency` field,
 * folded into `net_total`'s own display). Never returns a bare unix second
 * count or an un-symboled amount for a field this function recognizes.
 */
export function formatDetailValue(key: string, data: Record<string, unknown>): string | null {
  const value = data[key];
  if (value === undefined || value === null || value === '') return null;
  if (key === 'currency') return null;
  if (key === 'net_total') return formatCurrencyClient(value, typeof data.currency === 'string' ? data.currency : undefined);
  if (RECORD_TIME_KEYS.has(key)) {
    const t = parseTimestampSecondsClient(value);
    return t !== undefined ? formatDateTimeClient(t) : String(value);
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** "Not in the report: cases C4, C9 · 3 tickets" — null when the report is complete. */
export function missingSummary(coverage: ReportCoverage): string | null {
  const parts: string[] = [];
  if (coverage.missingCases.length > 0) parts.push(`cases ${coverage.missingCases.join(', ')}`);
  if (coverage.ticketsNotReferenced.length > 0) {
    parts.push(`${coverage.ticketsNotReferenced.length} ticket${coverage.ticketsNotReferenced.length === 1 ? '' : 's'}`);
  }
  return parts.length > 0 ? `Not in the report: ${parts.join(' · ')}` : null;
}

/**
 * Which ticket id the detail panel should resolve, given the clicked
 * element and an explicit `?ticket=` query param (set by an sv-case step —
 * see render-report.ts). Falls back to the element's own identifying ticket
 * attribute, and for sv-case with no explicit step, its goal ticket.
 */
export function resolveDetailTicketId(element: ReportElement | undefined, ticketParam: string | null): string | null {
  if (ticketParam) return ticketParam;
  if (!element) return null;
  if (element.kind === 'sv-ticket') return element.attrs.ref || null;
  if (element.kind === 'sv-approval' || element.kind === 'sv-mandate') return element.attrs.ticket || null;
  if (element.kind === 'sv-case') {
    const goal = element.data?.goal as { ticketId?: string } | undefined;
    return goal?.ticketId ?? null;
  }
  return null;
}

/** Wraps the gateway-rendered HTML with the CSP meta tag the iframe srcdoc
 *  needs (plan: "no JavaScript ... CSP meta in the srcdoc"). No script tag
 *  can run even without this (the sandbox omits allow-scripts) — the CSP is
 *  defense in depth against inline event handlers sanitize-html missed. */
export function buildSrcDoc(renderedHtml: string): string {
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:;">';
  if (/<head[^>]*>/i.test(renderedHtml)) {
    return renderedHtml.replace(/<head([^>]*)>/i, m => `${m}${csp}`);
  }
  if (/<html[^>]*>/i.test(renderedHtml)) {
    return renderedHtml.replace(/<html([^>]*)>/i, m => `${m}<head>${csp}</head>`);
  }
  return `<!doctype html><html><head>${csp}</head><body>${renderedHtml}</body></html>`;
}

// ─── Detail panel ───────────────────────────────────────────────────────────

const DL_STYLE = { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 1rem', margin: 0, fontSize: '0.85rem' } as const;

/** Raw fields kept out of the human summary, shown only under "Technical
 *  details" (polish 2026-10-05: "Keep all raw values available ... under a
 *  collapsed section — the trusted proof must stay complete"). */
const TECHNICAL_FIELDS: Record<'Ticket' | 'Mandate' | 'Approval', string[]> = {
  Ticket: ['ticketId', 'action', 'time', 'authorizationId', 'limitsUsed'],
  Mandate: ['authorizationId', 'profile', 'rawLimits', 'ownersRaw'],
  Approval: ['ticketId', 'who', 'createdAt', 'decidedAt', 'waitSeconds', 'status'],
};

/** The human-readable summary lines for one resolved fact — already-formatted
 *  values from the server (actionLabel/timeLabel/profileLabel/limits/owners/
 *  who*Label), falling back to a client-side format only where the server
 *  field is missing (older stored report). */
export function factSummaryLines(title: 'Ticket' | 'Mandate' | 'Approval', data: Record<string, unknown>): Array<{ label: string; value: string }> {
  if (title === 'Ticket') {
    return [
      { label: 'Action', value: String(data.actionLabel ?? data.action ?? 'unknown') },
      { label: 'When', value: String(data.timeLabel ?? formatDateTimeClient(data.time)) },
      { label: 'Mandate', value: String(data.profileLabel ?? data.profile ?? 'unknown') },
    ];
  }
  if (title === 'Mandate') {
    const lines = [
      { label: 'Mandate', value: String(data.profileLabel ?? data.profile ?? 'unknown') },
      { label: 'Owners', value: Array.isArray(data.owners) && (data.owners as string[]).length > 0 ? (data.owners as string[]).join(', ') : 'unknown owner' },
    ];
    if (Array.isArray(data.limits) && (data.limits as string[]).length > 0) {
      lines.push({ label: 'Limits', value: (data.limits as string[]).join(' · ') });
    }
    if (data.mode) lines.push({ label: 'Commitment mode', value: String(data.mode) });
    if (data.intent) lines.push({ label: 'Intent', value: String(data.intent) });
    return lines;
  }
  // Approval
  return [
    { label: 'Approved by', value: String(data.whoLabel ?? 'unknown') },
    { label: 'Asked', value: String(data.createdAtLabel ?? 'unknown') },
    { label: 'Approved', value: String(data.decidedAtLabel ?? 'unknown') },
    { label: 'Waited', value: String(data.waitLabel ?? 'unknown') },
  ];
}

function technicalDetails(title: 'Ticket' | 'Mandate' | 'Approval', data: Record<string, unknown>) {
  const keys = TECHNICAL_FIELDS[title].filter(k => data[k] !== undefined);
  if (keys.length === 0) return null;
  return (
    <details style={{ marginTop: '0.5rem' }}>
      <summary style={{ cursor: 'pointer', fontSize: '0.8rem', color: 'var(--text-muted)' }}>Technical details</summary>
      <dl style={{ ...DL_STYLE, marginTop: '0.5rem' }}>
        {keys.map(k => (
          <div key={k} style={{ display: 'contents' }}>
            <dt style={{ color: 'var(--text-muted)' }}>{k}</dt>
            <dd style={{ margin: 0, wordBreak: 'break-word' }}>{typeof data[k] === 'object' ? JSON.stringify(data[k]) : String(data[k])}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function factSection(title: 'Ticket' | 'Mandate' | 'Approval', fact: TicketDetail[keyof TicketDetail] | undefined) {
  if (!fact) return null;
  return (
    <div className="card" style={{ marginTop: '0.75rem' }}>
      <div className="card-title">{title}</div>
      {fact.status === 'unverifiable' ? (
        <p className="page-subtitle">✗ not verifiable — {fact.reason ?? 'no further detail.'}</p>
      ) : (
        <>
          <dl style={DL_STYLE}>
            {factSummaryLines(title, fact.data ?? {}).map(({ label, value }) => (
              <div key={label} style={{ display: 'contents' }}>
                <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
                <dd style={{ margin: 0, wordBreak: 'break-word' }}>{value}</dd>
              </div>
            ))}
          </dl>
          {technicalDetails(title, fact.data ?? {})}
        </>
      )}
    </div>
  );
}

function DetailPanel({ report, elementId, ticketParam, onClose }: {
  report: ReportModel;
  elementId: string;
  ticketParam: string | null;
  onClose: () => void;
}) {
  const element = report.elements.find(e => e.id === elementId);
  const ticketId = resolveDetailTicketId(element, ticketParam);
  const detail = ticketId ? report.ticketDetails[ticketId] : undefined;

  return (
    <div className="card" style={{ marginTop: '1rem' }}>
      <div className="card-header">
        <div className="card-title">Details</div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
      </div>
      {!element && <p className="page-subtitle">This element is no longer in the report.</p>}
      {element && !ticketId && (
        element.status === 'unverifiable'
          ? <p className="page-subtitle">✗ not verifiable — {element.reason ?? 'no further detail.'}</p>
          : (
            <dl style={DL_STYLE}>
              {Object.keys(element.data ?? {}).map(k => {
                const display = formatDetailValue(k, element.data ?? {});
                if (display === null) return null;
                return (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt style={{ color: 'var(--text-muted)' }}>{k}</dt>
                    <dd style={{ margin: 0, wordBreak: 'break-word' }}>{display}</dd>
                  </div>
                );
              })}
            </dl>
          )
      )}
      {detail && (
        <>
          {factSection('Ticket', detail.ticket)}
          {factSection('Mandate', detail.mandate)}
          {factSection('Approval', detail.approval)}
        </>
      )}
      {ticketId && !detail && <p className="page-subtitle">No local detail for ticket {ticketId}.</p>}
    </div>
  );
}

// ─── Side panel (Proof / Coverage / Checked values) ────────────────────────

function SidePanel({ report, open }: { report: ReportModel; open?: boolean }) {
  const { proof, coverage } = report;
  const missing = missingSummary(coverage);
  const casesLine = coverageCasesLine(coverage);
  const periodNote = periodStartNote(coverage);
  const signaturesLine = proofCountLine(proof.signaturesValid);
  const recordsLine = proofCountLine(proof.recordsChecked);
  return (
    <div className={`reports-side${open ? ' reports-side-open' : ''}`}>
      <div className="card">
        <div className="card-title">Proof</div>
        <div className="reports-row"><span>Tickets referenced</span><b>{proof.ticketsReferenced.length}</b></div>
        <div className="reports-row">
          <span>Signatures valid</span>
          <b style={signaturesLine.kind === 'ok' ? { color: 'var(--success)' } : undefined}>{signaturesLine.text}</b>
        </div>
        <div className="reports-row">
          <span>Records checked</span>
          <b style={recordsLine.kind === 'ok' ? { color: 'var(--success)' } : undefined}>{recordsLine.text}</b>
        </div>
        <div className="reports-row"><span>Not verifiable</span><b>{proof.unverifiableCount}</b></div>
      </div>
      <div className="card" style={{ marginTop: '0.75rem' }}>
        <div className="card-title">Coverage</div>
        {casesLine.kind === 'error' ? (
          <p className="reports-error" role="alert">{casesLine.text}</p>
        ) : (
          <div className="reports-row"><span>Cases</span><b>{casesLine.text}</b></div>
        )}
        <div className="reports-row"><span>Tickets in test period</span><b>{coverage.ticketsReferenced.length} of {coverage.ticketsInPeriod.length}</b></div>
        {periodNote && <p className="reports-note">{periodNote}</p>}
        {missing && <p className="reports-missing">{missing}</p>}
      </div>
      {proof.verifiedValues.length > 0 && (
        <div className="card reports-checked-values" style={{ marginTop: '0.75rem' }}>
          <div className="card-title">Checked values</div>
          {proof.verifiedValues.map(v => (
            <div className="reports-row" key={v.elementId}><span>{v.summary}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function ReportsPage() {
  const [report, setReport] = useState<ReportModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [narrowDetailsOpen, setNarrowDetailsOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    spClient.getReport()
      .then(({ report }) => setReport(report))
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRecheck = useCallback(() => {
    setRechecking(true);
    spClient.recheckReport()
      .then(({ report }) => setReport(report))
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setRechecking(false));
  }, []);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    try {
      const { html, filename } = await spClient.exportReportWithProof();
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }, []);

  const elementId = searchParams.get('element');
  const ticketParam = searchParams.get('ticket');

  const closeDetail = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('element');
    next.delete('ticket');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  if (loading) {
    return (
      <div className="page-inner">
        <div className="page-header"><h1 className="page-title">Reports</h1></div>
        <p className="page-subtitle">Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-inner">
        <div className="page-header"><h1 className="page-title">Reports</h1></div>
        <EmptyState icon="⚠" title="Report unavailable" text={error} />
      </div>
    );
  }

  if (!report) {
    return (
      <div className="page-inner">
        <div className="page-header"><h1 className="page-title">Reports</h1></div>
        <EmptyState
          icon="▢"
          title="No report yet"
          text="No report yet — the AI writes it with the Reporting mandate."
        />
      </div>
    );
  }

  const title = extractReportTitle(report.renderedHtml);
  const mandateLabel = findMandateLabel(report.elements);

  return (
    <div className="page-inner reports-page">
      <div className="reports-layout">
        <div className="reports-bar">
          <div>
            <h1 className="page-title">{title}</h1>
            <p className="page-subtitle">
              {mandateLabel ? `written by the AI under mandate ${mandateLabel} · ` : ''}
              checked {formatCheckedTime(report.checkedAt)}
            </p>
          </div>
          <div className="reports-bar-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={handleRecheck} disabled={rechecking}>
              {rechecking ? 'Checking…' : 'Check again'}
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={handleExport} disabled={exporting}>
              {exporting ? 'Exporting…' : 'Export with proof'}
            </button>
          </div>
        </div>
        {exportError && (
          <p className="reports-error" role="alert" style={{ margin: '0.5rem 0 0 0' }}>
            Export failed: {exportError}
          </p>
        )}

        <div className="reports-summary-chip">
          <span>{narrowSummaryLine(report.proof, report.coverage)}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNarrowDetailsOpen(o => !o)}>
            {narrowDetailsOpen ? 'hide' : 'details'}
          </button>
        </div>

        <div className="reports-grid">
          <div>
            <p className="form-hint" style={{ marginBottom: '0.5rem' }}>
              Written by the AI, rendered without scripts or network access. Scroll inside the report — the gateway does not auto-resize the frame.
            </p>
            {/* No allow-scripts, no allow-same-origin: the AI's HTML cannot run
                code or reach the gateway's origin. Only top-level navigation
                (the sv-* detail links) is permitted, and only on a real click. */}
            <iframe
              title="Report"
              sandbox="allow-top-navigation-by-user-activation"
              srcDoc={buildSrcDoc(report.renderedHtml)}
              className="reports-iframe"
            />
            {elementId && (
              <DetailPanel report={report} elementId={elementId} ticketParam={ticketParam} onClose={closeDetail} />
            )}
          </div>
          <SidePanel report={report} open={narrowDetailsOpen} />
        </div>
      </div>
    </div>
  );
}
