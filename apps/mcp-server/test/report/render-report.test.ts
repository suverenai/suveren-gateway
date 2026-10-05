/**
 * render-report.ts — draws the six sv-* elements into static HTML, against
 * REAL `verifyReport()` output (not hand-built VerifiedElement fixtures): the
 * element ids this module matches on are an implementation detail of
 * parse-elements.ts/verify-report.ts, so testing against the real pipeline
 * catches a drift between the two id schemes that a hand-built fixture would
 * hide (engineering.md: "tests import the real thing").
 */
import { describe, it, expect } from 'vitest';
import { verifyReport } from '../../src/lib/report/verify-report';
import { renderReportHtml } from '../../src/lib/report/render-report';
import { buildScenario } from './fixtures/scenario';
import { buildEmailExport, buildErpExport } from './fixtures/exports';
import type { RunConnectorExport, ExportSystem } from '../../src/lib/report/types';

function makeRunExport(exports: Partial<Record<ExportSystem, unknown>> = {}): RunConnectorExport {
  return async system => exports[system] ?? {};
}

describe('renderReportHtml', () => {
  it('replaces a verified sv-ticket with drawn markup and removes the original tag', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const html = '<h1>Report</h1><sv-ticket ref="t1"></sv-ticket><p>after</p>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport() });

    const out = renderReportHtml(result.html, result.elements);
    expect(out).not.toMatch(/<sv-ticket/);
    expect(out).toContain('<h1>Report</h1>');
    expect(out).toContain('<p>after</p>');
    expect(out).toContain('t1');
    // Human action label, not the raw tool name (polish 2026-10-05: "no raw
    // technical values anywhere a manager reads").
    expect(out).toContain('Quote created');
    expect(out).not.toContain('erp__create_quote');
    expect(out).toContain('sv-badge-ok');
  });

  it('renders an unverifiable reference as a "not verifiable" card, never with invented content', async () => {
    const { archive } = buildScenario();
    const html = '<sv-ticket ref="does-not-exist"></sv-ticket>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport() });

    const out = renderReportHtml(result.html, result.elements);
    expect(out).toContain('sv-badge-bad');
    expect(out).toMatch(/not verifiable/i);
    expect(out).not.toContain('does-not-exist-action'); // nothing fabricated
  });

  it('an unknown sv-* element also renders as not verifiable, not passed through raw', async () => {
    const { archive } = buildScenario();
    const html = '<sv-bogus foo="bar"></sv-bogus>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport() });
    const out = renderReportHtml(result.html, result.elements);
    expect(out).not.toMatch(/<sv-bogus/);
    expect(out).toMatch(/not verifiable/i);
  });

  it('every drawn element and case step links with target="_top" to /reports?element=', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1' });
    const html = '<sv-ticket ref="t1"></sv-ticket>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport() });
    const out = renderReportHtml(result.html, result.elements);
    expect(out).toMatch(/href="\/reports\?element=sv-ticket-0"[^>]*target="_top"/);
  });

  it('sv-case draws a timeline whose step links carry &ticket= and target="_top"', async () => {
    const { archive, addTicket } = buildScenario();
    const email = buildEmailExport({
      inbox: [{ id: 'm1', from_name: 'A', from_email: 'a@example.com', to_json: '[]', subject: 'Order', body: 'x', received_at: '2026-10-01T09:00:00Z', case_id: 'C1' }],
    });
    addTicket({ id: 'goal1', action: 'erp__create_order', authorizationId: 'authz-1', timestamp: 1_800_000_500 });
    const html = '<sv-case start="email:m1" goal="ticket:goal1" steps=""></sv-case>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport({ email }) });

    expect(result.elements[0].status).toBe('verified');
    const out = renderReportHtml(result.html, result.elements);
    // "&" is correctly HTML-encoded as "&amp;" in the attribute value.
    expect(out).toMatch(/href="\/reports\?element=sv-case-0&amp;ticket=goal1"[^>]*target="_top"/);
  });

  it('the case start step reads "Email in", never the raw "email" kind label', async () => {
    const { archive, addTicket } = buildScenario();
    const email = buildEmailExport({
      inbox: [{ id: 'm1', from_name: 'A', from_email: 'a@example.com', to_json: '[]', subject: 'Order', body: 'x', received_at: '2026-10-01T09:00:00Z', case_id: 'C1' }],
    });
    addTicket({ id: 'goal1', action: 'erp__create_order', authorizationId: 'authz-1', timestamp: 1_800_000_500 });
    const html = '<sv-case start="email:m1" goal="ticket:goal1" steps=""></sv-case>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport({ email }) });
    const out = renderReportHtml(result.html, result.elements);
    expect(out).toContain('Email in');
  });

  it('a case step\'s big label is the human action, not the raw tool name', async () => {
    const { archive, addTicket } = buildScenario();
    const email = buildEmailExport({
      inbox: [{ id: 'm1', from_name: 'A', from_email: 'a@example.com', to_json: '[]', subject: 'Order', body: 'x', received_at: '2026-10-01T09:00:00Z', case_id: 'C1' }],
    });
    addTicket({ id: 's1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_300 });
    addTicket({ id: 'goal1', action: 'erp__convert_quote_to_order', authorizationId: 'authz-1', timestamp: 1_800_000_500 });
    const html = '<sv-case start="email:m1" goal="ticket:goal1" steps="s1"></sv-case>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport({ email }) });
    const out = renderReportHtml(result.html, result.elements);
    expect(out).toContain('Quote created');
    expect(out).toContain('Order placed');
    expect(out).not.toContain('erp__create_quote');
    expect(out).not.toContain('erp__convert_quote_to_order');
  });

  it('SHOWS AN APPROVAL AS ITS OWN STEP between the request and the decision, for any step/goal ticket with an archived approval', async () => {
    const { archive, addTicket } = buildScenario();
    const email = buildEmailExport({
      inbox: [{ id: 'm1', from_name: 'A', from_email: 'a@example.com', to_json: '[]', subject: 'Order', body: 'x', received_at: '2026-10-01T09:00:00Z', case_id: 'C1' }],
    });
    addTicket({ id: 's1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_300 });
    addTicket({
      id: 'goal1', action: 'erp__convert_quote_to_order', authorizationId: 'authz-1', timestamp: 1_800_001_000,
      proposal: { createdAt: 1_800_000_320, status: 'approved', committedBy: { u1: { userId: 'M. Huber', at: 1_800_000_320 + 24 * 60 } } },
    });
    const html = '<sv-case start="email:m1" goal="ticket:goal1" steps="s1"></sv-case>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport({ email }) });
    expect(result.elements[0].status).toBe('verified');
    const out = renderReportHtml(result.html, result.elements);

    expect(out).toContain('sv-step-approval');
    expect(out).toContain('>Approval<');
    expect(out).toContain('asked');
    expect(out).toContain('approved');
    expect(out).toContain('M. Huber');
    expect(out).toContain('24 min');

    // Order in the markup: the goal's own ticket step comes before its
    // approval step (request, then decision) — not folded into one card.
    const goalIdx = out.indexOf('Order placed');
    const approvalIdx = out.indexOf('sv-step-approval');
    expect(goalIdx).toBeGreaterThan(-1);
    expect(approvalIdx).toBeGreaterThan(goalIdx);
  });

  it('renders an sv-mandate\'s limits using the profile\'s own display name and unit, never the bare bound key', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({
      id: 't1', action: 'erp__create_quote', authorizationId: 'authz-sales',
      authorization: { authorizationId: 'authz-sales', profileId: 'sales@0.3', bounds: { value_max: 5000 } },
    });
    const html = '<sv-mandate ticket="t1"></sv-mandate>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport() });
    const out = renderReportHtml(result.html, result.elements);
    // No registered profile for this exact id in THIS test process —
    // formatBoundLabel's own fallback (humanized key) kicks in, proving the
    // mandate card never falls back to the bare "value_max" key or a raw
    // "≤"-joined number.
    expect(out).toContain('Value Max: 5 000');
    expect(out).not.toContain('value_max ≤');
  });

  it('a mandate\'s owners are never a bare did:key — unknown identity falls back to a labeled, truncated key', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({
      id: 't1', action: 'erp__create_quote', authorizationId: 'authz-owner',
      authorization: { authorizationId: 'authz-owner', profileId: 'sales@0.3', owners: ['did:key:zOwner9'] },
    });
    const html = '<sv-mandate ticket="t1"></sv-mandate>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport() });
    const out = renderReportHtml(result.html, result.elements);
    expect(out).not.toContain('did:key:zOwner9');
    expect(out).toContain('Owner (key …Owner9)');
  });

  it('a record\'s amount and dates render as currency/human time, not raw numbers/ISO strings', async () => {
    const { archive } = buildScenario();
    const erp = buildErpExport({
      quotes: [{ id: 'q1', number: 'Q-1', customer_id: 'c1', status: 'sent', currency: 'EUR', net_total: 4380, created_at: '2027-01-15T08:10:00.000Z' }],
    });
    const html = '<sv-record system="erp" ref="q1"></sv-record>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport({ erp }) });
    const out = renderReportHtml(result.html, result.elements);
    expect(out).toContain('€ 4 380');
    expect(out).not.toContain('4380<');
    expect(out).not.toContain('2027-01-15T08:10:00');
  });

  it('escapes HTML in drawn values — intent/subject text cannot inject markup', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({
      id: 't1',
      action: 'erp__create_quote',
      authorizationId: 'authz-1',
      authorization: {
        authorizationId: 'authz-1',
        profileId: 'erp@0.1',
        intent: '<img src=x onerror=alert(1)>',
      },
    });
    const html = '<sv-mandate ticket="t1"></sv-mandate>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport() });
    const out = renderReportHtml(result.html, result.elements);
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img');
  });

  it('inserts the drawn-element stylesheet exactly once', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1' });
    addTicket({ id: 't2', action: 'erp__send_quote', authorizationId: 'authz-1' });
    const html = '<sv-ticket ref="t1"></sv-ticket><sv-ticket ref="t2"></sv-ticket>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport() });
    const out = renderReportHtml(result.html, result.elements);
    expect(out.match(/data-sv-drawn-styles/g)?.length).toBe(1);
  });

  it('a figure over zero verified cases draws as not-verifiable, never a green zero', async () => {
    const { archive } = buildScenario();
    const html = '<sv-metric kind="completed" cases="all"></sv-metric>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport() });
    const out = renderReportHtml(result.html, result.elements);
    expect(out).toContain('sv-badge sv-badge-bad');
    // Only the stylesheet's own selector rule may mention sv-badge-ok — no
    // element actually wears that badge class.
    expect(out).not.toContain('sv-badge sv-badge-ok');
    expect(out).toMatch(/no verified cases/i);
  });

  it('a figure over a partial set of requested cases draws amber, with its real value and the "N of M" note', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({ id: 'g1', action: 'erp__create_order', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const email = buildEmailExport({
      inbox: [{ id: 'm1', from_name: 'A', from_email: 'a@example.com', to_json: '[]', subject: 'x', body: 'x', received_at: '2026-10-01T09:00:00Z', case_id: 'C1' }],
    });
    const html = '<sv-case start="email:m1" goal="ticket:g1" steps=""></sv-case><sv-metric kind="completed" cases="C1 C2"></sv-metric>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport({ email }) });
    const out = renderReportHtml(result.html, result.elements);
    expect(out).toContain('sv-badge-warn');
    expect(out).toMatch(/1 of 2 requested/i);
    expect(out).toContain('>1<'); // the real computed value, not hidden
  });

  it('leaves the AI\'s own free HTML/CSS/SVG completely untouched', async () => {
    const { archive } = buildScenario();
    const html = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg><div class="chart">AI analysis</div>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport() });
    const out = renderReportHtml(result.html, result.elements);
    expect(out).toContain('<svg viewBox="0 0 10 10">');
    expect(out).toContain('AI analysis');
  });
});
