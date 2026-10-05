/**
 * Report Verifier — shared types (work-plan "Added 2026-10-05 — evidence-backed
 * reports", step R5, backend half).
 *
 * This is the CONTRACT between the verifier (this module) and whatever renders
 * the report (a later UI step) — change it deliberately, together with the
 * callers. The six element kinds and their attribute names come from
 * `report-brief.ts` (step R3): that file is the single source of truth for
 * what the AI is told to write, this file is what reads it back.
 */
import type { ArchivedAuthorization, ArchivedReceipt } from '../receipt-archive';

/** The three simulator connectors a report can reference records from. */
export type ExportSystem = 'email' | 'crm' | 'erp';

/** Verification outcome for one placed element. */
export type ElementStatus = 'verified' | 'unverifiable' | 'warning';

/** One `sv-*` element the AI placed in its report HTML, resolved and checked. */
export interface VerifiedElement {
  /** Stable within one verifyReport() call: `${kind}-${index-in-document}`. */
  id: string;
  /** The tag name, e.g. "sv-ticket" — or an unrecognised "sv-whatever". */
  kind: string;
  /** The raw attributes as written by the AI (unmodified). */
  attrs: Record<string, string>;
  status: ElementStatus;
  /** Required when status !== 'verified' — why the element could not be trusted. */
  reason?: string;
  /** The verified facts this element renders, shape depends on `kind`. Present
   *  on 'verified' and 'warning' (a warning still has real, checked data —
   *  only one soft link could not be confirmed). Absent on 'unverifiable'. */
  data?: Record<string, unknown>;
}

/** Always added by the gateway, outside the AI's own HTML. */
export interface ProofSummary {
  /** Every distinct ticket id referenced by any element (sv-ticket/approval/mandate/case). */
  ticketsReferenced: string[];
  /** How many of those verified their Authority Server signature. */
  signaturesValid: number;
  /** How many sv-record elements resolved to a real record. */
  recordsChecked: number;
  /** Count of elements (any kind) that rendered as "not verifiable". */
  unverifiableCount: number;
  /** One entry per verified (or warning) element — the facts an approver can
   *  cross-check against the rendered report, so a fake badge is noticeable:
   *  it simply will not appear here. */
  verifiedValues: Array<{ elementId: string; kind: string; summary: string }>;
}

export interface CoverageSummary {
  /** case_id values present in the loaded email inbox. */
  loadedCases: string[];
  /** case_id values the report actually defined with an sv-case element
   *  whose `start` resolved to a real, case-tagged inbox message. */
  coveredCases: string[];
  /** loadedCases minus coveredCases, in loadedCases order. */
  missingCases: string[];
  /** Start of the test period (unix seconds): when the simulation package was
   *  loaded (email export `simulation_load.loaded_at`). null when unknown —
   *  then every archived ticket counts as in the period. */
  periodStart: number | null;
  /** Every archived ticket issued in the test period, oldest first. */
  ticketsInPeriod: string[];
  /** ticketsInPeriod that the report references (sv-ticket, sv-approval,
   *  sv-mandate, or an sv-case goal/step). */
  ticketsReferenced: string[];
  /** ticketsInPeriod the report does NOT reference — the AI cannot leave an
   *  awkward ticket out unnoticed. */
  ticketsNotReferenced: string[];
}

export interface VerifyReportResult {
  /** The AI's HTML, sanitized — safe to render in a sandboxed, script-free view. */
  html: string;
  elements: VerifiedElement[];
  proof: ProofSummary;
  coverage: CoverageSummary;
}

// ─── Injected data sources ──────────────────────────────────────────────────

/**
 * What this module needs from the receipt archive. Matches
 * `ReceiptArchive`'s own public shape (structurally) so the real class can be
 * passed directly — no adapter, no duplicate logic, real data in tests.
 */
export interface ReceiptArchiveReader {
  getReceipts(): ArchivedReceipt[];
  getAuthorizations(): ArchivedAuthorization[];
}

