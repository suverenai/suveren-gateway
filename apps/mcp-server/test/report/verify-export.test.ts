/**
 * Offline export verifier (work-plan R6) — real signed tickets/attestations
 * via `buildScenario()`, real hap-core crypto throughout (including for the
 * tamper cases: a re-signed ticket/attestation is a REAL valid signature,
 * just under the wrong key — never a stubbed "invalid" result).
 *
 * Per engineering.md "test refusals harder than successes": most cases here
 * are a real export broken one specific way, checked to actually be reported,
 * not just a happy path.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { decodeAttestationBlob, encodeAttestationBlob } from '@hap/core';
import { verifyReport } from '../../src/lib/report/verify-report';
import { buildExportBundle, buildExportDocument } from '../../src/lib/report/export-report';
import { renderReportHtml } from '../../src/lib/report/render-report';
import { verifyExportBundle, collectPresentedStates } from '../../src/lib/report/verify-export';
import { runVerifyReportCli } from '../../bin/report-verify-cli';
import { buildScenario, AS_URL, signAttestationPayload } from './fixtures/scenario';
import { testReceiptKeypair, signTestReceipt, type TestReceiptKeypair } from '../helpers/real-receipt';
import type { RunConnectorExport, ExportSystem } from '../../src/lib/report/types';
import type { ExportBundle } from '../../src/lib/report/export-types';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function noExports(): RunConnectorExport {
  return async (_s: ExportSystem) => ({ inbox: [], sent: [], changes: [], refusals: [], quotes: [], orders: [], contacts: [], deals: [], tasks: [], activities: [] });
}

async function buildRealBundle(html: string, archive: ReturnType<typeof buildScenario>['archive'], kp: TestReceiptKeypair): Promise<ExportBundle> {
  const result = await verifyReport(html, { archive, runExport: noExports() });
  const now = Math.floor(Date.now() / 1000);
  const stored = { html: result.html, savedAt: now, checkedAt: now, result };
  return buildExportBundle({ stored, archive, gatewayVersion: 'test', authorityServer: { url: AS_URL, publicKeyHex: kp.publicKeyHex } });
}

/** A REAL export file exactly as the gateway's export route builds it:
 *  gateway-drawn elements (`renderReportHtml(...)`) + embedded bundle. */
async function buildRealExport(html: string, archive: ReturnType<typeof buildScenario>['archive'], kp: TestReceiptKeypair): Promise<{ bundle: ExportBundle; doc: string }> {
  const result = await verifyReport(html, { archive, runExport: noExports() });
  const now = Math.floor(Date.now() / 1000);
  const stored = { html: result.html, savedAt: now, checkedAt: now, result };
  const bundle = buildExportBundle({ stored, archive, gatewayVersion: 'test', authorityServer: { url: AS_URL, publicKeyHex: kp.publicKeyHex } });
  const doc = buildExportDocument({ bundle, renderedHtml: renderReportHtml(result.html, result.elements) });
  return { bundle, doc };
}

/** Re-signs every ticket and every attestation blob in `bundle` with `newKp`
 *  — a REAL, independently-valid signature, just under a different key, so
 *  the "swap the key" tamper test exercises genuine Ed25519 verification on
 *  both sides, not a stubbed failure. */
function resignUnderDifferentKey(bundle: ExportBundle, newKp: TestReceiptKeypair): void {
  bundle.tickets = bundle.tickets.map(t => {
    const { signature: _sig, ...rest } = t as Record<string, unknown>;
    return signTestReceipt(rest, newKp.privateKey);
  });
  for (const auth of Object.values(bundle.authorizations)) {
    auth.attestations = auth.attestations.map(att => {
      const decoded = decodeAttestationBlob(att.blob);
      const resigned = signAttestationPayload(decoded.payload, newKp);
      return { ...att, blob: encodeAttestationBlob(resigned) };
    });
  }
  bundle.authorityServer = { ...bundle.authorityServer, publicKeyHex: newKp.publicKeyHex };
}

