/**
 * "Export with proof" — the producer side (work-plan R6). Real signed
 * tickets/attestations via `buildScenario()` (same fixture `verify-report.test.ts`
 * uses), real `verifyReport()`, real hap-core crypto for the round-trip check
 * — nothing about the cryptography is mocked here.
 */
import { describe, it, expect } from 'vitest';
import { verifyReceiptSignature, type ReceiptPayload } from '@hap/core';
import { verifyReport } from '../../src/lib/report/verify-report';
import { renderReportHtml } from '../../src/lib/report/render-report';
import { buildExportBundle, buildExportDocument, suggestedFilename } from '../../src/lib/report/export-report';
import { extractProofBundle } from '../../bin/report-verify-cli';
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
  it('includes every referenced ticket and every ticket in the coverage period, with their authorizations', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({
      id: 't-ref', action: 'erp__create_quote', authorizationId: 'authz-ref', timestamp: 1_800_000_000,
      authorization: { authorizationId: 'authz-ref', profileId: 'test-profile', boundsHash: 'bh-ref', intent: 'Quote up to 1000' },
    });
    addTicket({
      id: 't-unreferenced', action: 'erp__create_quote', authorizationId: 'authz-other', timestamp: 1_800_000_100,
      authorization: { authorizationId: 'authz-other', profileId: 'test-profile', boundsHash: 'bh-other' },
    });

    const html = '<h1>Report</h1><sv-ticket ref="t-ref"></sv-ticket>';
    const stored = await buildStored(html, archive);

    const bundle = buildExportBundle({
      stored, archive, gatewayVersion: '0.0.0-test',
      authorityServer: { url: AS_URL, publicKeyHex: kp.publicKeyHex },
    });

    const ids = bundle.tickets.map(t => (t as { id: string }).id);
    expect(ids).toContain('t-ref');
    expect(ids).toContain('t-unreferenced'); // in coverage period, not referenced
    expect(Object.keys(bundle.authorizations)).toEqual(expect.arrayContaining(['authz-ref', 'authz-other']));
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
  async function buildRealExport() {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({
      id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000,
      authorization: { authorizationId: 'authz-1', profileId: 'test-profile', boundsHash: 'bh-1', intent: 'Quote up to 1000' },
    });
    const html = '<h1>Three-week test</h1><sv-ticket ref="t1"></sv-ticket><sv-mandate ticket="t1"></sv-mandate>';
    const stored = await buildStored(html, archive);
    const bundle = buildExportBundle({ stored, archive, gatewayVersion: '0.0.0-test', authorityServer: { url: AS_URL, publicKeyHex: kp.publicKeyHex } });
    // interactive=false — the real export route's own call (http.ts).
    const renderedHtml = renderReportHtml(stored.result.html, stored.result.elements, false);
    const doc = buildExportDocument({ bundle, renderedHtml });
    return { doc, bundle, kp };
  }

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
    // Same "D Mon, HH:MM" shape the gateway-drawn ticket card uses (format.ts's
    // formatDateTime) — never the old "...T...Z"/"21:43 UTC" ISO mix.
    expect(doc).not.toMatch(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/);
    expect(doc).toMatch(/exported \d{1,2} \w{3} \d{4}, \d{2}:\d{2}/);
    expect(doc).toMatch(/checked \d{1,2} \w{3}, \d{2}:\d{2}/);
    // The zone is named exactly once, in the header — never repeated per line.
    const tzMentions = doc.match(/UTC[+-]\d/g) ?? [];
    expect(tzMentions.length).toBe(1);
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
    const renderedHtml = renderReportHtml(stored.result.html, stored.result.elements, false);
    const doc = buildExportDocument({ bundle, renderedHtml });

    expect(bundle.coverage.emailExportError).toMatch(/ENOENT/); // still in the data
    const visibleHtml = doc.replace(/<script type="application\/json" id="suveren-proof">[\s\S]*?<\/script>/, '');
    expect(visibleHtml).not.toMatch(/ENOENT/);
    expect(visibleHtml).not.toMatch(/spawn email-mcp/);
    expect(visibleHtml).toMatch(/the email simulator could not be read/i);
    expect(visibleHtml).toMatch(/all saved tickets were counted/i);
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
    const renderedHtml = renderReportHtml(stored.result.html, stored.result.elements, false);
    const doc = buildExportDocument({ bundle, renderedHtml });

    // Exactly one genuine closing tag may exist in the whole document: the
    // proof block's own. Any more means the attacker's payload escaped it.
    const closings = doc.match(/<\/script>/gi) ?? [];
    expect(closings.length).toBe(1);
  });
});
