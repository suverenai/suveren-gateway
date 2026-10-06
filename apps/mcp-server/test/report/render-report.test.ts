/**
 * render-report.ts — the two-tag rule's drawing half (work-plan "regular
 * reporting", decision 5, RR6), against REAL `verifyReport()` output (the
 * element ids are an implementation detail shared with parse-elements.ts —
 * testing through the real pipeline catches a drift between the two).
 */
import { describe, it, expect } from 'vitest';
import { parseDocument, DomUtils } from 'htmlparser2';
import { verifyReport } from '../../src/lib/report/verify-report';
import { renderReportHtml, glossaryUsage, DRAWN_ELEMENT_STYLES, AI_ANALYSIS_LABEL, METRIC_FIELDS } from '../../src/lib/report/render-report';
import { formatTimestamp } from '../../src/lib/report/format';
import { buildScenario } from './fixtures/scenario';
import { buildEmailExport, buildErpExport } from './fixtures/exports';
import type { RunConnectorExport, ExportSystem, VerifiedElement } from '../../src/lib/report/types';

function makeRunExport(exports: Partial<Record<ExportSystem, unknown>> = {}): RunConnectorExport {
  return async system => exports[system] ?? {};
}

const INBOX_C1 = { id: 'm1', from_name: 'A', from_email: 'a@example.com', to_json: '[]', subject: 'Order', body: 'x', received_at: '2026-10-01T09:00:00Z', case_id: 'C1' };

/** Every drawn verified box (`data-sv-id`) as { id, text }. */
function boxes(out: string): Array<{ id: string; text: string; html: string }> {
  const doc = parseDocument(out);
  return DomUtils.findAll(e => typeof e.attribs['data-sv-id'] === 'string', doc.children).map(e => ({
    id: e.attribs['data-sv-id'],
    text: DomUtils.textContent(e),
    html: DomUtils.getOuterHTML(e),
  }));
}

/** A full scenario touching every element kind, with mandate + approval. */
async function fullScenario(html: string) {
  const { archive, addTicket } = buildScenario();
  const loaded = '2026-10-01T09:05:00Z';
  const loadedSec = Math.floor(Date.parse(loaded) / 1000);
  addTicket({
    id: 's1', action: 'erp__create_quote', authorizationId: 'authz-sales', timestamp: loadedSec + 300,
    extra: { executionContext: { value: 3200, currency: 'EUR', discount_pct: 5 } },
    authorization: { authorizationId: 'authz-sales', profileId: 'sales@0.3', bounds: { value_max: 5000, discount_max: 10 }, intent: 'Quotes up to 5000', commitmentMode: 'review' },
    proposal: { status: 'executed', createdAt: loadedSec + 100, committedBy: { u1: { userId: 'c7246947-0f1e-4c2b-9a77-3d1f00a1b2c3', at: loadedSec + 240 } } },
  });
  addTicket({ id: 'g1', action: 'email__send_message', authorizationId: 'authz-mail', timestamp: loadedSec + 540 });
  const email = buildEmailExport({
    simulation_load: { name: 'pkg', package_sha256: 'x', cases_loaded: 1, loaded_at: loaded },
    inbox: [{ ...INBOX_C1, received_at: '2026-10-01T08:33:00Z' }],
  });
  const erp = buildErpExport({
    quotes: [{ id: 'q1', number: 'Q-1', customer_id: 'c1', status: 'sent', currency: 'EUR', net_total: 4380, created_at: '2026-10-01T09:10:00Z', receipt_id: 's1' }],
  });
  const result = await verifyReport(html, { archive, runExport: makeRunExport({ email, erp }) });
  return { result, loadedSec };
}

