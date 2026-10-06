/**
 * "Export with proof" — builds the ONE downloadable artifact from a stored,
 * already-verified report (work-plan R6). Two outputs, built together so they
 * can never drift: the `ExportBundle` (the data a verifier checks) and the
 * self-contained HTML document a manager opens in a browser.
 *
 * Security posture, matching `sanitize.ts`/`render-report.ts`: the final
 * document is assembled by STRING CONCATENATION of already-safe pieces
 * (the gateway-drawn `renderedHtml`, which is itself built from
 * sanitized + escaped input) plus our own static markup — it is NEVER run
 * back through `sanitize-html`, because that library's `exclusiveFilter`
 * would delete the one `<script type="application/json">` this file needs to
 * keep (sanitize.ts's `FORBIDDEN_TAGS` includes `script` unconditionally).
 * Every dynamic string this module inserts outside that JSON block goes
 * through `escapeHtml`.
 */
import { escapeHtml, renderReportHtml, DRAWN_ELEMENT_STYLES } from './render-report';
import type { ProofSummary, CoverageSummary, ReceiptArchiveReader } from './types';
import type { StoredReport } from './report-store';
import type { ArchivedAuthorization } from '../receipt-archive';
import type { ExportBundle } from './export-types';

export interface BuildExportBundleParams {
  stored: StoredReport;
  archive: ReceiptArchiveReader;
  authorityServer: { url: string; publicKeyHex: string };
  gatewayVersion: string;
  now?: number;
}

function receiptId(receipt: Record<string, unknown>): string {
  return typeof receipt.id === 'string' ? receipt.id : '';
}

/**
 * Assembles the `ExportBundle` data. Ticket selection mirrors the plan
 * exactly: every ticket the report REFERENCES (`proof.ticketsReferenced`)
 * plus every ticket in the COVERAGE PERIOD (`coverage.ticketsInPeriod`,
 * already the union of referenced + not-referenced for that window) — their
 * union, so a ticket outside the period that the report still names (an
 * older mandate cited for context) is never silently dropped.
 */
export function buildExportBundle(params: BuildExportBundleParams): ExportBundle {
  const { stored, archive, authorityServer, gatewayVersion, now = Math.floor(Date.now() / 1000) } = params;
  const proof: ProofSummary = stored.result.proof;
  const coverage: CoverageSummary = stored.result.coverage;

  const ticketIdSet = new Set<string>([...proof.ticketsReferenced, ...coverage.ticketsInPeriod]);
  const entries = archive.getReceipts().filter(r => ticketIdSet.has(receiptId(r.receipt)));

  const tickets = entries.map(r => r.receipt);

  const authorizationIds = new Set(entries.map(r => r.authorizationId));
  const authorizations: Record<string, ArchivedAuthorization> = {};
  for (const a of archive.getAuthorizations()) {
    if (authorizationIds.has(a.authorizationId)) authorizations[a.authorizationId] = a;
  }

  return {
    format: 'suveren-report-export',
    version: 1,
    exportedAt: now,
    gatewayVersion,
    report: { html: stored.html, savedAt: stored.savedAt, checkedAt: stored.checkedAt },
    proof,
    coverage,
    authorityServer,
    tickets,
    authorizations,
  };
}

// ─── Static Proof / Coverage panels (mirrors ReportsPage.tsx's SidePanel) ──

function countLine(count: number, noneText = 'none in this report'): string {
  return count > 0 ? `${count} ✓` : noneText;
}

function renderProofCoveragePanels(proof: ProofSummary, coverage: CoverageSummary): string {
  const casesLine = coverage.emailExportError
    ? `unknown — ${escapeHtml(coverage.emailExportError)}`
    : `${coverage.coveredCases.length} of ${coverage.loadedCases.length}`;
  const periodNote = coverage.periodStart === null
    ? `<p class="sv-export-note">Period start unknown${coverage.emailExportError ? ` (${escapeHtml(coverage.emailExportError)})` : ''} — all archived tickets counted.</p>`
    : '';
  const missingParts: string[] = [];
  if (coverage.missingCases.length > 0) missingParts.push(`cases ${coverage.missingCases.map(escapeHtml).join(', ')}`);
  if (coverage.ticketsNotReferenced.length > 0) missingParts.push(`${coverage.ticketsNotReferenced.length} ticket${coverage.ticketsNotReferenced.length === 1 ? '' : 's'}`);
  const missingLine = missingParts.length > 0 ? `<p class="sv-export-missing">Not in the report: ${missingParts.join(' · ')}</p>` : '';
  const checkedValues = proof.verifiedValues.length > 0
    ? `<div class="sv-export-card"><div class="sv-export-card-title">Checked values</div>${proof.verifiedValues.map(v => `<div class="sv-export-row"><span>${escapeHtml(v.summary)}</span></div>`).join('')}</div>`
    : '';

  return (
    `<aside class="sv-export-side">` +
    `<div class="sv-export-card"><div class="sv-export-card-title">Proof</div>` +
    `<div class="sv-export-row"><span>Tickets referenced</span><b>${proof.ticketsReferenced.length}</b></div>` +
    `<div class="sv-export-row"><span>Signatures valid</span><b>${escapeHtml(countLine(proof.signaturesValid))}</b></div>` +
    `<div class="sv-export-row"><span>Records checked</span><b>${escapeHtml(countLine(proof.recordsChecked))}</b></div>` +
    `<div class="sv-export-row"><span>Not verifiable</span><b>${proof.unverifiableCount}</b></div>` +
    `</div>` +
    `<div class="sv-export-card"><div class="sv-export-card-title">Coverage</div>` +
    `<div class="sv-export-row"><span>Cases</span><b>${casesLine}</b></div>` +
    `<div class="sv-export-row"><span>Tickets in test period</span><b>${coverage.ticketsReferenced.length} of ${coverage.ticketsInPeriod.length}</b></div>` +
    periodNote + missingLine +
    `</div>` +
    checkedValues +
    `</aside>`
  );
}

