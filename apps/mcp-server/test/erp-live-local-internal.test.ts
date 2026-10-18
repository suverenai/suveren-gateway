/**
 * ERP connector live/local mode — a REAL check against the BUILT
 * `@humanagencyp/erp-mcp` package (temp/erp-local/dist/index.js, the source
 * for the published 0.8.0 the gateway pins — see erp.json's `npmVersion`)
 * over real stdio, using the REAL `content/integrations/erp.json` manifest
 * (only `mcp.command`/`args` are overridden, to point at the local build
 * instead of the installed `erp-mcp` binary on PATH).
 *
 * Exercises the `internal: true` mechanism (tool-gating-types.ts
 * `ProfileToolGatingEntry.internal`) end to end, same four layers as
 * internal-preview-tools.test.ts (DL1) proves for a BUILT-IN's own internal
 * tools — here for a CONNECTOR's:
 *  A. `preview_invoice`/`get_document` — and ONLY them, among erp's
 *     invoicing-area tools — carry `DiscoveredTool.internal === true`.
 *  B. Never registered with the real MCP SDK (`tools/list`).
 *  C. `createGatedToolHandler` refuses a direct call (defence in depth).
 *  D. `IntegrationManager.callTool` — what the AU3/§15.1 preview mechanism
 *     actually uses — still reaches `preview_invoice` and gets back a real
 *     rendered PDF matching `lib/document-preview.ts`'s expected shape.
 *
 * Skipped (never a hard failure) when the local erp-mcp build isn't present
 * — e.g. a checkout of this worktree alone, without `temp/erp-local` built.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ERP_DIST = join(import.meta.dirname, '..', '..', '..', '..', 'erp-local', 'dist', 'index.js');
const MANIFESTS_DIR = join(import.meta.dirname, '..', '..', '..', 'content', 'integrations');
const hasFixture = existsSync(ERP_DIST);

describe.skipIf(!hasFixture)('ERP live/local mode — real erp-mcp build over stdio', () => {
  let dataDir: string;
  let companyFile: string;
  let customerId: string;

  beforeAll(async () => {
    // Becomes HAP_DATA_DIR for the spawned child (integration-manager.ts's
    // SUVEREN_DATA_DIR -> HAP_DATA_DIR translation) — set BEFORE importing
    // integration-manager.ts, which reads it once at import.
    dataDir = mkdtempSync(join(tmpdir(), 'erp-live-data-'));
    process.env.SUVEREN_DATA_DIR = dataDir;

    const companyDir = mkdtempSync(join(tmpdir(), 'erp-live-company-'));
    companyFile = join(companyDir, 'company.json');
    writeFileSync(companyFile, JSON.stringify({
      name: 'Suveren Test GmbH',
      owner: 'Andreas Schadauer',
      address: { street: 'Hauptstraße 1', zip: '1010', city: 'Wien', country: 'Österreich', country_code: 'AT' },
      uid: 'ATU00000000',
      email: 'test@example.com',
      web: 'https://example.com',
      register: null,
      bank: { name: 'Testbank', iban: 'AT000000000000000000', bic: 'TESTATWW' },
      default_payment_term_days: 14,
      vat_mode: 'normal',
    }));

    // Seed one customer directly via the connector's own CLI (customers
    // add/list/import are its only write path for master data — there is no
    // MCP tool for it, by design).
    const seedEnv = {
      ...process.env,
      HAP_DATA_DIR: dataDir,
      ERP_MODE: 'live',
      ERP_LIVE_ADAPTER: 'local',
      ERP_LIVE_COMPANY_FILE: companyFile,
    };
    const out = execFileSync(
      process.execPath,
      [ERP_DIST, 'customers', 'add', JSON.stringify({
        name: 'Drautal Maschinenbau GmbH',
        address_lines: ['Industriestr. 5', '9800 Spittal'],
        country: 'AT',
        uid: 'ATU87654321',
        email: 'buchhaltung@drautal.at',
      })],
      { env: seedEnv, encoding: 'utf8' },
    );
    customerId = (JSON.parse(out) as { id: string }).id;

    const { loadManifests } = await import('../src/lib/manifest-loader');
    loadManifests(MANIFESTS_DIR);
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.SUVEREN_DATA_DIR;
  });

  async function startErp() {
    const { IntegrationManager } = await import('../src/lib/integration-manager');
    const { getManifest } = await import('../src/lib/manifest-loader');
    const manifest = getManifest('erp')!;
    const im = new IntegrationManager(new Map([['erp', { mode: 'live', liveAdapter: 'local', companyFile }]]));
    await im.startIntegration({
      id: 'erp',
      name: manifest.name,
      // The REAL manifest's gating/display/preview config, spawned against
      // the LOCAL build instead of the installed "erp-mcp" binary.
      command: process.execPath,
      args: [ERP_DIST],
      envKeys: {
        ERP_MODE: 'erp.mode',
        ERP_LIVE_ADAPTER: 'erp.liveAdapter',
        ERP_LIVE_COMPANY_FILE: 'erp.companyFile',
      },
      profile: manifest.profile,
      // Real wiring (apps/control-plane's mcp-bridge.ts): the control plane
      // copies the manifest's OWN toolGating straight onto the
      // IntegrationConfig it sends to /internal/add-integration — the
      // manifest is the sole source for gating (no per-profile toolGating).
      toolGating: manifest.toolGating,
      enabled: true,
    });
    return im;
  }

  it('A. preview_invoice and get_document — and ONLY them — are discovered as internal', async () => {
    const im = await startErp();
    try {
      const erpTools = im.getAllTools().filter((t) => t.integrationId === 'erp');
      expect(erpTools.length).toBeGreaterThan(0);
      const internalNames = erpTools.filter((t) => t.internal).map((t) => t.originalName).sort();
      expect(internalNames).toEqual(['get_document', 'preview_invoice']);
      // Control: an ordinary invoicing read of the SAME connector is not internal.
      expect(erpTools.find((t) => t.originalName === 'get_invoice')?.internal).toBeFalsy();
    } finally {
      await im.shutdown();
    }
  });

  it('B. never registered with the real MCP SDK — absent from tools/list', async () => {
    const im = await startErp();
    try {
      const { createMcpServer } = await import('../src/index');
      const state = {
        getEnrichedAuthorizations: () => [],
        executionLog: { record: () => {}, sumByWindow: () => 0, getAll: () => [] },
        spClient: { isUnlocked: () => true },
      } as unknown as import('../src/lib/shared-state').SharedState;
      const { server } = createMcpServer(state, im);
      const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
      expect(registered['erp__preview_invoice']).toBeUndefined();
      expect(registered['erp__get_document']).toBeUndefined();
      // Control: an ordinary tool of the same connector IS registered.
      expect(registered['erp__get_customer']).toBeDefined();
    } finally {
      await im.shutdown();
    }
  });

  it('C. createGatedToolHandler refuses a direct call (defence in depth)', async () => {
    const im = await startErp();
    try {
      const { createGatedToolHandler } = await import('../src/lib/tool-proxy');
      const tool = im.getAllTools().find((t) => t.namespacedName === 'erp__preview_invoice')!;
      const result = await createGatedToolHandler(tool, im, {} as unknown as import('../src/lib/shared-state').SharedState)({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/internal and cannot be called directly/);
    } finally {
      await im.shutdown();
    }
  });

  it('D. IntegrationManager.callTool still reaches preview_invoice and renders a real PDF matching the document-preview shape', async () => {
    const im = await startErp();
    try {
      const result = await im.callTool('erp', 'preview_invoice', {
        customer_id: customerId,
        number: '2026-TEST-0001',
        document_date: '2026-10-15',
        service_period: { from: '2026-10-01', to: '2026-10-31' },
        lines: [{ description: 'Consulting', qty: 1, unit_price: 100, vat_rate: 20 }],
        net_total: 100,
        currency: 'EUR',
      });
      expect(result.isError).toBeFalsy();
      // The JSON is in content[0].text (and, from erp-mcp 0.9.0, also in
      // structuredContent) — the text form is what every connector has.
      const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
      const { isDocumentPreviewBody } = await import('../../ui/src/lib/document-preview');
      expect(isDocumentPreviewBody(body)).toBe(true);
      expect(body.contentType).toBe('application/pdf');
      expect(typeof body.contentBase64).toBe('string');
      expect((body.contentBase64 as string).length).toBeGreaterThan(100);
      expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(body.pages).toBeGreaterThanOrEqual(1);
      // erp-mcp >= 0.9.0: the same args render byte-identical PDFs (the
      // document date, not "now", drives the PDF metadata) — this is what lets
      // the approved preview equal the issued document.
      const sameArgs = await im.callTool('erp', 'preview_invoice', {
        customer_id: customerId, number: '2026-TEST-0001', document_date: '2026-10-15',
        service_period: { from: '2026-10-01', to: '2026-10-31' },
        lines: [{ description: 'Consulting', qty: 1, unit_price: 100, vat_rate: 20 }],
        net_total: 100, currency: 'EUR',
      });
      expect(JSON.parse(sameArgs.content[0].text).sha256).toBe(body.sha256);
      // preview_invoice must not have issued anything — a second identical
      // call must succeed again with the SAME number still unused.
      const again = await im.callTool('erp', 'preview_invoice', {
        customer_id: customerId,
        number: '2026-TEST-0001',
        document_date: '2026-10-15',
        service_period: { from: '2026-10-01', to: '2026-10-31' },
        lines: [{ description: 'Consulting', qty: 1, unit_price: 100, vat_rate: 20 }],
        net_total: 100,
        currency: 'EUR',
      });
      expect(again.isError).toBeFalsy();
    } finally {
      await im.shutdown();
    }
  });

  it('E. get_document refuses an unknown id (a real connector answer, not a gateway-side guess)', async () => {
    const im = await startErp();
    try {
      const result = await im.callTool('erp', 'get_document', { kind: 'invoice-pdf', id: 'does-not-exist' });
      expect(result.isError).toBe(true);
    } finally {
      await im.shutdown();
    }
  });
});