const ALL_KINDS_HTML =
  '<sv-ai><h1>Week</h1></sv-ai>' +
  '<sv-row><sv-metric kind="completed" cases="all"></sv-metric><sv-metric kind="median-approval-wait" cases="all"></sv-metric></sv-row>' +
  '<sv-case start="email:m1" goal="ticket:g1" steps="s1"></sv-case>' +
  '<sv-ticket ref="s1" variant="compact"></sv-ticket><sv-ticket ref="s1" variant="full"></sv-ticket>' +
  '<sv-approval ticket="s1"></sv-approval><sv-mandate ticket="s1"></sv-mandate><sv-record system="erp" ref="q1"></sv-record>';

describe('renderReportHtml — frames', () => {
  it('every sv-ai block is drawn in a grey, labelled, clipped frame', async () => {
    const { archive } = buildScenario();
    const result = await verifyReport('<sv-ai><p>one</p></sv-ai><sv-ai><p>two</p></sv-ai>', { archive, runExport: makeRunExport() });
    const out = renderReportHtml(result.html, result.elements);
    expect(out.match(/<div class="sv-ai-block">/g)).toHaveLength(2);
    expect(out.match(new RegExp(`<span class="sv-ai-label">${AI_ANALYSIS_LABEL}</span>`, 'g'))).toHaveLength(2);
    expect(DRAWN_ELEMENT_STYLES).toMatch(/\.sv-ai-block \{[^}]*position:relative;[^}]*isolation:isolate;[^}]*contain:paint;[^}]*overflow:hidden;[^}]*dashed/);
  });

  it('REFUSAL: a fake green box written by the AI renders inside a grey frame, without the gateway\'s classes', async () => {
    const { archive } = buildScenario();
    const fake = '<sv-ai><div class="sv-el sv-el-verified" data-sv-id="sv-ticket-0" style="border:2px solid green"><span class="sv-badge sv-badge-ok">✓ verified · signed</span> on_time_pct 98</div></sv-ai>';
    const result = await verifyReport(fake, { archive, runExport: makeRunExport() });
    const out = renderReportHtml(result.html, result.elements);
    expect(boxes(out)).toHaveLength(0); // no gateway box exists
    const frameStart = out.indexOf('<div class="sv-ai-block">');
    expect(frameStart).toBeGreaterThan(-1);
    expect(out.indexOf('on_time_pct 98')).toBeGreaterThan(frameStart);
    expect(out).not.toMatch(/<div class="sv-el /);
  });

  it('REFUSAL: a stored report from an older gateway (free html, gateway classes) is held to the rule at render time', () => {
    const out = renderReportHtml('<p>loose</p><div class="sv-el sv-el-verified"><span class="sv-badge sv-badge-ok">✓</span></div>', []);
    expect(out).not.toContain('loose');
    expect(out).not.toMatch(/<div class="sv-el /);
  });

  it('sv-row draws a responsive row of verified boxes', async () => {
    const { result } = await fullScenario(ALL_KINDS_HTML);
    const out = renderReportHtml(result.html, result.elements);
    expect(out).toMatch(/<div class="sv-row"><div class="sv-el sv-el-verified" data-sv-id="sv-metric-0">/);
    expect(DRAWN_ELEMENT_STYLES).toMatch(/\.sv-row \{[^}]*grid-template-columns:repeat\(auto-fit, minmax\(/);
  });

  it('inserts the drawn-element stylesheet exactly once', async () => {
    const { result } = await fullScenario(ALL_KINDS_HTML);
    const out = renderReportHtml(result.html, result.elements);
    expect(out.match(/data-sv-drawn-styles/g)?.length).toBe(1);
  });

  it('the one link out of a box is the public check, in a new tab — no in-app navigation', async () => {
    const { result } = await fullScenario(ALL_KINDS_HTML);
    const out = renderReportHtml(result.html, result.elements);
    expect(out).not.toMatch(/target="_top"/);
    expect(out).not.toMatch(/\/reports\?element=/);
    expect(out).toMatch(/<a href="https:\/\/as\.example\/r\/s1" target="_blank" rel="noopener noreferrer">Check on suveren\.ai ↗<\/a>/);
  });
});

describe('renderReportHtml — verified boxes carry no interpretation', () => {
  it('every element verifies in the full scenario', async () => {
    const { result } = await fullScenario(ALL_KINDS_HTML);
    expect(result.elements.map(e => `${e.id}:${e.status}`)).toEqual(result.elements.map(e => `${e.id}:verified`));
  });

  it('box text is ONLY signed field names, source values, formatted timestamps, formulas, the seal and the link', async () => {
    const { result } = await fullScenario(ALL_KINDS_HTML);
    const out = renderReportHtml(result.html, result.elements);

    // The allow-list, built from the source data — not from the renderer.
    const allowed = new Set<string>([
      // signed field names (ticket, execution context, mandate bounds, approval, record, case)
      'action', 'actionType', 'profileId', 'value', 'currency', 'discount_pct', 'mandate', 'value_max', 'discount_max',
      'commitment_mode', 'owner', 'approval', 'createdAt', 'decidedAt', 'committedBy', 'timestamp', 'ticket', 'intent',
      'status', 'wait_s', 'id', 'number', 'customer_id', 'net_total', 'created_at', 'receipt_id', 'case_id', 'duration_s',
      'received_at', 'subject', 'from_email', 'simulation_load.loaded_at', 'approval.createdAt', 'approval.decidedAt',
      'approval.committedBy', 'cases',
      // source values
      'erp__create_quote', 'email__send_message', 'write', 'sales@0.3', '3200', 'EUR', '5', '5000', '10', 'review',
      'executed', 'Quotes up to 5000', 's1', 'q1', 'Q-1', 'c1', 'sent', '4380', 'C1', 'Order', 'a@example.com', '140',
      // identity labels the resolvers produce for undisclosed people (identity.ts)
      'Owner (name not disclosed)', 'a person (name not disclosed)',
      // gateway frame: seal, source types, step tags, link
      '✓ verified · signed', '✓ verified · archive', '✓ verified · database', '✓ verified · computed',
      'database', 'archive', 'signed · goal', 'signed', 'Check on suveren.ai ↗',
      // formulas over visible fields
      ...Object.values(METRIC_FIELDS).flatMap(f => [f.name, `= ${f.formula}`]),
      '= decidedAt − createdAt', '= goal.timestamp − max(start.received_at, simulation_load.loaded_at)',
    ]);
    // Computed raw values and every timestamp in its one readable format.
    for (const el of result.elements) {
      const d = (el.data ?? {}) as Record<string, unknown>;
      if (el.kind === 'sv-metric') allowed.add(String(d.value));
      if (el.kind === 'sv-case') allowed.add(String(d.totalDurationSeconds));
    }
    for (const t of collectTimestamps(result.elements)) allowed.add(formatTimestamp(t));

    const all = boxes(out);
    expect(all.length).toBe(result.elements.length);
    for (const b of all) {
      let rest = b.text;
      for (const tok of [...allowed].sort((x, y) => y.length - x.length)) rest = rest.split(tok).join(' ');
      expect({ id: b.id, rest: rest.replace(/[\s·=−,()/[\]]+/g, '') }).toEqual({ id: b.id, rest: '' });
    }
  });

  it('REFUSAL: none of the old human labels appear inside a verified box', async () => {
    const { result } = await fullScenario(ALL_KINDS_HTML);
    const out = renderReportHtml(result.html, result.elements);
    for (const b of boxes(out)) {
      for (const word of ['Quote created', 'Email in', 'Email sent', 'waited', 'asked', 'approved ', 'Approval', 'Report written', 'Value Max', '€', 'min', 'Max value', 'within', 'Intent:']) {
        expect({ id: b.id, has: b.text.includes(word), word }).toEqual({ id: b.id, has: false, word });
      }
    }
  });

  it('compact ticket = action + timestamp + seal; the ticket id appears only in the full variant, on a ticket line', async () => {
    const { result } = await fullScenario(ALL_KINDS_HTML);
    const out = renderReportHtml(result.html, result.elements);
    const [compact, full] = boxes(out).filter(b => b.id.startsWith('sv-ticket'));
    expect(compact.text).toContain('erp__create_quote');
    expect(compact.text).toContain('timestamp');
    expect(compact.text).toContain('✓ verified · signed');
    expect(compact.text).not.toContain('s1');
    expect(compact.text).not.toContain('Check on');
    expect(full.html).toMatch(/<span class="sv-k">ticket<\/span><span class="sv-v">s1<\/span>/);
    expect(full.html).toContain('<div class="sv-group-label"><span class="sv-k">mandate</span>');
    expect(full.html).toContain('<div class="sv-group-label"><span class="sv-k">approval</span>');
    expect(full.html).toMatch(/<span class="sv-k">value_max<\/span><span class="sv-v">5000<\/span>/);
    expect(full.html).toMatch(/<span class="sv-k">value<\/span><span class="sv-v">3200<\/span>/);
  });

  it('computed values show the field name, the raw value and the formula', async () => {
    const { result } = await fullScenario(ALL_KINDS_HTML);
    const out = renderReportHtml(result.html, result.elements);
    expect(out).toContain('<span class="sv-k">cases_completed</span><span class="sv-v">1</span><span class="sv-f">= count(case.goal verified)</span>');
    expect(out).toContain('<span class="sv-k">median_approval_wait_s</span><span class="sv-v">140</span>');
    // case: goal − max(email, load) = 540 (the backdated email is not the start)
    expect(out).toContain('<span class="sv-k">duration_s</span><span class="sv-v">540</span><span class="sv-f">= goal.timestamp − max(start.received_at, simulation_load.loaded_at)</span>');
    expect(out).toContain('<span class="sv-k">wait_s</span><span class="sv-v">140</span><span class="sv-f">= decidedAt − createdAt</span>');
  });

  it('case steps show real fields, in time order, the approval right before the action it approved', async () => {
    const { result, loadedSec } = await fullScenario(ALL_KINDS_HTML);
    const out = renderReportHtml(result.html, result.elements);
    const c = boxes(out).find(b => b.id === 'sv-case-0')!;
    const order = ['received_at', 'subject', 'from_email', 'simulation_load.loaded_at', 'approval.createdAt', 'approval.decidedAt', 'approval.committedBy', 'erp__create_quote', 'email__send_message'];
    const timeline = c.text.slice(c.text.indexOf('loaded_at)') + 'loaded_at)'.length); // after the duration formula
    const idx = order.map(t => timeline.indexOf(t));
    expect(idx.every(i => i > -1)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(c.text).toContain(formatTimestamp(loadedSec));
    expect(c.text).toContain(formatTimestamp('2026-10-01T08:33:00Z'));
    expect(c.text).not.toContain('c7246947');
  });

  it('timestamps use one readable deterministic format', () => {
    expect(formatTimestamp(1_791_271_654)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [A-Z][A-Z0-9:+-]+$/);
    expect(formatTimestamp('2026-10-01 09:00:00')).toBe(formatTimestamp(Math.floor(Date.parse('2026-10-01T09:00:00Z') / 1000)));
  });

  it('an unverifiable reference draws as "not verifiable", never with invented content', async () => {
    const { archive } = buildScenario();
    const result = await verifyReport('<sv-ticket ref="does-not-exist"></sv-ticket><sv-bogus foo="bar"></sv-bogus>', { archive, runExport: makeRunExport() });
    const out = renderReportHtml(result.html, result.elements);
    expect(out.match(/sv-badge sv-badge-bad/g)).toHaveLength(2);
    expect(out).not.toMatch(/<sv-bogus/);
  });

  it('a figure over zero verified cases draws as not verifiable, never a green zero', async () => {
    const { archive } = buildScenario();
    const result = await verifyReport('<sv-metric kind="completed" cases="all"></sv-metric>', { archive, runExport: makeRunExport() });
    const out = renderReportHtml(result.html, result.elements);
    expect(out).toContain('sv-badge sv-badge-bad');
    expect(out).not.toContain('sv-badge sv-badge-ok');
    expect(out).toMatch(/no verified cases/i);
  });

  it('a figure over a partial set of cases draws amber, with its real value and the "N of M" note', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({ id: 'g1', action: 'erp__create_order', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const email = buildEmailExport({ inbox: [INBOX_C1] });
    const result = await verifyReport('<sv-case start="email:m1" goal="ticket:g1" steps=""></sv-case><sv-metric kind="completed" cases="C1 C2"></sv-metric>', { archive, runExport: makeRunExport({ email }) });
    const out = renderReportHtml(result.html, result.elements);
    expect(out).toContain('sv-badge-warn');
    expect(out).toMatch(/1 of 2 requested/i);
    expect(out).toContain('<span class="sv-v">1</span>');
  });

  it('REFUSAL: with no known load time a case shows no duration value', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({ id: 'g1', action: 'email__send_message', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const email = buildEmailExport({ simulation_load: null, inbox: [INBOX_C1] });
    const result = await verifyReport('<sv-case start="email:m1" goal="ticket:g1" steps=""></sv-case>', { archive, runExport: makeRunExport({ email }) });
    const out = renderReportHtml(result.html, result.elements);
    expect(out).not.toContain('<span class="sv-k">duration_s</span>');
    expect(out).toMatch(/time the test data was loaded is unknown/);
  });

  it('escapes HTML in drawn values — intent text cannot inject markup', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({
      id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1',
      authorization: { authorizationId: 'authz-1', profileId: 'erp@0.1', intent: '<img src=x onerror=alert(1)>' },
    });
    const result = await verifyReport('<sv-mandate ticket="t1"></sv-mandate>', { archive, runExport: makeRunExport() });
    const out = renderReportHtml(result.html, result.elements);
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img');
  });

  it('a mandate\'s owner is never a did:key (RR3)', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({
      id: 't1', action: 'erp__create_quote', authorizationId: 'authz-owner',
      authorization: { authorizationId: 'authz-owner', profileId: 'sales@0.3', owners: ['did:key:zOwner9'] },
    });
    const result = await verifyReport('<sv-mandate ticket="t1"></sv-mandate>', { archive, runExport: makeRunExport() });
    const out = renderReportHtml(result.html, result.elements);
    expect(out).not.toContain('Owner9');
  });
});

describe('renderReportHtml — glossary (AI translation as a gloss)', () => {
  const GLOSSARY =
    '<sv-glossary lang="de">' +
    '<sv-term key="action">Aktion</sv-term><sv-term key="erp__create_quote">Angebot erstellt</sv-term>' +
    '<sv-term key="value_max">Maximalwert</sv-term><sv-term key="review">Prüfpflichtig</sv-term>' +
    '<sv-term key="3200">32.000 €</sv-term><sv-term key="s1">Beleg</sv-term><sv-term key="C1">Fall eins</sv-term>' +
    '<sv-term key="2026-10-01">gestern</sv-term><sv-term key="a@example.com">Kunde</sv-term><sv-term key="nothing_here">x</sv-term>' +
    '</sv-glossary>';

  it('gloss markup is present only when switched on (default off)', async () => {
    const { result } = await fullScenario(ALL_KINDS_HTML + GLOSSARY);
    const off = renderReportHtml(result.html, result.elements);
    expect(off).not.toContain('<ruby');
    expect(off).not.toContain('Angebot erstellt');
    const on = renderReportHtml(result.html, result.elements, { gloss: 'on' });
    expect(on).toContain('<ruby class="sv-gloss"><span class="sv-v">erp__create_quote</span><rt>Angebot erstellt</rt></ruby>');
    expect(on).toContain('<ruby class="sv-gloss"><span class="sv-k">action</span><rt>Aktion</rt></ruby>');
    expect(on).toContain('<ruby class="sv-gloss"><span class="sv-k">value_max</span><rt>Maximalwert</rt></ruby>');
    expect(on).toContain('<ruby class="sv-gloss"><span class="sv-v">review</span><rt>Prüfpflichtig</rt></ruby>');
    expect(on).toContain('= translation by the AI, not verified');
    expect(off).not.toContain('= translation by the AI');
  });

  it('REFUSAL: glosses on numbers, timestamps, ids, addresses and unknown keys are rejected', async () => {
    const { result } = await fullScenario(ALL_KINDS_HTML + GLOSSARY);
    const on = renderReportHtml(result.html, result.elements, { gloss: 'on' });
    for (const bad of ['32.000 €', 'Beleg', 'Fall eins', 'gestern', 'Kunde']) expect(on).not.toContain(bad);
    const usage = glossaryUsage(result.html, result.elements)!;
    expect(usage.applied.sort()).toEqual(['action', 'erp__create_quote', 'review', 'value_max']);
    expect(usage.rejected.map(r => r.key).sort()).toEqual(['2026-10-01', '3200', 'C1', 'a@example.com', 'nothing_here', 's1']);
  });

  it('the raw value always stays visible under the gloss', async () => {
    const { result } = await fullScenario(ALL_KINDS_HTML + GLOSSARY);
    const on = renderReportHtml(result.html, result.elements, { gloss: 'on' });
    expect(on).toMatch(/<ruby class="sv-gloss"><span class="sv-v">erp__create_quote<\/span>/);
    expect(DRAWN_ELEMENT_STYLES).not.toMatch(/ruby\.sv-gloss\s*>\s*span[^}]*display:\s*none/);
  });

  it('toggle mode carries the gloss markup hidden by default (the export\'s CSS switch shows it)', async () => {
    const { result } = await fullScenario(ALL_KINDS_HTML + GLOSSARY);
    const t = renderReportHtml(result.html, result.elements, { gloss: 'toggle' });
    expect(t).toContain('class="sv-report sv-gloss-toggle-mode"');
    expect(t).toContain('<rt>Angebot erstellt</rt>');
    expect(DRAWN_ELEMENT_STYLES).toMatch(/\.sv-gloss-toggle-mode ruby\.sv-gloss rt \{ display:none; \}/);
  });

  it('the glossary never changes verification results', async () => {
    const a = await fullScenario(ALL_KINDS_HTML);
    const b = await fullScenario(ALL_KINDS_HTML + GLOSSARY);
    const statuses = (els: VerifiedElement[]) => els.map(e => `${e.id}:${e.status}`);
    expect(statuses(b.result.elements)).toEqual(statuses(a.result.elements));
  });
});

describe('label parity with the Reports page', () => {
  it('the UI legend outside the frame uses the same words as the drawn legend', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { VERIFIED_LEGEND_TEXT, AI_LEGEND_TEXT, GLOSS_LEGEND_TEXT } = await import('../../src/lib/report/render-report');
    const ui = readFileSync(resolve(__dirname, '../../../ui/src/pages/ReportsPage.tsx'), 'utf-8');
    expect(ui).toContain(`'${AI_ANALYSIS_LABEL}'`);
    expect(ui).toContain(`'${VERIFIED_LEGEND_TEXT}'`);
    expect(ui).toContain(`"${AI_LEGEND_TEXT}"`);
    expect(ui).toContain(`'${GLOSS_LEGEND_TEXT}'`);
  });
});

function collectTimestamps(elements: VerifiedElement[]): unknown[] {
  const out: unknown[] = [];
  const walk = (v: unknown, k?: string) => {
    if (Array.isArray(v)) { v.forEach(x => walk(x)); return; }
    if (v && typeof v === 'object') { for (const [kk, vv] of Object.entries(v)) walk(vv, kk); return; }
    if (k && /(^time$|At$|_at$|^timestamp$|Time$)/.test(k) && v !== undefined && v !== null) out.push(v);
  };
  for (const el of elements) walk(el.data);
  return out;
}
