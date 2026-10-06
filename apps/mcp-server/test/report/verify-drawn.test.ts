/**
 * RR7 — the offline checker checks what the page SHOWS, not only the
 * signatures behind it. Real signed tickets/attestations (buildScenario), the
 * real verifyReport → export → `verify-report` CLI path; the tampering is done
 * the way a forger would: on the downloaded file.
 *
 * Two layers, each tested on its own:
 *   - an edit to the visible page only → the page no longer re-draws from the
 *     bundle (exit 1);
 *   - a CONSISTENT forgery (page AND the bundle's drawn elements edited, the
 *     page re-drawn to match) → the drawn value no longer matches its signed
 *     source or does not recompute (exit 1).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyReport } from '../../src/lib/report/verify-report';
import { renderReportHtml, checkedValueLine } from '../../src/lib/report/render-report';
import { buildExportBundle, buildExportDocument, renderExportBody } from '../../src/lib/report/export-report';
import { verifyExportBundle, recomputeBoundsHash } from '../../src/lib/report/verify-export';
import { extractProofBundle, runVerifyReportCli } from '../../bin/report-verify-cli';
import { buildScenario, AS_URL } from './fixtures/scenario';
import { buildEmailExport, buildErpExport } from './fixtures/exports';
import type { ExportSystem, RunConnectorExport } from '../../src/lib/report/types';
import type { ExportBundle } from '../../src/lib/report/export-types';

const SAMPLE = readFileSync(resolve(__dirname, '../fixtures/sample-report.html'), 'utf-8');
// The sample report plus a FULL ticket (execution context, mandate group,
// approval group) and two more metrics.
const HTML = SAMPLE.replace(
  '<sv-glossary',
  '<sv-ticket ref="g1" variant="full"></sv-ticket>\n<sv-row><sv-metric kind="tickets" cases="all"></sv-metric><sv-metric kind="approvals" cases="all"></sv-metric></sv-row>\n<sv-glossary',
);
const OWNER = 'did:key:z6MkOwnerRR7';

async function buildRich(timeZone?: string) {
  const { archive, addTicket, kp } = buildScenario();
  const start = 1_800_000_000;
  const authorization = {
    authorizationId: 'authz-1', profileId: 'erp@0.1', intent: 'Confirm stock before ordering.',
    bounds: { value_max: 5000, currency: 'EUR' }, owners: [OWNER], commitmentMode: 'review_above_cap' as const,
  };
  addTicket({ id: 's1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: start + 300, authorization });
  addTicket({
    id: 'g1', action: 'erp__create_order', authorizationId: 'authz-1', timestamp: start + 1800, authorization,
    extra: { executionContext: { amount: 3200, currency: 'EUR' } },
    proposal: { createdAt: start + 300, status: 'approved', committedBy: { u1: { userId: 'M. Huber', at: start + 1800 } } },
  });
  const email = buildEmailExport({
    simulation_load: { name: 'sample', package_sha256: 'x', cases_loaded: 2, loaded_at: '2027-01-15T07:55:00Z' },
    inbox: [
      { id: 'm1', from_name: 'Kraus GmbH', from_email: 'orders@kraus.example', to_json: '[]', subject: 'Order inquiry', body: 'x', received_at: '2027-01-15T08:00:00Z', case_id: 'C1' },
      { id: 'm2', from_name: 'Other Co', from_email: 'buy@other.example', to_json: '[]', subject: 'Another order', body: 'y', received_at: '2027-01-15T09:00:00Z', case_id: 'C2' },
    ],
  });
  const erp = buildErpExport({ quotes: [{ id: 'Q1', number: 'Q-2027-0001', customer_id: 'kraus', status: 'sent', currency: 'EUR', net_total: 4380, created_at: '2027-01-15T08:10:00Z' }] });
  const runExport: RunConnectorExport = async (system: ExportSystem) => ({ email, erp } as Record<string, unknown>)[system] ?? {};
  const result = await verifyReport(HTML, { archive, runExport });
  const now = Math.floor(Date.now() / 1000);
  const stored = { html: result.html, savedAt: now, checkedAt: now, result };
  const bundle = buildExportBundle({ stored, archive, gatewayVersion: 'test', authorityServer: { url: AS_URL, publicKeyHex: kp.publicKeyHex }, ...(timeZone ? { timeZone } : {}) });
  const doc = buildExportDocument({ bundle });
  return { bundle, doc, kp, result };
}

async function cli(doc: string, key?: string): Promise<{ code: number; out: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'suveren-rr7-drawn-'));
  const file = join(dir, 'report.html');
  writeFileSync(file, doc);
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try {
    const code = await runVerifyReportCli(key ? [file, '--key', key] : [file]);
    return { code, out: lines.join('\n') };
  } finally {
    console.log = log;
    console.error = err;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A forger who edits the bundle's drawn data too, keeps the Proof panel in
 *  step, and re-draws the page so it reproduces exactly. */