describe('verifyExportBundle', () => {
  it('a real, untampered export verifies: all signatures valid, key unconfirmed with no flags', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({
      id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000,
      authorization: { authorizationId: 'authz-1', profileId: 'test-profile', boundsHash: 'bh-1' },
    });
    const bundle = await buildRealBundle('<sv-ticket ref="t1"></sv-ticket><sv-mandate ticket="t1"></sv-mandate>', archive, kp);

    const result = await verifyExportBundle(bundle);
    expect(result.allValid).toBe(true);
    expect(result.tickets.every(t => t.signatureValid)).toBe(true);
    expect(result.authorizations.every(a => a.attestationValid)).toBe(true);
    expect(result.keyConfirmation).toEqual({ state: 'unconfirmed' });
  });

  it('--key confirms the embedded key when it matches', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const bundle = await buildRealBundle('<sv-ticket ref="t1"></sv-ticket>', archive, kp);

    const result = await verifyExportBundle(bundle, { expectedKeyHex: kp.publicKeyHex });
    expect(result.keyConfirmation).toEqual({ state: 'confirmed', source: 'provided' });
  });

  it('REFUSAL: --online key mismatch is reported, even though every signature is internally valid', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const bundle = await buildRealBundle('<sv-ticket ref="t1"></sv-ticket>', archive, kp);

    const impostor = testReceiptKeypair();
    const result = await verifyExportBundle(bundle, { onlineKeyHex: impostor.publicKeyHex });
    expect(result.allValid).toBe(true); // internally consistent
    expect(result.keyConfirmation.state).toBe('mismatch');
  });

  it('REFUSAL: a one-byte tamper to a ticket field invalidates its signature', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const bundle = await buildRealBundle('<sv-ticket ref="t1"></sv-ticket>', archive, kp);

    (bundle.tickets[0] as Record<string, unknown>).action = 'erp__create_quoteX';
    const result = await verifyExportBundle(bundle);
    expect(result.allValid).toBe(false);
    const t1 = result.tickets.find(t => t.ticketId === 't1')!;
    expect(t1.signatureValid).toBe(false);
  });

  it('REFUSAL: re-signing every ticket+attestation under a DIFFERENT key passes internal checks but fails --key against the real one', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({
      id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000,
      authorization: { authorizationId: 'authz-1', profileId: 'test-profile', boundsHash: 'bh-1' },
    });
    const bundle = await buildRealBundle('<sv-ticket ref="t1"></sv-ticket><sv-mandate ticket="t1"></sv-mandate>', archive, kp);

    const impostor = testReceiptKeypair();
    resignUnderDifferentKey(bundle, impostor);

    const internal = await verifyExportBundle(bundle);
    expect(internal.allValid).toBe(true); // every signature verifies against the (now impostor) embedded key

    const checked = await verifyExportBundle(bundle, { expectedKeyHex: kp.publicKeyHex });
    expect(checked.keyConfirmation.state).toBe('mismatch');
  });

  it('REFUSAL: with no drawn markup handed in, a reference missing from the bundle counts as presented-as-verified (strict) and fails', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const bundle = await buildRealBundle('<sv-ticket ref="t1"></sv-ticket><sv-ticket ref="ghost"></sv-ticket>', archive, kp);
    // "ghost" never existed in the archive, so buildExportBundle correctly
    // never included it — the embedded report html still names it (same real
    // shape `sample-report.html`'s fixture uses for its own "not verifiable" case).

    const result = await verifyExportBundle(bundle);
    expect(result.allValid).toBe(false);
    const ghost = result.tickets.find(t => t.ticketId === 'ghost')!;
    expect(ghost.present).toBe(false);
    expect(ghost.referenced).toBe(true);
    const el = result.elements.find(e => e.ticketIds.includes('ghost'))!;
    expect(el.presented).toBe('verified');
    expect(el.backed).toBe(false);
  });

  it('a missing reference the gateway DREW as not verifiable passes, and is listed as such', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const { bundle, doc } = await buildRealExport('<sv-ticket ref="t1"></sv-ticket><sv-ticket ref="ghost"></sv-ticket>', archive, kp);

    const result = await verifyExportBundle(bundle, { documentHtml: doc });
    expect(result.allValid).toBe(true);
    const ghostEl = result.elements.find(e => e.ticketIds.includes('ghost'))!;
    expect(ghostEl.presented).toBe('not-verifiable');
    expect(ghostEl.backed).toBe(false);
    const t1El = result.elements.find(e => e.ticketIds.includes('t1'))!;
    expect(t1El.presented).toBe('verified');
    expect(t1El.backed).toBe(true);
  });

  it('REFUSAL: a missing reference whose drawn CLASS was flipped to verified fails', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const { bundle, doc } = await buildRealExport('<sv-ticket ref="t1"></sv-ticket><sv-ticket ref="ghost"></sv-ticket>', archive, kp);
    const tampered = doc.replace('sv-el sv-el-unverifiable', 'sv-el sv-el-verified');
    expect(tampered).not.toBe(doc);

    const result = await verifyExportBundle(bundle, { documentHtml: tampered });
    expect(result.allValid).toBe(false);
    expect(result.elements.find(e => e.ticketIds.includes('ghost'))!.presented).toBe('verified');
  });

  it('REFUSAL: a missing reference whose drawn BADGE was flipped to verified fails', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const { bundle, doc } = await buildRealExport('<sv-ticket ref="t1"></sv-ticket><sv-ticket ref="ghost"></sv-ticket>', archive, kp);
    const tampered = doc.replace('sv-badge sv-badge-bad', 'sv-badge sv-badge-ok');
    expect(tampered).not.toBe(doc);

    const result = await verifyExportBundle(bundle, { documentHtml: tampered });
    expect(result.allValid).toBe(false);
  });

  it('REFUSAL: a missing reference whose drawn element was removed entirely fails (no drawn node = strict)', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const { bundle, doc } = await buildRealExport('<sv-ticket ref="t1"></sv-ticket><sv-ticket ref="ghost"></sv-ticket>', archive, kp);
    const tampered = doc.replace(/data-sv-id="sv-ticket-1"/, 'data-sv-id="sv-ticket-9"');
    expect(tampered).not.toBe(doc);

    const result = await verifyExportBundle(bundle, { documentHtml: tampered });
    expect(result.allValid).toBe(false);
  });

  it('REFUSAL: a flagged reference does not excuse an invalid signature on a bundled ticket', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const { bundle, doc } = await buildRealExport('<sv-ticket ref="t1"></sv-ticket><sv-ticket ref="ghost"></sv-ticket>', archive, kp);
    (bundle.tickets[0] as Record<string, unknown>).action = 'tampered';

    const result = await verifyExportBundle(bundle, { documentHtml: doc });
    expect(result.allValid).toBe(false);
  });

  it('a downgrade is allowed: a backed reference drawn as not verifiable still passes', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const { bundle, doc } = await buildRealExport('<sv-ticket ref="t1"></sv-ticket>', archive, kp);
    const downgraded = doc
      .replace('sv-el sv-el-verified', 'sv-el sv-el-unverifiable')
      .replace('sv-badge sv-badge-ok', 'sv-badge sv-badge-bad');

    const result = await verifyExportBundle(bundle, { documentHtml: downgraded });
    expect(result.allValid).toBe(true);
    expect(result.elements[0].presented).toBe('not-verifiable');
  });

  it('REFUSAL: a mandate element shown as verified whose mandate is missing from the bundle fails', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({
      id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000,
      authorization: { authorizationId: 'authz-1', profileId: 'test-profile', boundsHash: 'bh-1' },
    });
    const { bundle, doc } = await buildRealExport('<sv-mandate ticket="t1"></sv-mandate>', archive, kp);
    expect(collectPresentedStates(doc).get('sv-mandate-0')).toBe('verified');
    delete bundle.authorizations['authz-1'];

    const result = await verifyExportBundle(bundle, { documentHtml: doc });
    expect(result.allValid).toBe(false);
    expect(result.elements[0].error).toMatch(/mandate/);
  });

  it('collectPresentedStates: a decoy flagged node with the same id as a verified one stays verified (strict)', () => {
    const doc =
      '<div class="sv-el sv-el-verified" data-sv-id="sv-ticket-0"><span class="sv-badge sv-badge-ok">ok</span></div>' +
      '<div class="sv-el sv-el-unverifiable" data-sv-id="sv-ticket-0"><span class="sv-badge sv-badge-bad">x</span></div>' +
      '<div class="sv-el sv-el-unverifiable" data-sv-id="sv-ticket-1"><div><br><span class="sv-badge sv-badge-bad">x</span></div></div>' +
      '<div class="sv-el sv-el-unverifiable" data-sv-id="sv-ticket-2"></div>';
    const states = collectPresentedStates(doc);
    expect(states.get('sv-ticket-0')).toBe('verified');
    expect(states.get('sv-ticket-1')).toBe('not-verifiable');
    expect(states.get('sv-ticket-2')).toBe('verified'); // no badge — strict
  });

  it('REFUSAL: a tampered authorization boundsHash is reported', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({
      id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000, extra: { boundsHash: 'bh-1' },
      authorization: { authorizationId: 'authz-1', profileId: 'test-profile', boundsHash: 'bh-1' },
    });
    const bundle = await buildRealBundle('<sv-mandate ticket="t1"></sv-mandate>', archive, kp);
    bundle.authorizations['authz-1'].boundsHash = 'bh-tampered';

    const result = await verifyExportBundle(bundle);
    const auth = result.authorizations.find(a => a.authorizationId === 'authz-1')!;
    expect(auth.boundsHashMatches).toBe(false);
    expect(result.allValid).toBe(false);
  });
});

