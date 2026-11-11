/**
 * A report system is whatever a connector's manifest declares (`report`,
 * tool-gating-types.ts `ReportDeclaration`) — the gateway names none. A
 * made-up connector, "ledger", declares one: its records must be
 * referenceable, listed and checked exactly like the shipped systems',
 * without any gateway code for it:
 *  - `sv-record system="ledger"` resolves by the declared tables and columns,
 *    a change row carries the ticket that caused it, an unknown ref is not
 *    verifiable;
 *  - get_records names it, shows only its declared tables, and refuses an
 *    export that lacks a required table;
 *  - its export runs as `<mcp.command> export`;
 *  - a second made-up connector, "desk", declares `cases`: the loaded cases,
 *    list_cases and coverage are read from it, not from a system named "email".
 * The declaration itself is checked in report-manifest-declaration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProfile } from '@hap/core';
import { loadManifests, getAllManifests } from '../../src/lib/manifest-loader';
import { verifyReport } from '../../src/lib/report/verify-report';
import { createConnectorExportRunner } from '../../src/lib/report/connector-export';
import { reportBuiltin } from '../../src/lib/builtins/report';
import type { ReportSources } from '../../src/lib/report/types';
import type { SharedState, EnrichedAuthorization } from '../../src/lib/shared-state';
import type { IntegrationManager } from '../../src/lib/integration-manager';

const FIXTURE_BIN_DIR = join(import.meta.dirname, 'fixtures', 'fake-connector-bin');
const profilesDir = process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', '..', 'hap-profiles');

const LEDGER_REPORT = {
  system: 'ledger',
  label: 'Ledger',
  tables: [
    { name: 'entries', required: true, record: { kind: 'entry', book: 'main' }, matchBy: ['id', 'ref_no'] },
    { name: 'changes', required: true, record: { kind: 'change' }, causingTicket: 'receipt_id' },
    { name: 'refusals', record: { kind: 'refusal' }, refusalTime: 'at' },
  ],
};
const LEDGER = {
  id: 'ledger', name: 'Ledger', version: '1', profile: 'bookkeeping',
  mcp: { command: 'fake-mcp', args: [] }, credentials: { fields: [], envMapping: {} }, oauth: null,
  toolGating: { default: { executionMapping: {} } },
  report: LEDGER_REPORT,
};

const recent = new Date(Date.now() - 3600_000).toISOString();
const LEDGER_EXPORT = {
  mode: 'simulation', exported_at: recent,
  entries: [{ id: 'e-1', ref_no: 'L-7', amount: 120, created_at: recent }],
  changes: [{ id: 'c-1', at: recent, tool: 'post_entry', receipt_id: 'tk-9' }],
  refusals: [{ id: 'r-1', at: '2026-11-01T10:00:00.000Z', tool: 'post_entry', message: 'over the limit' }],
  secret_notes: [{ id: 's-1', created_at: recent, text: 'never shown' }],
};

const DESK = {
  id: 'desk', name: 'Desk', version: '1', profile: 'support',
  mcp: { command: 'desk-mcp', args: [] }, credentials: { fields: [], envMapping: {} }, oauth: null,
  toolGating: { default: { executionMapping: {} } },
  report: {
    system: 'desk', label: 'help desk', cases: true,
    tables: [
      { name: 'inbox', required: true, record: { kind: 'message', folder: 'inbox' } },
      { name: 'sent', required: true, record: { kind: 'message', folder: 'sent' } },
    ],
  },
};
const DESK_EXPORT = {
  mode: 'simulation', exported_at: recent,
  simulation_load: null,
  inbox: [{ id: 'm-1', case_id: 'CASE-1', from_name: 'A', from_email: 'a@example.com', to_json: '[]', subject: 'Help', body: 'b', received_at: recent }],
  sent: [],
};

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'report-systems-'));
  mkdirSync(join(dir, 'ledger'));
  mkdirSync(join(dir, 'desk'));
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ integrations: { ledger: 'ledger/manifest.json', desk: 'desk/manifest.json' } }));
  writeFileSync(join(dir, 'ledger/manifest.json'), JSON.stringify(LEDGER));
  writeFileSync(join(dir, 'desk/manifest.json'), JSON.stringify(DESK));
  loadManifests(dir);
  const reporting = JSON.parse(readFileSync(join(profilesDir, 'reporting/0.2.profile.json'), 'utf8'));
  registerProfile(reporting.id, reporting);
  registerProfile('reporting', reporting);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const REPORTING_AUTH = {
  authorizationId: 'authz_r0000000-0000-4000-8000-000000000001',
  profileId: 'github.com/humanagencyprotocol/hap-profiles/reporting@0.2', path: 'p',
  frame: { read_access: 'unlimited', read_max_age_days: 30, report_daily_max: 5 },
  bounds: { read_access: 'unlimited', read_max_age_days: 30, report_daily_max: 5 },
  context: {}, attestations: [], requiredDomains: [], attestedDomains: [], deferredCommitmentDomains: [],
  signedCommitmentMode: 'automatic', complete: true, gateContent: null,
} as unknown as EnrichedAuthorization;

const emptyArchive = { getReceipts: () => [], getAuthorizations: () => [] };
const sources = (data: unknown = LEDGER_EXPORT): ReportSources => ({
  archive: emptyArchive,
  runExport: async (system) => {
    if (system === 'desk') return DESK_EXPORT;
    if (system !== 'ledger') throw new Error(`no ${system} here`);
    return data;
  },
});

describe('the made-up connectors', () => {
  it('are the only manifests loaded', () => {
    expect(getAllManifests().map((m) => m.id)).toEqual(['ledger', 'desk']);
  });
});

describe('sv-record against a declared system', () => {
  it('resolves by the declared columns, in table order, to the declared record facts plus the row', async () => {
    const r = await verifyReport('<sv-record system="ledger" ref="L-7"></sv-record>', sources());
    expect(r.elements[0]).toMatchObject({ status: 'verified', data: { kind: 'entry', book: 'main', id: 'e-1', amount: 120 } });
    expect(r.proof.recordsChecked).toBe(1);
  });

  it('a change row carries the ticket that caused it', async () => {
    const r = await verifyReport('<sv-record system="ledger" ref="c-1"></sv-record>', sources());
    expect(r.elements[0]).toMatchObject({ status: 'verified', data: { kind: 'change', causingReceiptId: 'tk-9' } });
  });

  it('an unknown ref is not verifiable, named by the declared label', async () => {
    const r = await verifyReport('<sv-record system="ledger" ref="nope"></sv-record>', sources());
    expect(r.elements[0]).toMatchObject({ status: 'unverifiable', reason: 'No Ledger record "nope" in the simulator export.' });
  });

  it('a row of an undeclared table is never a record', async () => {
    const r = await verifyReport('<sv-record system="ledger" ref="s-1"></sv-record>', sources());
    expect(r.elements[0].status).toBe('unverifiable');
  });

  it('a system no manifest declares is unknown', async () => {
    const r = await verifyReport('<sv-record system="erp" ref="Q-1"></sv-record>', sources());
    expect(r.elements[0]).toMatchObject({ status: 'unverifiable', reason: 'Unknown system "erp".' });
  });
});

describe('get_records for a declared system', () => {
  const tool = (data: unknown = LEDGER_EXPORT) => {
    const group = reportBuiltin({
      state: { getEnrichedAuthorizations: () => [REPORTING_AUTH] } as unknown as SharedState,
      integrationManager: {} as IntegrationManager,
      reportSources: sources(data),
    });
    return group.tools.find((t) => t.name === 'get_records')!;
  };

  it('names the system and its tables', () => {
    const t = tool();
    expect(t.description).toContain('Rows from one connected system (ledger or desk)');
    expect(t.description).toContain('(ledger: entries/changes/refusals; desk: inbox/sent)');
    expect((t.inputSchema as { properties: { system: { enum: string[] } } }).properties.system.enum).toEqual(['ledger', 'desk']);
  });

  it('returns only the declared tables', async () => {
    const out = await tool().handler({ system: 'ledger' });
    const body = JSON.parse((out.content[0] as { text: string }).text);
    expect(Object.keys(body.records)).toEqual(['entries', 'changes', 'refusals']);
    expect(body.records.entries).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('never shown');
  });

  it('refuses an undeclared table asked for by name, and an unknown system', async () => {
    expect((await tool().handler({ system: 'ledger', kind: 'secret_notes' })).isError).toBe(true);
    const unknown = await tool().handler({ system: 'erp' });
    expect((unknown.content[0] as { text: string }).text).toBe('system must be one of "ledger", "desk".');
  });

  it('refuses an export that lacks a required table', async () => {
    const { entries: _dropped, ...withoutEntries } = LEDGER_EXPORT;
    const out = await tool(withoutEntries).handler({ system: 'ledger' });
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toBe('ledger records were returned in an unexpected shape.');
  });
});

describe('the export command', () => {
  it('is the manifest\'s mcp.command, run with "export"', async () => {
    const run = createConnectorExportRunner({ integrationsBinDir: FIXTURE_BIN_DIR, dataDir: '/tmp/suveren-report-systems' });
    expect(await run('ledger')).toEqual({ sawDataDir: '/tmp/suveren-report-systems', ok: true });
  });

  it('is refused for a system no manifest declares', async () => {
    const run = createConnectorExportRunner({ integrationsBinDir: FIXTURE_BIN_DIR, dataDir: '/tmp/x' });
    await expect(run('nobody')).rejects.toThrow('no connector declares the report system "nobody"');
  });
});

describe('the declared case source', () => {
  it('list_cases reads the loaded cases from it', async () => {
    const group = reportBuiltin({
      state: { getEnrichedAuthorizations: () => [REPORTING_AUTH] } as unknown as SharedState,
      integrationManager: {} as IntegrationManager,
      reportSources: sources(),
    });
    const out = await group.tools.find((t) => t.name === 'list_cases')!.handler({});
    const body = JSON.parse((out.content[0] as { text: string }).text);
    expect(body.cases).toEqual([expect.objectContaining({ caseId: 'CASE-1', startMessageId: 'm-1', from: 'a@example.com' })]);
  });

  it('coverage counts its cases; sv-case resolves its start against it', async () => {
    const r = await verifyReport('<sv-case start="desk:m-1" goal="ticket:tk-1"></sv-case>', sources());
    expect(r.coverage.emailExportError).toBeUndefined();
    expect(r.coverage.loadedCases).toEqual(['CASE-1']);
    // The start resolved (the case is counted as addressed); the goal ticket is not in the empty archive.
    expect(r.coverage.coveredCases).toEqual(['CASE-1']);
    expect(r.elements[0].reason).toMatch(/^goal: /);
  });
});