// ─── Document shell helpers (same best-effort regex injection convention as
// render-report.ts / ReportsPage.tsx's buildSrcDoc — no full HTML parse). ────

function ensureHtmlDocument(html: string): string {
  if (/<html[^>]*>/i.test(html)) return html;
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
}

function injectIntoHead(html: string, insert: string): string {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, m => `${m}${insert}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html([^>]*)>/i, m => `${m}<head>${insert}</head>`);
  return `<head>${insert}</head>${html}`;
}

function injectAfterBodyOpen(html: string, insert: string): string {
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body([^>]*)>/i, m => `${m}${insert}`);
  return `${insert}${html}`;
}

function injectBeforeBodyClose(html: string, insert: string): string {
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${insert}</body>`);
  return `${html}${insert}`;
}

const EXPORT_PAGE_STYLES = `
.sv-export-header { font:13px/1.5 system-ui, sans-serif; background:#f6f6f4; border-bottom:1px solid #e5e5e5; padding:14px 20px; }
.sv-export-meta { margin:0 0 6px 0; font-weight:600; }
.sv-export-howto { margin:0; color:#444; }
.sv-export-howto code { background:#eee; border-radius:4px; padding:1px 5px; font-size:12px; }
.sv-export-layout { display:flex; gap:20px; align-items:flex-start; padding:20px; font:13px/1.5 system-ui, sans-serif; }
.sv-export-main { flex:1 1 auto; min-width:0; }
.sv-export-side { flex:0 0 260px; }
.sv-export-card { border:1px solid #e5e5e5; border-radius:10px; padding:10px 12px; margin-bottom:12px; background:#fff; }
.sv-export-card-title { font-weight:700; margin-bottom:6px; }
.sv-export-row { display:flex; justify-content:space-between; gap:10px; margin:2px 0; }
.sv-export-note, .sv-export-missing { color:#b45309; font-size:12px; margin:4px 0 0 0; }
@media (max-width: 720px) {
  .sv-export-layout { flex-direction:column; }
  .sv-export-side { flex:1 1 auto; width:100%; }
}
`;

export interface BuildExportDocumentParams {
  bundle: ExportBundle;
  /** `renderReportHtml(stored.result.html, stored.result.elements)` — exactly
   *  what the Reports page shows, computed by the caller so this module never
   *  has to re-verify or re-derive it. */
  renderedHtml: string;
}

/**
 * Assembles the final, self-contained HTML file: the gateway-drawn report,
 * static Proof/Coverage panels, a plain-language header, and the embedded
 * JSON proof bundle. No executable script, no network requests, no external
 * fonts — openable offline in any browser.
 */
export function buildExportDocument(params: BuildExportDocumentParams): string {
  const { bundle, renderedHtml } = params;

  const exportedDate = new Date(bundle.exportedAt * 1000).toISOString().slice(0, 10);
  const checkedLabel = `${new Date(bundle.report.checkedAt * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  const headerHtml =
    `<div class="sv-export-header">` +
    `<p class="sv-export-meta">Report exported from Suveren Gateway ${escapeHtml(bundle.gatewayVersion)} on ${escapeHtml(exportedDate)} &middot; checked ${escapeHtml(checkedLabel)}</p>` +
    `<p class="sv-export-howto">How to check this report: each ticket below links to its public record on suveren.ai ("Check on suveren.ai ↗"). ` +
    `To verify this entire file offline (including every signature), run <code>suveren-gateway verify-report ${escapeHtml(suggestedFilename(bundle))}</code> from a terminal with the Suveren gateway CLI installed.</p>` +
    `</div>`;

  const proofScriptJson = JSON.stringify(bundle).replace(/<\//g, '<\\/');
  const proofScript = `<script type="application/json" id="suveren-proof">${proofScriptJson}</script>`;

  let doc = ensureHtmlDocument(renderedHtml);
  doc = injectIntoHead(doc, `<meta charset="utf-8"><title>Suveren report export — ${escapeHtml(exportedDate)}</title><style>${DRAWN_ELEMENT_STYLES}${EXPORT_PAGE_STYLES}</style>`);
  doc = injectAfterBodyOpen(doc, headerHtml + `<div class="sv-export-layout"><div class="sv-export-main">`);
  doc = injectBeforeBodyClose(doc, `</div>${renderProofCoveragePanels(bundle.proof, bundle.coverage)}</div>${proofScript}`);
  return doc;
}

/** `suveren-report-<YYYY-MM-DD>.html` — the download's own filename, and the
 *  example name shown in the in-file "how to check" instructions. */
export function suggestedFilename(bundle: Pick<ExportBundle, 'exportedAt'>): string {
  const date = new Date(bundle.exportedAt * 1000).toISOString().slice(0, 10);
  return `suveren-report-${date}.html`;
}