describe('runVerifyReportCli — exit codes', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function writeExportFile(bundle: ExportBundle): string {
    const dir = mkdtempSync(join(tmpdir(), 'suveren-verify-report-cli-'));
    dirs.push(dir);
    const file = join(dir, 'report.html');
    const json = JSON.stringify(bundle).replace(/<\//g, '<\\/');
    writeFileSync(file, `<!doctype html><html><body><p>report</p><script type="application/json" id="suveren-proof">${json}</script></body></html>`);
    return file;
  }

  it('exit 2: everything valid, but no --key/--online given', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const bundle = await buildRealBundle('<sv-ticket ref="t1"></sv-ticket>', archive, kp);
    const file = writeExportFile(bundle);

    const code = await runVerifyReportCli([file]);
    expect(code).toBe(2);
  });

  it('exit 0: everything valid AND --key matches', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const bundle = await buildRealBundle('<sv-ticket ref="t1"></sv-ticket>', archive, kp);
    const file = writeExportFile(bundle);

    const code = await runVerifyReportCli([file, '--key', kp.publicKeyHex]);
    expect(code).toBe(0);
  });

  it('REFUSAL: exit 1 — a tampered ticket signature is invalid', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const bundle = await buildRealBundle('<sv-ticket ref="t1"></sv-ticket>', archive, kp);
    (bundle.tickets[0] as Record<string, unknown>).action = 'tampered';
    const file = writeExportFile(bundle);

    const code = await runVerifyReportCli([file]);
    expect(code).toBe(1);
  });

  it('REFUSAL: exit 1 — --key given but does not match the embedded key', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const bundle = await buildRealBundle('<sv-ticket ref="t1"></sv-ticket>', archive, kp);
    const file = writeExportFile(bundle);

    const impostor = testReceiptKeypair();
    const code = await runVerifyReportCli([file, '--key', impostor.publicKeyHex]);
    expect(code).toBe(1);
  });

  function writeDoc(doc: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'suveren-verify-report-cli-'));
    dirs.push(dir);
    const file = join(dir, 'report.html');
    writeFileSync(file, doc);
    return file;
  }

  async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    try {
      const code = await fn();
      return { code, out: lines.join('\n') };
    } finally {
      console.log = orig;
    }
  }

  it('a reference drawn as not verifiable: exit 2 without a key, 0 with --key, and it is listed', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const { doc } = await buildRealExport('<sv-ticket ref="t1"></sv-ticket><sv-ticket ref="ghost"></sv-ticket>', archive, kp);
    const file = writeDoc(doc);

    const noKey = await captureStdout(() => runVerifyReportCli([file]));
    expect(noKey.code).toBe(2);
    expect(noKey.out).toContain('1 verified · 1 not verifiable (as shown in the report)');
    expect(noKey.out).toMatch(/Not verifiable \(as shown in the report\):\n\s+- sv-ticket-1 \(ghost\) — not in the file: ghost/);

    const withKey = await captureStdout(() => runVerifyReportCli([file, '--key', kp.publicKeyHex]));
    expect(withKey.code).toBe(0);
  });

  it('REFUSAL: exit 1 — the missing reference\'s drawn badge flipped to verified', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const { doc } = await buildRealExport('<sv-ticket ref="t1"></sv-ticket><sv-ticket ref="ghost"></sv-ticket>', archive, kp);
    const file = writeDoc(doc.replace('sv-badge sv-badge-bad', 'sv-badge sv-badge-ok'));

    const { code, out } = await captureStdout(() => runVerifyReportCli([file, '--key', kp.publicKeyHex]));
    expect(code).toBe(1);
    expect(out).toContain('shown as verified with no valid backing');
  });

  it('REFUSAL: exit 1 — an invalid signature still fails a real export with a flagged reference', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const { bundle } = await buildRealExport('<sv-ticket ref="t1"></sv-ticket><sv-ticket ref="ghost"></sv-ticket>', archive, kp);
    (bundle.tickets[0] as Record<string, unknown>).action = 'tampered';
    const renderedAgain = await verifyReport('<sv-ticket ref="t1"></sv-ticket><sv-ticket ref="ghost"></sv-ticket>', { archive, runExport: noExports() });
    const file = writeDoc(buildExportDocument({ bundle, renderedHtml: renderReportHtml(renderedAgain.html, renderedAgain.elements) }));

    const { code } = await captureStdout(() => runVerifyReportCli([file, '--key', kp.publicKeyHex]));
    expect(code).toBe(1);
  });

  it('REFUSAL: a file with no embedded proof bundle fails loudly (exit 1), not silently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'suveren-verify-report-cli-'));
    dirs.push(dir);
    const file = join(dir, 'not-a-report.html');
    writeFileSync(file, '<html><body>no proof here</body></html>');
    const code = await runVerifyReportCli([file]);
    expect(code).toBe(1);
  });
});
