/**
 * The systems a report can show records from — read from the connectors'
 * manifests (`report`, tool-gating-types.ts `ReportDeclaration`), never named
 * here. Everything a report needs from a system comes from its declaration:
 *
 *  - its export: `<mcp.command> export` (connector-export.ts);
 *  - whether that export is well-formed: every `required` table is an array;
 *  - the tables `get_records` may show (`tables`, in order; nothing else);
 *  - how an `sv-record ref` resolves: tables in order, each by its `matchBy`
 *    columns, to `{ ...record, causingReceiptId?, ...row }`;
 *  - which rows are refusals, and when (`refusalTime`, the `refusals` figure);
 *  - which system holds the loaded cases (`cases`).
 *
 * The order is the manifests' order.
 */
import { getManifestsOrOwn } from '../manifest-loader';
import type { ReportDeclaration, ReportTableDeclaration } from '../tool-gating-types';

export interface ReportSystem extends ReportDeclaration {
  /** The connector that declares it. */
  connectorId: string;
  /** Its command; the export runs as `<command> export`. */
  command: string;
}

export interface ReportSystemManifest {
  id: string;
  mcp?: { command?: string };
  report?: ReportDeclaration;
}

/** The report systems the given manifests declare, in their order. */
export function reportSystemsOf(manifests: ReportSystemManifest[]): ReportSystem[] {
  const out: ReportSystem[] = [];
  for (const m of manifests) {
    if (!m.report || !m.mcp?.command) continue;
    out.push({ ...m.report, connectorId: m.id, command: m.mcp.command });
  }
  return out;
}

/** The report systems of the gateway's manifests. */
export function reportSystems(): ReportSystem[] {
  return reportSystemsOf(getManifestsOrOwn());
}

/** One declared system by its report name, or undefined. */
export function reportSystem(system: unknown): ReportSystem | undefined {
  return typeof system === 'string' ? reportSystems().find(s => s.system === system) : undefined;
}

/** The system whose export holds the loaded cases, or undefined when no manifest declares one. */
export function caseSystem(): ReportSystem | undefined {
  return reportSystems().find(s => s.cases === true);
}

/** The tables `get_records` may show, in order. */
export function recordKinds(system: ReportSystem): string[] {
  return system.tables.map(t => t.name);
}

/** True when every table the system requires is an array in this export. */
export function isSystemExport(system: ReportSystem, exported: unknown): boolean {
  const o = exported as Record<string, unknown> | null | undefined;
  return !!o && system.tables.filter(t => t.required).every(t => Array.isArray(o[t.name]));
}

/** Its name at the start of a sentence: "email" -> "Email". */
export function capitalLabel(system: ReportSystem): string {
  return system.label.charAt(0).toUpperCase() + system.label.slice(1);
}

export interface RecordLookupResult {
  status: 'verified' | 'unverifiable';
  reason?: string;
  data?: Record<string, unknown>;
}

type Row = Record<string, unknown>;

function findRow(table: ReportTableDeclaration, rows: Row[], ref: string): Row | undefined {
  for (const column of table.matchBy ?? ['id']) {
    const row = rows.find(r => r[column] === ref);
    if (row) return row;
  }
  return undefined;
}

/**
 * Resolves `sv-record system="…" ref="…"` against that system's export: the
 * first row any declared table matches. A row from a table that declares
 * `causingTicket` carries the ticket that produced it (`causingReceiptId`) —
 * what a connector's change log exists for.
 */
export function resolveSystemRecord(system: ReportSystem, exportData: unknown, ref: string): RecordLookupResult {
  const exp = exportData as Record<string, unknown>;
  for (const table of system.tables) {
    const row = findRow(table, exp[table.name] as Row[], ref);
    if (!row) continue;
    const causing = table.causingTicket ? { causingReceiptId: row[table.causingTicket] ?? null } : {};
    return { status: 'verified', data: { ...table.record, ...causing, ...row } };
  }
  return { status: 'unverifiable', reason: `No ${system.label} record "${ref}" in the simulator export.` };
}

/** Every refusal time (raw column values) a system's export lists, from the tables that declare `refusalTime`. */
export function refusalTimesOf(system: ReportSystem, exportData: unknown): unknown[] {
  const exp = exportData as Record<string, unknown>;
  const out: unknown[] = [];
  for (const table of system.tables) {
    if (!table.refusalTime) continue;
    const rows = (exp[table.name] as Row[] | undefined) ?? [];
    for (const r of rows) out.push(r[table.refusalTime]);
  }
  return out;
}
