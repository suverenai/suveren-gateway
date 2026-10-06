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
import { escapeHtml, DRAWN_ELEMENT_STYLES, GLOSS_ON_STYLES, reportLegend } from './render-report';
import { formatDateTime } from './format';
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
 * Assembles the `ExportBundle` data — "the proof follows the report"
 * (work-plan "regular reporting", RR5; closes SR2: the file used to carry the
 * full intent text, bounds and scope of EVERY mandate used in the period,
 * whether the report showed it or not).
 *
 * Tickets: every ticket the report REFERENCES (`proof.ticketsReferenced`) plus
 * every ticket in the COVERAGE PERIOD (`coverage.ticketsInPeriod`), so "not
 * referenced" stays checkable — but only those the (window-scoped, see
 * window.ts) `archive` still holds: a ticket outside the reporting window never
 * enters the file, even if the report names it. A ticket goes in as its raw
 * signed payload; its signature covers the ticket itself, so a bare ticket is
 * fully verifiable on its own.
 *
 * Mandates: a mandate's data (bounds, scope, intent, attestation) goes in ONLY
 * when the report places an `sv-mandate` for one of its tickets AND that
 * element verified — the one place the report shows that data, and the one
 * element the offline checker needs it for (verify-export.ts). Every other
 * ticket goes in bare.
 */
