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
import { buildExportBundle } from '../../src/lib/report/export-report';
import { verifyExportBundle } from '../../src/lib/report/verify-export';
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

  it('REFUSAL: a reference to a ticket missing from the bundle is reported, not silently skipped', async () => {
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

  it('REFUSAL: a file with no embedded proof bundle fails loudly (exit 1), not silently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'suveren-verify-report-cli-'));
    dirs.push(dir);
    const file = join(dir, 'not-a-report.html');
    writeFileSync(file, '<html><body>no proof here</body></html>');
    const code = await runVerifyReportCli([file]);
    expect(code).toBe(1);
  });
});
