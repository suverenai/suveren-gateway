/**
 * "Export with proof" — shared wire type between the producer
 * (`export-report.ts`, runs inside the gateway) and the offline verifier
 * (`verify-export.ts`, runs inside `report-verify-cli.ts` with no gateway
 * and no network) — work-plan R6.
 *
 * ONE Authority Server key for the whole bundle, by design: every ticket in
 * `tickets` is a RAW signed receipt payload (`ArchivedReceipt.receipt`,
 * unmodified) meant to be checked with hap-core's own
 * `verifyReceiptSignature(ticket, authorityServer.publicKeyHex)` — the same
 * call a holder would make against a live Authority Server. This is
 * deliberately simpler than the live gateway's per-ticket pinned-key model
 * (`ticket-resolvers.ts` checks each archived receipt against the AS key
 * archived alongside IT): under the current architecture a gateway is paired
 * with exactly one Authority Server at a time and AS key rotation has no
 * supported path (`as-pairing.ts`: "AS rotated its key (unsupported today —
 * re-pairing is the only accepted path)"), so every ticket a report could
 * reference already shares one key in practice. A single embedded key also
 * gives the offline verifier exactly ONE fingerprint to confirm against the
 * trust anchor (`--key`/`--online`) instead of several — see verify-export.ts's
 * doc comment for why that single key is itself not proof of anything until
 * confirmed out of band.
 *
 * `report.html` is the AI's ORIGINAL sanitized html (never the gateway-drawn
 * `renderedHtml` a browser shows) — same value `ReportStore` persists as
 * `StoredReport.html`. Kept so the offline verifier can independently re-find
 * every `sv-*` reference the report makes, rather than trusting the
 * `proof`/`coverage` summaries traveling alongside it.
 */
import type { ArchivedAuthorization } from '../receipt-archive';
import type { ProofSummary, CoverageSummary } from './types';

export interface ExportBundle {
  format: 'suveren-report-export';
  version: 1;
  /** Unix seconds — when this file was generated. */
  exportedAt: number;
  /** The running gateway's own version string (e.g. "0.18.0"), or "dev"/"unknown"
   *  when it could not be determined — never fabricated. */
  gatewayVersion: string;
  report: {
    /** The AI's original sanitized html — see module doc comment. */
    html: string;
    savedAt: number;
    checkedAt: number;
  };
  proof: ProofSummary;
  coverage: CoverageSummary;
  authorityServer: {
    url: string;
    /** Hex-encoded Ed25519 public key. Empty string only when the gateway
     *  genuinely has none yet (no pairing, no archived ticket) — the export
     *  route refuses to produce a file in that case rather than ship this. */
    publicKeyHex: string;
  };
  /** Raw signed receipt payloads (`ArchivedReceipt.receipt`), unmodified —
   *  every ticket the report references PLUS every ticket in the coverage
   *  period, so "not referenced" is itself checkable. */
  tickets: Record<string, unknown>[];
  /** Keyed by authorizationId — the mandate(s) backing the included tickets. */
  authorizations: Record<string, ArchivedAuthorization>;
}

export function isExportBundle(v: unknown): v is ExportBundle {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.format !== 'suveren-report-export' || o.version !== 1) return false;
  if (!o.report || typeof o.report !== 'object') return false;
  if (!Array.isArray(o.tickets)) return false;
  if (!o.authorizations || typeof o.authorizations !== 'object') return false;
  if (!o.authorityServer || typeof o.authorityServer !== 'object') return false;
  const as = o.authorityServer as Record<string, unknown>;
  return typeof as.url === 'string' && typeof as.publicKeyHex === 'string';
}
