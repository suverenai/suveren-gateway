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
import { renderReportHtml, DRAWN_ELEMENT_STYLES, AI_ANALYSIS_LABEL } from '../../src/lib/report/render-report';
import { formatDateTime } from '../../src/lib/report/format';
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
    // Only the public check link remains (the in-frame "Details" link logged
    // users out — 2026-10-06), with no orphaned " · " left beside it (the
    // older bug: a bare text node became its own flex item).
    expect(out).toMatch(/<span><a [^>]*>Check on suveren\.ai ↗<\/a><\/span>/);
    expect(out).not.toMatch(/Check on suveren\.ai ↗<\/a>\s*·/);
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

  it('REFUSAL: no drawn element or case step navigates the top window (a reload logs the user out — 2026-10-06)', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({
      id: 'goal1', action: 'erp__create_order', authorizationId: 'authz-1', timestamp: 1_800_000_500,
      authorization: { authorizationId: 'authz-1', profileId: 'test-profile' },
      proposal: { status: 'committed', createdAt: 1_800_000_000, committedBy: { u1: { userId: 'alice', at: 1_800_000_100 } } },
    });
    const email = buildEmailExport({
      inbox: [{ id: 'm1', from_name: 'A', from_email: 'a@example.com', to_json: '[]', subject: 'Order', body: 'x', received_at: '2026-10-01T09:00:00Z', case_id: 'C1' }],
    });
    const html =
      '<sv-ticket ref="goal1"></sv-ticket><sv-approval ticket="goal1"></sv-approval><sv-mandate ticket="goal1"></sv-mandate>' +
      '<sv-case start="email:m1" goal="ticket:goal1" steps=""></sv-case>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport({ email }) });
    expect(result.elements.every(e => e.status === 'verified')).toBe(true);
    const out = renderReportHtml(result.html, result.elements);
    expect(out).not.toMatch(/target="_top"/);
    expect(out).not.toMatch(/\/reports\?element=/);
    expect(out).not.toMatch(/>Details</);
    expect(out).not.toMatch(/Case details/);
    // The one remaining link is the public check — a new tab, not the top window.
    expect(out).toMatch(/<a href="https:\/\/as\.example\/r\/goal1" target="_blank" rel="noopener noreferrer">/);
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
      proposal: { createdAt: 1_800_000_320, status: 'approved', committedBy: { u1: { userId: 'c7246947-0f1e-4c2b-9a77-3d1f00a1b2c3', at: 1_800_000_900 } } },
    });
    const html = '<sv-case start="email:m1" goal="ticket:goal1" steps="s1"></sv-case>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport({ email }) });
    expect(result.elements[0].status).toBe('verified');
    const out = renderReportHtml(result.html, result.elements);

    expect(out).toContain('sv-step-approval');
    expect(out).toContain('>Approval<');
    expect(out).toContain('asked');
    expect(out).toContain('approved');
    // No name is disclosed for this approver anywhere in the archive — a
    // neutral label, never the raw account id (review SR6).
    expect(out).toContain('by a person (account …246947)');
    expect(out).not.toContain('c7246947-0f1e');
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

