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
import { renderReportHtml, DRAWN_ELEMENT_STYLES } from '../../src/lib/report/render-report';
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

  it('a ticket card never shows the raw ticket id or a stray separator (polish 2026-10-05, second pass)', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const html = '<sv-ticket ref="t1"></sv-ticket>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport() });
    const out = renderReportHtml(result.html, result.elements);

    // No bare <code>t1</code> — the raw id belongs in the detail panel's
    // Technical details only.
    expect(out).not.toContain('<code>t1</code>');
    // The checkUrl + Details links sit in a single flex item: two links
    // joined by one real " · " separator, never an orphaned middle dot with
    // nothing adjacent (the bug: a bare text node between two <a> tags
    // became its own `justify-content: space-between` flex item).
    expect(out).toMatch(/Check on suveren\.ai ↗<\/a> · <a[^>]*>Details<\/a>/);
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

  it('SHOWS AN APPROVAL AS ITS OWN STEP, placed BEFORE the goal ticket it gates (asked/decided always precede execution)', async () => {
    const { archive, addTicket } = buildScenario();
    const email = buildEmailExport({
      inbox: [{ id: 'm1', from_name: 'A', from_email: 'a@example.com', to_json: '[]', subject: 'Order', body: 'x', received_at: '2026-10-01T09:00:00Z', case_id: 'C1' }],
    });
    addTicket({ id: 's1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_300 });
    addTicket({
      id: 'goal1', action: 'erp__convert_quote_to_order', authorizationId: 'authz-1', timestamp: 1_800_001_000,
      // Asked 680s before, decided 100s before the goal ticket executes —
      // a realistic approval-then-execution order.
      proposal: { createdAt: 1_800_000_320, status: 'approved', committedBy: { u1: { userId: 'M. Huber', at: 1_800_000_900 } } },
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
    expect(out).toContain('10 min');

    // REFUSAL (polish 2026-10-05, second pass): the first version always drew
    // a ticket's approval right AFTER its own card, which put the goal's
    // approval dead last — "Email in → Quote created → Reply sent →
    // Approval" read as if approval happened after the ticket already ran.
    // An approval is asked/decided BEFORE the ticket it gates executes, so it
    // belongs immediately BEFORE that ticket in the timeline.
    const approvalIdx = out.lastIndexOf('<div class="sv-step sv-step-approval">'); // the RENDERED step, not the CSS selector
    const goalIdx = out.indexOf('Order placed');
    expect(approvalIdx).toBeGreaterThan(-1);
    expect(goalIdx).toBeGreaterThan(-1);
    expect(approvalIdx).toBeLessThan(goalIdx);
  });

  it('an approval on a MIDDLE step sorts right before that step, not before the goal or after every other step', async () => {
    const { archive, addTicket } = buildScenario();
    const email = buildEmailExport({
      inbox: [{ id: 'm1', from_name: 'A', from_email: 'a@example.com', to_json: '[]', subject: 'Order', body: 'x', received_at: '2026-10-01T09:00:00Z', case_id: 'C1' }],
    });
    addTicket({ id: 's1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_200 });
    addTicket({
      id: 's2', action: 'crm__log_activity', authorizationId: 'authz-1', timestamp: 1_800_000_900,
      proposal: { createdAt: 1_800_000_500, status: 'approved', committedBy: { u1: { userId: 'M. Huber', at: 1_800_000_800 } } },
    });
    addTicket({ id: 'g1', action: 'erp__convert_quote_to_order', authorizationId: 'authz-1', timestamp: 1_800_001_200 });
    const html = '<sv-case start="email:m1" goal="ticket:g1" steps="s1 s2"></sv-case>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport({ email }) });
    expect(result.elements[0].status).toBe('verified');
    const out = renderReportHtml(result.html, result.elements);

    const quoteIdx = out.indexOf('Quote created'); // s1, no approval
    const approvalIdx = out.lastIndexOf('<div class="sv-step sv-step-approval">'); // s2's approval — the RENDERED step, not the CSS selector
    const activityIdx = out.indexOf('Activity logged'); // s2 itself
    const goalIdx = out.indexOf('Order placed'); // g1, no approval
    expect(quoteIdx).toBeGreaterThan(-1);
    expect(approvalIdx).toBeGreaterThan(-1);
    expect(activityIdx).toBeGreaterThan(-1);
    expect(goalIdx).toBeGreaterThan(-1);
    expect(quoteIdx).toBeLessThan(approvalIdx);
    expect(approvalIdx).toBeLessThan(activityIdx);
    expect(activityIdx).toBeLessThan(goalIdx);
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

  it('the approval step\'s text can wrap — no fixed width or nowrap that would cut it off (polish 2026-10-05, second pass)', () => {
    expect(DRAWN_ELEMENT_STYLES).toMatch(/\.sv-step-approval\s*\{[^}]*white-space:\s*normal/);
    expect(DRAWN_ELEMENT_STYLES).not.toMatch(/\.sv-step-approval\s*\{[^}]*white-space:\s*nowrap/);
    // A bounded max-width (rather than no width at all) is what forces a
    // flex item with flex-shrink:0 to wrap instead of growing to its
    // one-line content width and overflowing the visible frame.
    expect(DRAWN_ELEMENT_STYLES).toMatch(/\.sv-step-approval\s*\{[^}]*max-width:\s*\d+px/);
  });
});

describe('renderReportHtml(html, elements, interactive=false) — standalone export (R6, polish 2026-10-06)', () => {
  it('REFUSAL: drops the in-app "Details" link on a ticket card, keeping only the public check link with no orphaned separator', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const result = await verifyReport('<sv-ticket ref="t1"></sv-ticket>', { archive, runExport: makeRunExport() });

    const out = renderReportHtml(result.html, result.elements, false);
    expect(out).not.toMatch(/>Details</);
    expect(out).not.toMatch(/\/reports\?element=/);
    expect(out).toMatch(/Check on suveren\.ai/);
    // No trailing/leading " · " left behind where "Details" used to sit.
    expect(out).not.toMatch(/Check on suveren\.ai ↗<\/a>\s*·/);
    expect(out).not.toMatch(/·\s*<\/span>/);

    // The interactive default is UNCHANGED — same input still gets Details.
    const interactiveOut = renderReportHtml(result.html, result.elements);
    expect(interactiveOut).toMatch(/>Details</);
  });

  it('REFUSAL: drops the "Details" link on sv-approval/sv-mandate and the per-step/"Case details" links on sv-case', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({
      id: 'g1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_200,
      authorization: { authorizationId: 'authz-1', profileId: 'test-profile' },
      proposal: { status: 'committed', createdAt: 1_800_000_000, committedBy: { u1: { userId: 'alice', at: 1_800_000_100 } } },
    });
    const html =
      '<sv-approval ticket="g1"></sv-approval><sv-mandate ticket="g1"></sv-mandate>' +
      '<sv-case start="email:m1" goal="ticket:g1" steps=""></sv-case>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport({ email: buildEmailExport({ inbox: [{ id: 'm1', from_name: 'A', from_email: 'a@x.com', to_json: '[]', subject: 's', body: 'b', received_at: '2026-01-01T00:00:00Z', case_id: 'C1' }] }) }) });

    const out = renderReportHtml(result.html, result.elements, false);
    expect(out).not.toMatch(/>Details</);
    expect(out).not.toMatch(/Case details/);
    expect(out).not.toMatch(/\/reports\?element=/);
  });
});
