/**
 * "Export with proof" — the producer side (work-plan R6). Real signed
 * tickets/attestations via `buildScenario()` (same fixture `verify-report.test.ts`
 * uses), real `verifyReport()`, real hap-core crypto for the round-trip check
 * — nothing about the cryptography is mocked here.
 */
import { describe, it, expect } from 'vitest';
import { verifyReceiptSignature, type ReceiptPayload } from '@hap/core';
import { verifyReport } from '../../src/lib/report/verify-report';
import { renderReportHtml, AI_ANALYSIS_LABEL, GLOSS_LEGEND_TEXT } from '../../src/lib/report/render-report';
import { formatTimestamp } from '../../src/lib/report/format';
import { buildExportBundle, buildExportDocument, suggestedFilename } from '../../src/lib/report/export-report';
import { extractProofBundle, runVerifyReportCli } from '../../bin/report-verify-cli';
import { verifyExportBundle } from '../../src/lib/report/verify-export';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildScenario, AS_URL } from './fixtures/scenario';
import type { RunConnectorExport, ExportSystem } from '../../src/lib/report/types';
import type { StoredReport } from '../../src/lib/report/report-store';

function noExports(): RunConnectorExport {
  return async (_system: ExportSystem) => ({ inbox: [], sent: [], changes: [], refusals: [], quotes: [], orders: [], contacts: [], deals: [], tasks: [], activities: [] });
}

async function buildStored(html: string, archive: ReturnType<typeof buildScenario>['archive']): Promise<StoredReport> {
  const result = await verifyReport(html, { archive, runExport: noExports() });
  const now = Math.floor(Date.now() / 1000);
  return { html: result.html, savedAt: now, checkedAt: now, result };
}

describe('buildExportBundle', () => {
  it('includes every referenced ticket and every ticket in the coverage period — bare, when no sv-mandate places their mandate (RR5)', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({
      id: 't-ref', action: 'erp__create_quote', authorizationId: 'authz-ref', timestamp: 1_800_000_000,
      authorization: { authorizationId: 'authz-ref', profileId: 'test-profile', boundsHash: 'bh-ref', intent: 'Quote up to 1000' },
    });
    addTicket({
      id: 't-unreferenced', action: 'erp__create_quote', authorizationId: 'authz-other', timestamp: 1_800_000_100,
      authorization: { authorizationId: 'authz-other', profileId: 'test-profile', boundsHash: 'bh-other' },
    });

    const html = '<sv-ai><h1>Report</h1></sv-ai><sv-ticket ref="t-ref"></sv-ticket>';
    const stored = await buildStored(html, archive);

    const bundle = buildExportBundle({
      stored, archive, gatewayVersion: '0.0.0-test',
      authorityServer: { url: AS_URL, publicKeyHex: kp.publicKeyHex },
    });

    const ids = bundle.tickets.map(t => (t as { id: string }).id);
    expect(ids).toContain('t-ref');
    expect(ids).toContain('t-unreferenced'); // in coverage period, not referenced
    expect(bundle.authorizations).toEqual({}); // no sv-mandate placed → no mandate data
    expect(bundle.report.html).toBe(stored.html);
    expect(bundle.authorityServer).toEqual({ url: AS_URL, publicKeyHex: kp.publicKeyHex });
  });

  it('never fabricates a ticket not in the archive', async () => {
    const { archive, kp } = buildScenario();
    const html = '<sv-ticket ref="ghost"></sv-ticket>';
    const stored = await buildStored(html, archive);
    const bundle = buildExportBundle({ stored, archive, gatewayVersion: 'test', authorityServer: { url: AS_URL, publicKeyHex: kp.publicKeyHex } });
    expect(bundle.tickets).toEqual([]);
  });
});

