/**
 * Sample report fixture (test/fixtures/sample-report.html) against a REAL
 * matching scenario — work-plan "evidence-backed reports" R7-shaped check
 * (full e2e against real simulator data lives in hap-e2e; this is the
 * in-repo companion proving the fixture itself behaves as its own doc
 * comment claims): all six elements resolve, the deliberately wrong
 * reference is unverifiable, and the deliberately omitted case (C2) shows up
 * in coverage unprompted.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyReport } from '../../src/lib/report/verify-report';
import { renderReportHtml } from '../../src/lib/report/render-report';
import { buildScenario } from './fixtures/scenario';
import { buildEmailExport, buildErpExport } from './fixtures/exports';
import type { ExportSystem, RunConnectorExport } from '../../src/lib/report/types';

const FIXTURE_PATH = resolve(__dirname, '../fixtures/sample-report.html');

function makeRunExport(exports: Partial<Record<ExportSystem, unknown>>): RunConnectorExport {
  return async system => exports[system] ?? {};
}

describe('sample-report.html fixture', () => {
  it('all six elements resolve, the wrong reference is unverifiable, and C2 is reported as missing', async () => {
    const html = readFileSync(FIXTURE_PATH, 'utf-8');
    const { archive, addTicket } = buildScenario();

    const start = 1_800_000_000;
    addTicket({ id: 's1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: start + 300, authorization: { authorizationId: 'authz-1', profileId: 'erp@0.1', intent: 'Confirm stock before ordering.' } });
    addTicket({
      id: 'g1', action: 'erp__create_order', authorizationId: 'authz-1', timestamp: start + 1800,
      proposal: { createdAt: start + 300, status: 'approved', committedBy: { u1: { userId: 'M. Huber', at: start + 1800 } } },
    });

    const email = buildEmailExport({
      // Loaded before the emails' own dates — case times start at the email
      // (time metrics need a known load time; case-resolvers.ts).
      simulation_load: { name: 'sample', package_sha256: 'x', cases_loaded: 2, loaded_at: '2027-01-15T07:55:00Z' },
      inbox: [
        { id: 'm1', from_name: 'Kraus GmbH', from_email: 'orders@kraus.example', to_json: '[]', subject: 'Order inquiry', body: 'x', received_at: '2027-01-15T08:00:00Z', case_id: 'C1' },
        { id: 'm2', from_name: 'Other Co', from_email: 'buy@other.example', to_json: '[]', subject: 'Another order', body: 'y', received_at: '2027-01-15T09:00:00Z', case_id: 'C2' },
      ],
    });
    const erp = buildErpExport({ quotes: [{ id: 'Q1', number: 'Q-2027-0001', customer_id: 'kraus', status: 'sent', currency: 'EUR', net_total: 4380, created_at: '2027-01-15T08:10:00Z' }] });

    const result = await verifyReport(html, { archive, runExport: makeRunExport({ email, erp }) });

    const byKind = (kind: string) => result.elements.filter(e => e.kind === kind);
    expect(byKind('sv-metric')).toHaveLength(3);
    expect(byKind('sv-case')).toHaveLength(1);
    expect(byKind('sv-case')[0].status).toBe('verified');
    // Two sv-ticket elements: the real step "s1" and the deliberately wrong one.
    const tickets = byKind('sv-ticket');
    expect(tickets).toHaveLength(2);
    expect(tickets.find(t => t.attrs.ref === 's1')?.status).toBe('verified');
    expect(tickets.find(t => t.attrs.ref === 'rcpt_does_not_exist')?.status).toBe('unverifiable');
    expect(byKind('sv-approval')[0].status).toBe('verified');
    expect(byKind('sv-mandate')[0].status).toBe('verified');
    expect(byKind('sv-record')[0].status).toBe('verified');

    // The deliberately omitted case: loaded (C2) but never referenced.
    expect(result.coverage.loadedCases.sort()).toEqual(['C1', 'C2']);
    expect(result.coverage.coveredCases).toEqual(['C1']);
    expect(result.coverage.missingCases).toEqual(['C2']);

    expect(result.proof.unverifiableCount).toBe(1);

    // And the drawn render reflects all of this without inventing anything
    // for the bad reference.
    const rendered = renderReportHtml(result.html, result.elements);
    expect(rendered).not.toMatch(/<sv-/);
    expect(rendered).toMatch(/not verifiable/i);
  });
});