/**
 * Runs ONE simulator's own `export` CLI and returns its parsed JSON exactly as
 * printed — this module does not reshape it beyond narrowing the type, so a
 * schema drift in a connector is visible immediately rather than silently
 * absorbed. Called at most once per system per `verifyReport()` call (the
 * result is cached for the duration of that call).
 */
export type RunConnectorExport = (system: ExportSystem) => Promise<unknown>;

export interface ReportSources {
  archive: ReceiptArchiveReader;
  runExport: RunConnectorExport;
}

// ─── Connector export shapes ────────────────────────────────────────────────
// Narrow types for the fields this module actually reads, taken from each
// connector's own `exportRecord()` (hap-erp-mcp/hap-crm-mcp/hap-email-mcp
// `src/cli.ts`, `src/db.ts` — read 2026-10-05). Deliberately not exhaustive:
// an extra column on the real export is not our concern; a MISSING one is
// caught by `isXExport` below, which is why every field read here is listed.

export interface EmailMessage {
  id: string;
  from_name: string;
  from_email: string;
  to_json: string;
  cc_json?: string | null;
  subject: string;
  body: string;
  received_at: string;
  in_reply_to?: string | null;
  case_id?: string | null;
  receipt_id?: string | null;
}

export interface SimulatorChange {
  id: string;
  at: string;
  tool: string;
  receipt_id?: string | null;
  document_id?: string | null;
  document_number?: string | null;
  status?: string | null;
  net_total?: number | null;
  summary?: string | null;
}

export interface SimulatorRefusal {
  id: string;
  at: string;
  tool: string;
  receipt_id?: string | null;
  message: string;
}

export interface EmailSimulationLoad {
  name: string;
  package_sha256: string;
  cases_loaded: number;
  loaded_at: string;
  email?: string | null;
}

export interface EmailExport {
  mode: string;
  exported_at: string;
  /** The single row of the email simulator's simulation_load table (null before any load). */
  simulation_load?: EmailSimulationLoad | null;
  inbox: EmailMessage[];
  sent: EmailMessage[];
  changes: SimulatorChange[];
  refusals: SimulatorRefusal[];
}

export interface ErpQuote {
  id: string;
  number: string;
  customer_id: string;
  status: string;
  currency: string;
  net_total: number;
  created_at: string;
  sent_at?: string | null;
  receipt_id?: string | null;
  lines?: unknown[];
}

export interface ErpOrder {
  id: string;
  number: string;
  quote_id: string;
  customer_id: string;
  status: string;
  net_total: number;
  currency: string;
  created_at: string;
  receipt_id?: string | null;
}

export interface ErpExport {
  mode: string;
  exported_at: string;
  quotes: ErpQuote[];
  orders: ErpOrder[];
  changes: SimulatorChange[];
  refusals: SimulatorRefusal[];
}

export interface CrmRecord {
  id: string;
  created_at: string;
  receipt_id?: string | null;
  [key: string]: unknown;
}

export interface CrmExport {
  mode: string;
  exported_at: string;
  contacts: CrmRecord[];
  deals: CrmRecord[];
  tasks: CrmRecord[];
  activities: CrmRecord[];
  changes: SimulatorChange[];
  refusals: SimulatorRefusal[];
}

export function isEmailExport(v: unknown): v is EmailExport {
  const o = v as EmailExport;
  return !!o && Array.isArray(o.inbox) && Array.isArray(o.sent) &&
    Array.isArray(o.changes) && Array.isArray(o.refusals);
}

export function isErpExport(v: unknown): v is ErpExport {
  const o = v as ErpExport;
  return !!o && Array.isArray(o.quotes) && Array.isArray(o.orders) &&
    Array.isArray(o.changes) && Array.isArray(o.refusals);
}

export function isCrmExport(v: unknown): v is CrmExport {
  const o = v as CrmExport;
  return !!o && Array.isArray(o.contacts) && Array.isArray(o.deals) &&
    Array.isArray(o.changes) && Array.isArray(o.refusals);
}