describe('buildExportDocument — round trip + safety', () => {
  async function buildRealExport(opts: { glossary?: boolean } = {}) {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({
      id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000,
      authorization: { authorizationId: 'authz-1', profileId: 'test-profile', boundsHash: 'bh-1', intent: 'Quote up to 1000' },
    });
    const html = '<sv-ai><h1>Three-week test</h1></sv-ai><sv-ticket ref="t1" variant="full"></sv-ticket><sv-mandate ticket="t1"></sv-mandate>' +
      (opts.glossary ? '<sv-glossary lang="de"><sv-term key="action">Aktion</sv-term></sv-glossary>' : '');
    const stored = await buildStored(html, archive);
    const bundle = buildExportBundle({ stored, archive, gatewayVersion: '0.0.0-test', authorityServer: { url: AS_URL, publicKeyHex: kp.publicKeyHex } });
    // The same call the real export route makes (http.ts).
    const renderedHtml = renderReportHtml(stored.result.html, stored.result.elements, { gloss: 'toggle' });
    const doc = buildExportDocument({ bundle, renderedHtml });
    return { doc, bundle, kp };
  }

  it('carries the "AI analysis — not verified" legend in the gateway header AND above the AI\'s content (review SR5)', async () => {
    const { doc } = await buildRealExport();
    const header = doc.slice(doc.indexOf('<div class="sv-export-header">'), doc.indexOf('<div class="sv-export-layout">'));
    expect(header).toContain('class="sv-export-legend"');
    expect(header).toContain(AI_ANALYSIS_LABEL);
    const main = doc.slice(doc.indexOf('<div class="sv-export-main">'));
    expect(main.indexOf('class="sv-legend"')).toBeGreaterThan(-1);
    expect(main.indexOf('class="sv-legend"')).toBeLessThan(main.indexOf('Three-week test'));
    // ...and the AI's content itself sits in a labelled grey frame.
    expect(main).toMatch(new RegExp(`<span class="sv-ai-label">${AI_ANALYSIS_LABEL}</span><div class="sv-ai-block"><div class="sv-ai-content"><h1>Three-week test</h1>`));
  });

  it('the public check link is a plain new-tab link in the file (no sandbox, no in-app route)', async () => {
    const { doc } = await buildRealExport();
    expect(doc).toContain(`<a href="${AS_URL}/r/t1" target="_blank" rel="noopener noreferrer">Check on suveren.ai ↗</a>`);
    expect(doc).not.toMatch(/target="_top"/);
  });

  it('embeds a proof bundle that round-trips and verifies independently with hap-core', async () => {
    const { doc, bundle } = await buildRealExport();
    const extracted = extractProofBundle(doc);
    expect(extracted.tickets.length).toBe(1);
    expect(extracted.authorityServer.publicKeyHex).toBe(bundle.authorityServer.publicKeyHex);

    // Independently of ANY verifier code this change set wrote — the exact
    // hap-core call a holder would make against a live Authority Server.
    await expect(
      verifyReceiptSignature(extracted.tickets[0] as unknown as ReceiptPayload, extracted.authorityServer.publicKeyHex),
    ).resolves.toBeUndefined();
  });

  it('produces a document with no <script> outside the JSON data block, no on* handlers, no URL except the /r/ check link (no dead in-app links)', async () => {
    const { doc } = await buildRealExport();

    const scriptOpens = doc.match(/<script\b[^>]*>/gi) ?? [];
    expect(scriptOpens.length).toBe(1);
    expect(scriptOpens[0]).toMatch(/id="suveren-proof"/);
    expect(scriptOpens[0]).toMatch(/type="application\/json"/);

    expect(doc).not.toMatch(/\son\w+\s*=/i);

    const urls = [...doc.matchAll(/(?:href|src)="([^"]+)"/gi)].map(m => m[1]);
    for (const url of urls) {
      // #fragments, inline images, and the one PERMITTED external URL class
      // (the public /r/<id> check link) are expected. The in-app
      // /reports?element=... "Details" link must NOT appear at all in an
      // export (polish 2026-10-06, fix 1) — it is a dead link once the file
      // is opened on its own.
      const allowed =
        url.startsWith('#') ||
        url.startsWith('data:image/') ||
        new RegExp(`^${AS_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/r/[^"]*$`).test(url);
      expect(allowed, `unexpected URL in export: ${url}`).toBe(true);
    }
    // The one external link class the file DOES carry on purpose.
    expect(doc).toMatch(new RegExp(`${AS_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/r/t1`));
  });

  it('REFUSAL (fix 1): never shows "Details" and never leaves an orphaned separator', async () => {
    const { doc } = await buildRealExport();
    expect(doc).not.toMatch(/>Details</);
    expect(doc).not.toMatch(/\/reports\?element=/);
    // The ticket card's link row collapses to just the check link, with no
    // trailing/leading " · " where "Details" used to sit.
    expect(doc).not.toMatch(/Check on suveren\.ai ↗<\/a>\s*·/);
    expect(doc).not.toMatch(/·\s*<\/span>/);
  });

  it('fix 2: exported/checked timestamps share one local format and the zone is stated once', async () => {
    const { doc, bundle } = await buildRealExport();
    // The header keeps its plain "D Mon, HH:MM" shape — never an ISO mix.
    const header = doc.slice(doc.indexOf('<div class="sv-export-header">'), doc.indexOf('<div class="sv-export-layout">'));
    expect(header).not.toMatch(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/);
    expect(header).toMatch(/exported \d{1,2} \w{3} \d{4}, \d{2}:\d{2}/);
    expect(header).toMatch(/checked \d{1,2} \w{3}, \d{2}:\d{2}/);
    expect((header.match(/UTC[+-]\d/g) ?? []).length).toBe(1);
    // Inside the verified boxes a signed timestamp is the one deterministic
    // full format (two-tag rule, RR6), never the raw unix seconds.
    expect(doc).toContain(formatTimestamp(1_800_000_000));
    const visible = doc.replace(/<script type="application\/json" id="suveren-proof">[\s\S]*?<\/script>/, '');
    expect(visible).not.toContain('1800000000');
    void bundle;
  });

  it('fix 3: the visible coverage panel never shows the raw connector error, only a plain sentence — the raw error still lives in the embedded JSON', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const html = '<sv-ticket ref="t1"></sv-ticket>';
    const result = await verifyReport(html, {
      archive,
      runExport: async () => { throw new Error('spawn email-mcp ENOENT'); },
    });
    const now = Math.floor(Date.now() / 1000);
    const stored: StoredReport = { html: result.html, savedAt: now, checkedAt: now, result };
    const bundle = buildExportBundle({ stored, archive, gatewayVersion: 'test', authorityServer: { url: AS_URL, publicKeyHex: kp.publicKeyHex } });
    const renderedHtml = renderReportHtml(stored.result.html, stored.result.elements);
    const doc = buildExportDocument({ bundle, renderedHtml });

    expect(bundle.coverage.emailExportError).toMatch(/ENOENT/); // still in the data
    const visibleHtml = doc.replace(/<script type="application\/json" id="suveren-proof">[\s\S]*?<\/script>/, '');
    expect(visibleHtml).not.toMatch(/ENOENT/);
    expect(visibleHtml).not.toMatch(/spawn email-mcp/);
    expect(visibleHtml).toMatch(/the email simulator could not be read/i);
    expect(visibleHtml).toMatch(/all saved tickets were counted/i);
  });

  it('a report with a glossary gets a CSS-only translation switch (off by default) and the gloss legend; still no script', async () => {
    const { doc } = await buildRealExport({ glossary: true });
    expect(doc).toContain('<input type="checkbox" id="sv-gloss-toggle" class="sv-toggle-input">');
    expect(doc).not.toMatch(/<input[^>]*checked/);
    expect(doc).toContain('Übersetzung anzeigen / show translation');
    expect(doc).toContain(GLOSS_LEGEND_TEXT);
    expect(doc).toContain('#sv-gloss-toggle:checked ~ .sv-export-layout .sv-gloss-toggle-mode ruby.sv-gloss rt { display:ruby-text; }');
    expect(doc).toContain('<ruby class="sv-gloss"><span class="sv-k">action</span><rt>Aktion</rt></ruby>');
    // The toggle input precedes the layout as a sibling (the selector needs it).
    expect(doc.indexOf('id="sv-gloss-toggle"')).toBeLessThan(doc.indexOf('<div class="sv-export-layout">'));
    const scriptOpens = doc.match(/<script\b[^>]*>/gi) ?? [];
    expect(scriptOpens).toHaveLength(1);
    expect(scriptOpens[0]).toMatch(/type="application\/json"/);
  });

  it('without a glossary there is no switch and no gloss markup', async () => {
    const { doc } = await buildRealExport();
    expect(doc).not.toContain('sv-gloss-toggle"');
    expect(doc).not.toContain('<ruby');
  });

  it('the file carries a CSP that runs nothing and loads nothing', async () => {
    const { doc } = await buildRealExport();
    const head = doc.slice(0, doc.indexOf('</head>'));
    expect(head).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`);
  });

  it('a full sv-ticket places its mandate, so the mandate travels in the bundle', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({
      id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000,
      authorization: { authorizationId: 'authz-1', profileId: 'test-profile', boundsHash: 'bh-1', bounds: { value_max: 1000 } },
    });
    const full = await buildStored('<sv-ticket ref="t1" variant="full"></sv-ticket>', archive);
    const compact = await buildStored('<sv-ticket ref="t1" variant="compact"></sv-ticket>', archive);
    const as = { url: AS_URL, publicKeyHex: kp.publicKeyHex };
    expect(Object.keys(buildExportBundle({ stored: full, archive, gatewayVersion: 't', authorityServer: as }).authorizations)).toEqual(['authz-1']);
    expect(buildExportBundle({ stored: compact, archive, gatewayVersion: 't', authorityServer: as }).authorizations).toEqual({});
  });

  it('filename is suveren-report-<date>.html', async () => {
    const { bundle } = await buildRealExport();
    expect(suggestedFilename(bundle)).toMatch(/^suveren-report-\d{4}-\d{2}-\d{2}\.html$/);
  });

  it('escapes </script> occurring inside bundle data so it cannot break out of the data block', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({
      id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000,
      authorization: {
        authorizationId: 'authz-1', profileId: 'test-profile', boundsHash: 'bh-1',
        // Mandate intent text is plain stored text, never run through
        // sanitize-html (that only ever sees the AI's report html) — exactly
        // the kind of field that could carry a breakout attempt.
        intent: '</script><script>alert(1)</script>',
      },
    });
    const html = '<sv-mandate ticket="t1"></sv-mandate>';
    const stored = await buildStored(html, archive);
    const bundle = buildExportBundle({ stored, archive, gatewayVersion: 'test', authorityServer: { url: AS_URL, publicKeyHex: kp.publicKeyHex } });
    const renderedHtml = renderReportHtml(stored.result.html, stored.result.elements);
    const doc = buildExportDocument({ bundle, renderedHtml });

    // Exactly one genuine closing tag may exist in the whole document: the
    // proof block's own. Any more means the attacker's payload escaped it.
    const closings = doc.match(/<\/script>/gi) ?? [];
    expect(closings.length).toBe(1);
  });
});


// ─── RR5 — the proof follows the report ─────────────────────────────────────

describe('RR5 — the proof follows the report: mandate data only for a placed sv-mandate', () => {
  const SHOWN_INTENT = 'Quote known customers only, up to 1 000 EUR.';
  const HIDDEN_INTENT = 'Credit policy: never more than 5 % discount for A-customers.';

  async function buildSlimExport() {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({
      id: 't-shown', action: 'erp__create_quote', authorizationId: 'authz-shown', timestamp: 1_800_000_000,
      authorization: { authorizationId: 'authz-shown', profileId: 'test-profile', boundsHash: 'bh-shown', intent: SHOWN_INTENT, bounds: { value_max: 1000 } },
    });
    addTicket({
      id: 't-bare', action: 'erp__send_quote', authorizationId: 'authz-hidden', timestamp: 1_800_000_100,
      authorization: { authorizationId: 'authz-hidden', profileId: 'test-profile', boundsHash: 'bh-hidden', intent: HIDDEN_INTENT, bounds: { discount_max: 5 } },
    });
    addTicket({ id: 't-coverage-only', action: 'erp__send_quote', authorizationId: 'authz-hidden', timestamp: 1_800_000_200 });
    const html = '<sv-ai><h1>Week</h1></sv-ai><sv-ticket ref="t-shown"></sv-ticket><sv-mandate ticket="t-shown"></sv-mandate><sv-ticket ref="t-bare"></sv-ticket>';
    const stored = await buildStored(html, archive);
    const bundle = buildExportBundle({ stored, archive, gatewayVersion: 'test', authorityServer: { url: AS_URL, publicKeyHex: kp.publicKeyHex } });
    const doc = buildExportDocument({ bundle, renderedHtml: renderReportHtml(stored.result.html, stored.result.elements) });
    return { bundle, doc, kp, stored };
  }

  it('an intent the report does not show is nowhere in the exported file; a placed sv-mandate\'s intent is', async () => {
    const { bundle, doc } = await buildSlimExport();
    expect(doc).not.toContain(HIDDEN_INTENT);
    expect(doc).not.toContain('discount_max');
    // The mandate's id is a SIGNED field of each bare ticket, so it stays in the
    // raw ticket (the signature must verify) — but nowhere outside the proof
    // data block, and no mandate record under it.
    const visible = doc.replace(/<script type="application\/json" id="suveren-proof">[\s\S]*?<\/script>/, '');
    expect(visible).not.toContain('authz-hidden');
    expect(doc).toContain(SHOWN_INTENT);
    expect(Object.keys(bundle.authorizations)).toEqual(['authz-shown']);
    // Every ticket still travels, bare: referenced, and in coverage.
    expect(bundle.tickets.map(t => (t as { id: string }).id).sort()).toEqual(['t-bare', 't-coverage-only', 't-shown']);
  });

  it('the bare tickets still verify on their own — their signature covers the ticket itself', async () => {
    const { bundle } = await buildSlimExport();
    for (const t of bundle.tickets) {
      await expect(verifyReceiptSignature(t as unknown as ReceiptPayload, bundle.authorityServer.publicKeyHex)).resolves.toBeUndefined();
    }
  });

  it('the offline checker passes the slim file: exit 2 without a key, 0 with --key, all signatures valid', async () => {
    const { doc, kp } = await buildSlimExport();
    const dir = mkdtempSync(join(tmpdir(), 'suveren-rr5-'));
    const file = join(dir, 'report.html');
    writeFileSync(file, doc);
    const log = console.log;
    console.log = () => {};
    try {
      expect(await runVerifyReportCli([file])).toBe(2);
      expect(await runVerifyReportCli([file, '--key', kp.publicKeyHex])).toBe(0);
    } finally {
      console.log = log;
      rmSync(dir, { recursive: true, force: true });
    }
    const result = await verifyExportBundle(extractProofBundle(doc), { documentHtml: doc, expectedKeyHex: kp.publicKeyHex });
    expect(result.allValid).toBe(true);
    expect(result.tickets.every(t => t.signatureValid)).toBe(true);
  });

  it('REFUSAL: exit 1 when the mandate data of an sv-mandate presented as verified is stripped from the file', async () => {
    const { doc, kp, bundle } = await buildSlimExport();
    const stripped = { ...bundle, authorizations: {} };
    const tampered = doc.replace(
      /(<script type="application\/json" id="suveren-proof">)[\s\S]*?(<\/script>)/,
      (_m, open, close) => `${open}${JSON.stringify(stripped).replace(/<\//g, '<\\/')}${close}`,
    );
    expect(tampered).not.toBe(doc);
    const dir = mkdtempSync(join(tmpdir(), 'suveren-rr5-'));
    const file = join(dir, 'report.html');
    writeFileSync(file, tampered);
    const log = console.log;
    console.log = () => {};
    try {
      expect(await runVerifyReportCli([file, '--key', kp.publicKeyHex])).toBe(1);
    } finally {
      console.log = log;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
