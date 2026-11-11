/**
 * The manifest `report` declaration (tool-gating-types.ts `ReportDeclaration`)
 * and what the gateway reads from it (report/systems.ts): checked at load,
 * unique per system, one case source; the shipped erp, crm and mail manifests
 * declare email, erp and crm exactly as the reports read them before.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invalidManifestReportReason, reportConflictReason } from '../../src/lib/manifest-loader';
import { reportSystemsOf, refusalTimesOf, resolveSystemRecord, isSystemExport, recordKinds } from '../../src/lib/report/systems';

const LEDGER_REPORT = {
  system: 'ledger',
  label: 'Ledger',
  tables: [
    { name: 'entries', required: true, record: { kind: 'entry', book: 'main' }, matchBy: ['id', 'ref_no'], time: { column: 'created_at' } },
    { name: 'changes', required: true, record: { kind: 'change' }, causingTicket: 'receipt_id', time: { column: 'at', ticket: 'receipt_id' } },
    { name: 'refusals', record: { kind: 'refusal' }, refusalTime: 'at', time: { column: 'at' } },
  ],
};
const LEDGER = { id: 'ledger', mcp: { command: 'ledger-mcp', args: [] }, report: LEDGER_REPORT };

describe('report systems from manifests', () => {
  it('one per declaring manifest, in manifest order, with its command', () => {
    const systems = reportSystemsOf([{ id: 'files', mcp: { command: 'files-mcp' } }, LEDGER]);
    expect(systems.map((s) => [s.system, s.connectorId, s.command])).toEqual([['ledger', 'ledger', 'ledger-mcp']]);
    expect(recordKinds(systems[0])).toEqual(['entries', 'changes', 'refusals']);
  });

  it('the shape check reads only the required tables', () => {
    const [ledger] = reportSystemsOf([LEDGER]);
    expect(isSystemExport(ledger, { entries: [], changes: [] })).toBe(true);
    expect(isSystemExport(ledger, { entries: [] })).toBe(false);
    expect(isSystemExport(ledger, null)).toBe(false);
  });

  it('refusal times come from the table that declares refusalTime', () => {
    const [ledger] = reportSystemsOf([LEDGER]);
    expect(refusalTimesOf(ledger, { entries: [], changes: [], refusals: [{ at: 'T1' }, { at: 'T2' }] })).toEqual(['T1', 'T2']);
  });

  it('a ref is matched column by column over all rows: id first, then ref_no', () => {
    const [ledger] = reportSystemsOf([LEDGER]);
    const exp = { entries: [{ id: 'A', ref_no: 'B' }, { id: 'B', ref_no: 'C' }], changes: [], refusals: [] };
    expect(resolveSystemRecord(ledger, exp, 'B').data).toEqual({ kind: 'entry', book: 'main', id: 'B', ref_no: 'C' });
    expect(resolveSystemRecord(ledger, exp, 'C').data).toEqual({ kind: 'entry', book: 'main', id: 'B', ref_no: 'C' });
  });
});

describe('the declaration is checked at load', () => {
  it('a well-formed one passes; a malformed one says what is wrong', () => {
    expect(invalidManifestReportReason(LEDGER as never)).toBeNull();
    expect(invalidManifestReportReason({ ...LEDGER, report: { ...LEDGER_REPORT, system: 'Ledger!' } } as never)).toMatch(/report.system/);
    expect(invalidManifestReportReason({ ...LEDGER, report: { ...LEDGER_REPORT, tables: [] } } as never)).toMatch(/report.tables/);
    expect(invalidManifestReportReason({ ...LEDGER, report: { ...LEDGER_REPORT, tables: [{ name: 'x', record: {} }] } } as never)).toMatch(/record.kind/);
    expect(invalidManifestReportReason({ ...LEDGER, report: { ...LEDGER_REPORT, extra: 1 } } as never)).toMatch(/unknown key "extra"/);
    // The reporting window dates every row by `time`: a table without it is refused at load.
    const noTime = { name: 'x', record: { kind: 'x' } };
    expect(invalidManifestReportReason({ ...LEDGER, report: { ...LEDGER_REPORT, tables: [noTime] } } as never)).toMatch(/report.tables\[0\].time must say when a row came into being/);
    expect(invalidManifestReportReason({ ...LEDGER, report: { ...LEDGER_REPORT, tables: [{ ...noTime, time: { column: '' } }] } } as never)).toMatch(/time.column/);
    expect(invalidManifestReportReason({ ...LEDGER, report: { ...LEDGER_REPORT, tables: [{ ...noTime, time: { column: 'd', when: 'x' } }] } } as never)).toMatch(/time has unknown key "when"/);
  });

  it('a second connector cannot declare the same system, nor a second case source', () => {
    expect(reportConflictReason({ report: LEDGER_REPORT } as never, [LEDGER as never])).toMatch(/already declared by ledger/);
    expect(reportConflictReason({ report: { ...LEDGER_REPORT, system: 'other', cases: true } } as never,
      [{ id: 'mail', report: { ...LEDGER_REPORT, system: 'email', cases: true } } as never])).toMatch(/report.cases is already declared by mail/);
  });

  it('every shipped report system loads', () => {
    const shipped = join(import.meta.dirname, '..', '..', '..', '..', 'content', 'integrations');
    const index = JSON.parse(readFileSync(join(shipped, 'index.json'), 'utf8')) as { integrations: Record<string, string> };
    const declared = Object.values(index.integrations)
      .map((f) => JSON.parse(readFileSync(join(shipped, f), 'utf8')))
      .filter((m) => m.report);
    expect(declared.map((m) => m.report.system).sort()).toEqual(['crm', 'email', 'erp']);
    for (const m of declared) expect(invalidManifestReportReason(m), m.id).toBeNull();
    expect(declared.filter((m) => m.report.cases).map((m) => m.id)).toEqual(['mail']);
  });
});