function forgeConsistently(bundle: ExportBundle, mutate: (b: ExportBundle) => void): string {
  const b = JSON.parse(JSON.stringify(bundle)) as ExportBundle;
  mutate(b);
  b.proof.verifiedValues = b.elements
    .filter(e => e.status !== 'unverifiable')
    .map(e => ({ elementId: e.id, kind: e.kind, summary: checkedValueLine(e) }));
  return buildExportDocument({ bundle: b });
}

function el(b: ExportBundle, id: string) {
  const e = b.elements.find(x => x.id === id);
  if (!e?.data) throw new Error(`no drawn data for ${id}`);
  return e as typeof e & { data: Record<string, any> };
}

describe('RR7 — an untouched export passes, and says per box what was checked how', () => {
  it('exit 2 without a key, 0 with --key; the page re-draws exactly', async () => {
    const { doc, kp } = await buildRich();
    expect((await cli(doc)).code).toBe(2);
    const { code, out } = await cli(doc, kp.publicKeyHex);
    expect(code, out).toBe(0);
    expect(out).toContain('Page: exactly what the signed data draws.');
    expect(out).toMatch(/Not checkable offline/);
  });

  it('per box: signed / recomputed / not checkable offline — database and archive values are never "signed"', async () => {
    const { doc, kp } = await buildRich();
    const r = await verifyExportBundle(extractProofBundle(doc), { documentHtml: doc, expectedKeyHex: kp.publicKeyHex });
    expect(r.allValid).toBe(true);
    expect(r.document.state).toBe('match');
    const box = (id: string) => r.boxes.find(b => b.elementId === id)!;

    // Compact ticket: fully signed.
    expect(box('sv-ticket-0')).toMatchObject({ signed: ['action', 'timestamp'], recomputed: [], notCheckable: [], mismatches: [] });
    // Full ticket: ticket + mandate fields signed, approval group archive.
    const full = box('sv-ticket-2');
    expect(full.signed).toEqual(expect.arrayContaining(['action', 'timestamp', 'profileId', 'ticket', 'amount', 'currency', 'mandate.value_max', 'mandate.currency', 'mandate.commitment_mode', 'mandate.owner']));
    expect(full.notCheckable).toEqual(expect.arrayContaining([{ field: 'approval.createdAt', source: 'archive' }, { field: 'approval.committedBy', source: 'archive' }]));
    // Mandate: everything signed, the intent via its signed hash.
    expect(box('sv-mandate-0').signed).toEqual(expect.arrayContaining(['value_max', 'currency', 'profileId', 'commitment_mode', 'owner', 'intent']));
    expect(box('sv-mandate-0').notCheckable).toEqual([]);
    // Approval: archive, wait_s recomputed.
    expect(box('sv-approval-0').notCheckable.map(n => n.source)).toEqual(['archive', 'archive', 'archive', 'archive']);
    expect(box('sv-approval-0').recomputed).toEqual([{ field: 'wait_s', inputs: ['archive'] }]);
    // Record: database, nothing signed.
    expect(box('sv-record-0').signed).toEqual([]);
    expect(box('sv-record-0').notCheckable.length).toBeGreaterThan(0);
    expect(box('sv-record-0').notCheckable.every(n => n.source === 'database')).toBe(true);
    // Case: tickets signed, start email database, duration_s recomputed.
    const c = box('sv-case-0');
    expect(c.signed).toEqual(expect.arrayContaining(['goal.action', 'goal.timestamp', 'step[0].action', 'step[0].timestamp']));
    expect(c.notCheckable).toEqual(expect.arrayContaining([{ field: 'received_at', source: 'database' }, { field: 'case_id', source: 'database' }]));
    expect(c.recomputed).toEqual([{ field: 'duration_s', inputs: ['signed', 'database'] }]);
    // Metrics: recomputed from the case boxes.
    for (const id of ['sv-metric-0', 'sv-metric-1', 'sv-metric-2', 'sv-metric-3', 'sv-metric-4']) {
      expect(box(id).recomputed.map(x => x.field), id).toEqual(['value']);
      expect(box(id).mismatches, id).toEqual([]);
    }
  });

  it('the bundle\'s drawn elements re-draw exactly what the gateway drew from its full verification data', async () => {
    const { bundle, result } = await buildRich();
    expect(renderExportBody(bundle)).toBe(renderReportHtml(result.html, result.elements, { gloss: 'toggle' }));
    expect(renderExportBody(JSON.parse(JSON.stringify(bundle)))).toBe(renderExportBody(bundle));
  });
});

