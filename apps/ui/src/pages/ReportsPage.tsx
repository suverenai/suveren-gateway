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
 */
export function findMandateLabel(elements: ReportElement[]): string | null {
  const found = elements.find(
    e => e.kind === 'sv-mandate' && e.status !== 'unverifiable' && typeof e.data?.profile === 'string',
  );
  if (!found) return null;
  const profile = String((found.data as { profile: string }).profile);
  const name = profile.split('@')[0];
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : null;
}

export function formatCheckedTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The narrow-layout one-line summary (plan: "proof and coverage collapse into one line"). */
export function narrowSummaryLine(proof: ReportProof, coverage: ReportCoverage): string {
  return `${proof.signaturesValid} ✓ tickets · ${coverage.coveredCases.length}/${coverage.loadedCases.length} cases · ${coverage.ticketsReferenced.length}/${coverage.ticketsInPeriod.length} tickets covered`;
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

function factSection(title: string, fact: TicketDetail[keyof TicketDetail] | undefined) {
  if (!fact) return null;
  return (
    <div className="card" style={{ marginTop: '0.75rem' }}>
      <div className="card-title">{title}</div>
      {fact.status === 'unverifiable' ? (
        <p className="page-subtitle">✗ not verifiable — {fact.reason ?? 'no further detail.'}</p>
      ) : (
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 1rem', margin: 0, fontSize: '0.85rem' }}>
          {Object.entries(fact.data ?? {}).map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt style={{ color: 'var(--text-muted)' }}>{k}</dt>
              <dd style={{ margin: 0, wordBreak: 'break-word' }}>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
            </div>
          ))}
        </dl>
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
        <div className="card-title">Details{ticketId ? ` · ${ticketId}` : ''}</div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
      </div>
      {!element && <p className="page-subtitle">This element is no longer in the report.</p>}
      {element && !ticketId && (
        element.status === 'unverifiable'
          ? <p className="page-subtitle">✗ not verifiable — {element.reason ?? 'no further detail.'}</p>
          : (
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 1rem', margin: 0, fontSize: '0.85rem' }}>
              {Object.entries(element.data ?? {}).map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt style={{ color: 'var(--text-muted)' }}>{k}</dt>
                  <dd style={{ margin: 0, wordBreak: 'break-word' }}>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
                </div>
              ))}
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
  return (
    <div className={`reports-side${open ? ' reports-side-open' : ''}`}>
      <div className="card">
        <div className="card-title">Proof</div>
        <div className="reports-row"><span>Tickets referenced</span><b>{proof.ticketsReferenced.length}</b></div>
        <div className="reports-row"><span>Signatures valid</span><b style={{ color: 'var(--success)' }}>{proof.signaturesValid} ✓</b></div>
        <div className="reports-row"><span>Records checked</span><b style={{ color: 'var(--success)' }}>{proof.recordsChecked} ✓</b></div>
        <div className="reports-row"><span>Not verifiable</span><b>{proof.unverifiableCount}</b></div>
      </div>
      <div className="card" style={{ marginTop: '0.75rem' }}>
        <div className="card-title">Coverage</div>
        <div className="reports-row"><span>Cases</span><b>{coverage.coveredCases.length} of {coverage.loadedCases.length}</b></div>
        <div className="reports-row"><span>Tickets in test period</span><b>{coverage.ticketsReferenced.length} of {coverage.ticketsInPeriod.length}</b></div>
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
            <button type="button" className="btn btn-primary btn-sm" disabled title="coming soon">
              Export with proof
            </button>
          </div>
        </div>

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