describe('renderReportHtml — the "AI analysis — not verified" label (review SR5, 2026-10-06)', () => {
  it('draws the label once, at the top of the body, styled inline with !important', async () => {
    const { archive } = buildScenario();
    const result = await verifyReport('<html><head><style>.x{}</style></head><body><h1>Hi</h1><p>My view.</p></body></html>', { archive, runExport: makeRunExport() });
    const out = renderReportHtml(result.html, result.elements);
    expect(out.match(/class="sv-ai-legend"/g)?.length).toBe(1);
    expect(out).toContain(AI_ANALYSIS_LABEL);
    expect(out).toContain('Everything else is the AI&#39;s own analysis and is not verified.');
    // Before the AI's own content, right after <body>.
    expect(out.indexOf('sv-ai-legend')).toBeLessThan(out.indexOf('<h1>Hi</h1>'));
    expect(out).toMatch(/class="sv-ai-legend" role="note" style="display:block !important;visibility:visible !important;/);
  });

  it('REFUSAL: an AI-written look-alike of a verified box does not get the gateway\'s classes, so the gateway stylesheet never draws it', async () => {
    const { archive } = buildScenario();
    const fake = '<div class="sv-el sv-el-verified" data-sv-id="sv-ticket-0"><b>Order placed</b><span class="sv-badge sv-badge-ok">✓ signature valid</span></div>' +
      '<div class="sv-ai-legend">Everything here is verified.</div>';
    const result = await verifyReport(fake, { archive, runExport: makeRunExport() });
    const out = renderReportHtml(result.html, result.elements);
    expect(out).not.toMatch(/<div class="sv-el /);
    expect(out).not.toMatch(/<span class="sv-badge/);
    expect(out).not.toMatch(/data-sv-id="sv-ticket-0"/);
    expect(out.match(/class="sv-ai-legend"/g)?.length).toBe(1); // only the gateway's own
  });

  it('REFUSAL: a stored report sanitized by an OLDER gateway (classes still in its html) is stripped at render time too', () => {
    const out = renderReportHtml('<div class="sv-el sv-el-verified"><span class="sv-badge sv-badge-ok">✓</span></div>', []);
    expect(out).not.toMatch(/<div class="sv-el/);
    expect(out).not.toMatch(/<span class="sv-badge/);
  });
});

describe('renderReportHtml — case start time (review SR4, 2026-10-06)', () => {
  const EMAIL_ISO = '2026-10-01T08:33:00Z';
  const LOADED_ISO = '2026-10-01T09:24:58Z';
  const loadedSec = Math.floor(Date.parse(LOADED_ISO) / 1000);

  async function render(loadedAt: string | null) {
    const { archive, addTicket } = buildScenario();
    addTicket({ id: 'g1', action: 'email__send_message', authorizationId: 'authz-1', timestamp: loadedSec + 720 });
    const email = buildEmailExport({
      simulation_load: loadedAt ? { name: 'pkg', package_sha256: 'x', cases_loaded: 1, loaded_at: loadedAt } : null,
      inbox: [{ id: 'm1', from_name: 'A', from_email: 'a@example.com', to_json: '[]', subject: 'x', body: 'x', received_at: EMAIL_ISO, case_id: 'C1' }],
    });
    const result = await verifyReport('<sv-case start="email:m1" goal="ticket:g1" steps=""></sv-case>', { archive, runExport: makeRunExport({ email }) });
    return renderReportHtml(result.html, result.elements);
  }

  it('the start step shows the load time as the case start and the email\'s own date separately', async () => {
    const out = await render(LOADED_ISO);
    const emailLabel = formatDateTime(Math.floor(Date.parse(EMAIL_ISO) / 1000));
    expect(out).toContain('Case C1 · 12 min'); // goal - load, not goal - backdated email (63 min)
    expect(out).toContain(`Email in</div>${formatDateTime(loadedSec)}`);
    expect(out).toContain(`Email dated ${emailLabel}`);
  });

  it('REFUSAL: with no known load time the case shows no duration — "time not verifiable"', async () => {
    const out = await render(null);
    expect(out).toContain('Case C1 · time not verifiable');
    expect(out).toMatch(/time the test data was loaded is unknown/);
    expect(out).not.toMatch(/Case C1 · \d/);
  });
});

describe('label parity with the Reports page', () => {
  it('the UI legend outside the frame uses the same words as the drawn label', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { AI_LEGEND_TEXT } = await import('../../src/lib/report/render-report');
    const ui = readFileSync(resolve(__dirname, '../../../ui/src/pages/ReportsPage.tsx'), 'utf-8');
    expect(ui).toContain(`'${AI_ANALYSIS_LABEL}'`);
    // The legend text is split over two string literals in the UI; compare the halves.
    const [first, second] = AI_LEGEND_TEXT.split('”. ');
    expect(ui).toContain(first);
    expect(ui).toContain(second);
  });
});