export function buildExportBundle(params: BuildExportBundleParams): ExportBundle {
  const { stored, archive, authorityServer, gatewayVersion, now = Math.floor(Date.now() / 1000) } = params;
  const proof: ProofSummary = stored.result.proof;
  const coverage: CoverageSummary = stored.result.coverage;

  const ticketIdSet = new Set<string>([...proof.ticketsReferenced, ...coverage.ticketsInPeriod]);
  const entries = archive.getReceipts().filter(r => ticketIdSet.has(receiptId(r.receipt)));

  const tickets = entries.map(r => r.receipt);

  // A mandate is shown by an sv-mandate, and by a full sv-ticket whose
  // mandate group resolved (render-report.ts) — both place its data.
  const placedMandateTickets = new Set<string>([
    ...stored.result.elements
      .filter(e => e.kind === 'sv-mandate' && e.status !== 'unverifiable' && e.attrs.ticket)
      .map(e => e.attrs.ticket),
    ...stored.result.elements
      .filter(e => e.kind === 'sv-ticket' && e.status !== 'unverifiable' && e.attrs.ref && e.data?.mandate)
      .map(e => e.attrs.ref),
  ]);
  const authorizationIds = new Set(
    entries.filter(r => placedMandateTickets.has(receiptId(r.receipt))).map(r => r.authorizationId),
  );
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

/**
 * Plain, manager-readable sentences for an unreadable email simulator export
 * — mirrors `ReportsPage.tsx`'s `coverageCasesLine`/`periodStartNote` (same
 * convention as `format.ts`'s doc comment: not cross-imported, kept in step
 * by hand). The raw connector error (`coverage.emailExportError`, e.g. `spawn
 * email-mcp ENOENT`) is never shown in this visible panel — it still travels,
 * unredacted, in the embedded JSON bundle (polish 2026-10-06: a manager-
 * facing export showed that raw error verbatim, twice).
 */
function renderProofCoveragePanels(proof: ProofSummary, coverage: CoverageSummary): string {
  const casesLine = coverage.emailExportError
    ? 'unknown — the email simulator could not be read'
    : `${coverage.coveredCases.length} of ${coverage.loadedCases.length}`;
  const periodNote = coverage.periodStart === null
    ? `<p class="sv-export-note">${coverage.emailExportError
        ? 'Test period start unknown — the email simulator could not be read. All saved tickets were counted.'
        : 'Test period start unknown — all saved tickets were counted.'}</p>`
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

/** GLOSS_ON_STYLES, keyed to the export's CSS-only checkbox. */
const GLOSS_ON_TOGGLED = GLOSS_ON_STYLES.trim().split('\n').filter(Boolean)
  .map(rule => `#sv-gloss-toggle:checked ~ .sv-export-layout ${rule}`).join('\n');

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
.sv-export-legend { margin:8px 0 0 0; }
.sv-export-legend .sv-legend { border-bottom:0; padding:0; margin:0; }
.sv-toggle-input { position:absolute; opacity:0; width:1px; height:1px; }
.sv-translate { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:8px 0 0 0; }
.sv-toggle-switch { display:inline-flex; cursor:pointer; }
.sv-toggle-track { width:34px; height:18px; border-radius:999px; background:#d4d4d4; position:relative; flex:none; transition:background .15s ease; }
.sv-toggle-thumb { position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%; background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.25); transition:transform .15s ease; }
.sv-toggle-text { font-size:13px; font-weight:600; cursor:pointer; }
#sv-gloss-toggle:checked ~ .sv-export-header .sv-toggle-track { background:#111; }
#sv-gloss-toggle:checked ~ .sv-export-header .sv-toggle-thumb { transform:translateX(16px); }
#sv-gloss-toggle:focus-visible ~ .sv-export-header .sv-toggle-track { outline:2px solid #1d4ed8; outline-offset:2px; }
#sv-gloss-toggle:checked ~ .sv-export-layout .sv-gloss-toggle-mode ruby.sv-gloss rt { display:ruby-text; }
${GLOSS_ON_TOGGLED}
@media (max-width: 720px) {
  .sv-export-layout { flex-direction:column; }
  .sv-export-side { flex:1 1 auto; width:100%; }
}
`;

/** Same shape `formatDateTime` produces ("5 Oct, 14:26") but with the year
 *  inserted — used once, for the header's "exported" timestamp (its first
 *  mention of a date), so a file read months later is unambiguous about the
 *  year. The "checked" timestamp right next to it reuses the plain
 *  `formatDateTime` the gateway-drawn ticket cards already use, so the two
 *  never disagree in format (polish 2026-10-06: the header previously showed
 *  "21:43 UTC" next to cards reading "22:43" local — two clocks on one page). */
function formatDateTimeWithYear(value: number): string {
  const base = formatDateTime(value);
  const year = new Date(value * 1000).getFullYear();
  return base.replace(',', ` ${year},`);
}

/** "UTC+2" / "UTC-5" / "UTC+5:30" — the export process's own local offset,
 *  stated ONCE in the header so every timestamp in the file (header + every
 *  drawn card, all in the SAME local time per `format.ts`'s doc comment) is
 *  unambiguous without repeating a zone name on every line. Deliberately not
 *  an abbreviation like "CEST": that needs ICU locale data this codebase
 *  avoids for determinism (see `format.ts`'s own doc comment on
 *  `toLocaleString`). */
function utcOffsetLabel(value: number): string {
  const offsetMin = -new Date(value * 1000).getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = Math.floor(abs / 60);
  const mm = abs % 60;
  return `UTC${sign}${hh}${mm ? ':' + String(mm).padStart(2, '0') : ''}`;
}

export interface BuildExportDocumentParams {
  bundle: ExportBundle;
  /** `renderReportHtml(stored.result.html, stored.result.elements, { gloss:
   *  'toggle' })` — the same strict boxes the Reports page shows, computed by the caller so this module never
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
  // A CSS-only translation switch, when the render carries glosses
  // (renderReportHtml(..., { gloss: 'toggle' })). No script: a checkbox and
  // sibling selectors.
  const hasGloss = /<ruby class="sv-gloss">/.test(renderedHtml);
  const exportedLabel = formatDateTimeWithYear(bundle.exportedAt);
  const checkedLabel = formatDateTime(bundle.report.checkedAt);
  const tzLabel = utcOffsetLabel(bundle.exportedAt);
  const headerHtml =
    `<div class="sv-export-header">` +
    `<p class="sv-export-meta">Suveren Gateway ${escapeHtml(bundle.gatewayVersion)} — exported ${escapeHtml(exportedLabel)} &middot; checked ${escapeHtml(checkedLabel)} (times in ${escapeHtml(tzLabel)})</p>` +
    `<p class="sv-export-howto">How to check this report: each ticket below links to its public record on suveren.ai ("Check on suveren.ai ↗"). ` +
    `To verify this entire file offline (including every signature), run <code>suveren-gateway verify-report ${escapeHtml(suggestedFilename(bundle))}</code> from a terminal with the Suveren gateway CLI installed.</p>` +
    // The legend, once, in the gateway-owned header (no outside UI exists
    // around an exported file). The report body itself carries none.
    `<div class="sv-export-legend">${reportLegend(hasGloss)}</div>` +
    (hasGloss
      ? `<div class="sv-translate"><label for="sv-gloss-toggle" class="sv-toggle-switch" aria-hidden="true"><span class="sv-toggle-track"><span class="sv-toggle-thumb"></span></span></label>` +
        `<label for="sv-gloss-toggle" class="sv-toggle-text">Übersetzung anzeigen / show translation</label></div>`
      : '') +
    `</div>`;

  const proofScriptJson = JSON.stringify(bundle).replace(/<\//g, '<\\/');
  const proofScript = `<script type="application/json" id="suveren-proof">${proofScriptJson}</script>`;

  // CSP: the file runs nothing and loads nothing, even opened outside the
  // gateway's sandboxed frame (the JSON data block is not executable).
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`;
  const head = `<meta charset="utf-8">${csp}<title>Suveren report export — ${escapeHtml(exportedDate)}</title><style>${DRAWN_ELEMENT_STYLES}${EXPORT_PAGE_STYLES}</style>`;
  const toggleInput = hasGloss ? `<input type="checkbox" id="sv-gloss-toggle" class="sv-toggle-input">` : '';
  // Always a fresh document around the rendered FRAGMENT (renderReportHtml
  // returns one) — never a regex hunt for <head>/<body> inside it, which an
  // AI <header> element would match.
  return (
    `<!doctype html><html lang="en"><head>${head}</head><body>` +
    toggleInput + headerHtml +
    `<div class="sv-export-layout"><div class="sv-export-main">${renderedHtml}</div>` +
    `${renderProofCoveragePanels(bundle.proof, bundle.coverage)}</div>${proofScript}` +
    `</body></html>`
  );
}

/** `suveren-report-<YYYY-MM-DD>.html` — the download's own filename, and the
 *  example name shown in the in-file "how to check" instructions. */
export function suggestedFilename(bundle: Pick<ExportBundle, 'exportedAt'>): string {
  const date = new Date(bundle.exportedAt * 1000).toISOString().slice(0, 10);
  return `suveren-report-${date}.html`;
}