describe('RR7 — an edit to the visible page fails (exit 1)', () => {
  it('a value in a full ticket: amount 3200 → 32000', async () => {
    const { doc, kp } = await buildRich();
    const edited = doc.replace('<span class="sv-v">3200</span>', '<span class="sv-v">32000</span>');
    expect(edited).not.toBe(doc);
    const { code, out } = await cli(edited, kp.publicKeyHex);
    expect(code).toBe(1);
    expect(out).toMatch(/INVALID — page: The visible page differs/);
  });

  it('a mandate limit: value_max 5000 → 50000', async () => {
    const { doc, kp } = await buildRich();
    const edited = doc.replace(/(value_max<\/span>(?:<rt>[^<]*<\/rt><\/ruby>)?<span class="sv-v">)5000</, '$150000<');
    expect(edited).not.toBe(doc);
    expect((await cli(edited, kp.publicKeyHex)).code).toBe(1);
  });

  it('a metric number', async () => {
    const { doc, kp } = await buildRich();
    const edited = doc.replace(/(cases_completed<\/span>(?:<rt>[^<]*<\/rt><\/ruby>)?<span class="sv-v">)1</, '$17<');
    expect(edited).not.toBe(doc);
    expect((await cli(edited, kp.publicKeyHex)).code).toBe(1);
  });

  it('a timestamp, and a style that changes how a value reads', async () => {
    const { doc, kp } = await buildRich();
    const ts = doc.replace(/(timestamp<\/span>(?:<rt>[^<]*<\/rt><\/ruby>)?<span class="sv-v">\d{4}-\d\d-\d\d )\d\d/, '$123');
    expect(ts).not.toBe(doc);
    expect((await cli(ts, kp.publicKeyHex)).code).toBe(1);
    const styled = doc.replace('</head>', '<style>.sv-v::after{content:"0"}</style></head>');
    expect((await cli(styled, kp.publicKeyHex)).code).toBe(1);
  });
});

describe('RR7 — a consistent forgery (page AND bundle data edited) still fails (exit 1)', () => {
  it('a full ticket\'s execution value differs from the signed ticket', async () => {
    const { bundle, kp } = await buildRich();
    const doc = forgeConsistently(bundle, b => { el(b, 'sv-ticket-2').data.executionContext.amount = 32000; });
    const { code, out } = await cli(doc, kp.publicKeyHex);
    expect(code).toBe(1);
    expect(out).toMatch(/sv-ticket-2: The execution context the box shows differs from the signed ticket/);
    expect(out).not.toMatch(/INVALID — page/); // the page itself re-draws — the source check caught it
  });

  it('a drawn mandate limit differs from the signed bounds', async () => {
    const { bundle, kp } = await buildRich();
    const doc = forgeConsistently(bundle, b => { el(b, 'sv-mandate-0').data.rawLimits.value_max = 50000; });
    const { code, out } = await cli(doc, kp.publicKeyHex);
    expect(code).toBe(1);
    expect(out).toMatch(/sv-mandate-0: limits/);
  });

  it('a bundled bound edited without its hash — the recomputed bounds hash no longer matches the signed one', async () => {
    const { bundle, kp } = await buildRich();
    const doc = forgeConsistently(bundle, b => {
      b.authorizations['authz-1'].bounds!.value_max = 50000;
      el(b, 'sv-mandate-0').data.rawLimits.value_max = 50000;
      el(b, 'sv-ticket-2').data.mandate.rawLimits.value_max = 50000;
    });
    const r = await verifyExportBundle(extractProofBundle(doc), { documentHtml: doc, expectedKeyHex: kp.publicKeyHex });
    expect(r.document.state).toBe('match');
    const auth = r.authorizations.find(a => a.authorizationId === 'authz-1')!;
    expect(auth.boundsHashMatches).toBe(false);
    expect(auth.boundsValuesProven).toBe(false);
    expect(r.allValid).toBe(false);
    expect((await cli(doc, kp.publicKeyHex)).code).toBe(1);
  });

  it('a bound added to the file only (a key the signed hash never covered)', async () => {
    const { bundle, kp } = await buildRich();
    const doc = forgeConsistently(bundle, b => {
      (b.authorizations['authz-1'].bounds as Record<string, unknown>).discount_max = 50;
      el(b, 'sv-mandate-0').data.rawLimits.discount_max = 50;
    });
    expect((await cli(doc, kp.publicKeyHex)).code).toBe(1);
  });

  it('a metric number that does not recompute from the case boxes', async () => {
    const { bundle, kp } = await buildRich();
    const doc = forgeConsistently(bundle, b => { el(b, 'sv-metric-3').data.value = 9; });
    const { code, out } = await cli(doc, kp.publicKeyHex);
    expect(code).toBe(1);
    expect(out).toMatch(/sv-metric-3: value: the box shows 9, recomputed from the case boxes 2/);
  });

  it('a case duration that is not goal.timestamp − start', async () => {
    const { bundle, kp } = await buildRich();
    const doc = forgeConsistently(bundle, b => { el(b, 'sv-case-0').data.totalDurationSeconds = 60; });
    expect((await cli(doc, kp.publicKeyHex)).code).toBe(1);
  });

  it('an owner name no signed attestation in the file discloses', async () => {
    const { bundle, kp } = await buildRich();
    const doc = forgeConsistently(bundle, b => { el(b, 'sv-mandate-0').data.owners = ['Andreas Schadauer']; });
    const { code, out } = await cli(doc, kp.publicKeyHex);
    expect(code).toBe(1);
    expect(out).toMatch(/not a name this owner disclosed/);
  });

  it('an owner name disclosed in ANOTHER mandate\'s attestation travels with its signed blob and checks out', async () => {
    const { archive, addTicket, kp } = buildScenario();
    const named = [{ did: OWNER, assurance: 'high' as const, method: 'as_vouched' as const, trust_root: 'as' as const, verifier: 'did:web:as.example', disclose: { name: 'Andreas Schadauer' } }];
    addTicket({ id: 'n1', action: 'erp__create_quote', authorizationId: 'authz-named', timestamp: 1_800_000_000, authorization: { authorizationId: 'authz-named', profileId: 'sales@0.3', owners: [OWNER], subjects: named } });
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-plain', timestamp: 1_800_000_100, authorization: { authorizationId: 'authz-plain', profileId: 'sales@0.3', owners: [OWNER], bounds: { value_max: 100 } } });
    const result = await verifyReport('<sv-mandate ticket="t1"></sv-mandate>', { archive, runExport: async () => ({}) });
    expect(result.elements[0].data!.owners).toEqual(['Andreas Schadauer']);
    const now = Math.floor(Date.now() / 1000);
    const bundle = buildExportBundle({ stored: { html: result.html, savedAt: now, checkedAt: now, result }, archive, gatewayVersion: 't', authorityServer: { url: AS_URL, publicKeyHex: kp.publicKeyHex } });
    expect(Object.keys(bundle.authorizations)).toEqual(['authz-plain']);
    expect(bundle.identityAttestations).toHaveLength(1);
    const doc = buildExportDocument({ bundle });
    expect((await cli(doc, kp.publicKeyHex)).code).toBe(0);
    // Without that blob, the name is not backed.
    const stripped = forgeConsistently(bundle, b => { b.identityAttestations = []; });
    expect((await cli(stripped, kp.publicKeyHex)).code).toBe(1);
  });

  it('the bounds VALUES of an untouched file hash to the signed bounds_hash', async () => {
    const { bundle } = await buildRich();
    expect(recomputeBoundsHash(bundle.authorizations['authz-1'].bounds!)).toBe(
      (bundle.tickets.find(t => (t as { id?: string }).id === 'g1') as { boundsHash?: string }).boundsHash,
    );
  });
});

describe('RR7 — the drawing time zone', () => {
  it('a file drawn in another zone than the checker\'s re-draws exactly; every time shows its own offset', async () => {
    const { doc, kp } = await buildRich('America/New_York');
    expect(doc).toMatch(/<span class="sv-v">2027-01-15 03:30:00 UTC-5<\/span>/); // 08:30Z
    // The "Checked values" panel reads exactly like the boxes — same zone.
    expect(doc).toContain('<span>action erp__create_quote · timestamp 2027-01-15 03:05:00 UTC-5</span>');
    const r = await verifyExportBundle(extractProofBundle(doc), { documentHtml: doc, expectedKeyHex: kp.publicKeyHex });
    expect(r.document.state).toBe('match');
    expect(r.allValid).toBe(true);
  });

  it('an unknown zone in the file fails the check', async () => {
    const { bundle, kp } = await buildRich();
    const doc = buildExportDocument({ bundle });
    const forged = doc.replace('"timeZone":"' + bundle.timeZone + '"', '"timeZone":"Mars/Olympus"');
    expect(forged).not.toBe(doc);
    expect((await cli(forged, kp.publicKeyHex)).code).toBe(1);
  });
});
