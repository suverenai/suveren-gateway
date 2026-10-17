/**
 * document-source.ts — resolves {connector, kind, id} references through a
 * manifest's `documents` declaration, via the connector's own `internal`
 * read tool. Mirrors preview.test.ts's stub-IntegrationManager pattern
 * (library mechanism unit test, not an e2e product test).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadManifests } from '../src/lib/manifest-loader';
import { resolveDocumentReference, documentChangedSinceSealing, resolveAttachmentPreview } from '../src/lib/document-source';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';

let manifestDir: string;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

const PDF_BYTES = Buffer.from('%PDF-1.4 fake invoice bytes');
const PDF_BASE64 = PDF_BYTES.toString('base64');
const PDF_SHA256 = sha256(PDF_BYTES);

beforeAll(() => {
  manifestDir = mkdtempSync(join(tmpdir(), 'hap-document-source-manifests-'));
  mkdirSync(join(manifestDir, 'erp'));
  writeFileSync(join(manifestDir, 'index.json'), JSON.stringify({ integrations: { erp: 'erp/manifest.json' } }));
  writeFileSync(
    join(manifestDir, 'erp/manifest.json'),
    JSON.stringify({
      id: 'erp',
      name: 'ERP',
      version: '1',
      profile: 'invoicing',
      mcp: { command: 'node', args: [] },
      credentials: { fields: [], envMapping: {} },
      oauth: null,
      documents: {
        'invoice-pdf': { tool: 'get_document', args: { kind: 'invoice-pdf', id: '$id' } },
      },
      toolGating: {
        default: { executionMapping: {}, staticExecution: {} },
        overrides: {
          get_document: { category: 'read', internal: true },
        },
      },
    }),
  );
  loadManifests(manifestDir);
});

afterAll(() => rmSync(manifestDir, { recursive: true, force: true }));

function buildIntegrationManager(answer: unknown, toolName = 'get_document') {
  const callTool = vi.fn().mockImplementation(async () => ({
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: answer,
  }));
  const tools: DiscoveredTool[] = [
    {
      originalName: toolName,
      namespacedName: `erp__${toolName}`,
      integrationId: 'erp',
      description: '',
      inputSchema: { type: 'object' },
      gating: { profile: 'invoicing', executionMapping: {}, staticExecution: {}, category: 'read', internal: true } as unknown as DiscoveredTool['gating'],
      internal: true,
    },
  ];
  const integrationManager = { getAllTools: () => tools, callTool, isBuiltin: () => false } as unknown as IntegrationManager;
  return { integrationManager, callTool };
}

describe('resolveDocumentReference', () => {
  it('resolves a declared document kind through its internal tool, computing sha256 itself', async () => {
    const { integrationManager, callTool } = buildIntegrationManager({
      filename: 'invoice-2026-0003.pdf',
      contentType: 'application/pdf',
      contentBase64: PDF_BASE64,
      sha256: PDF_SHA256,
    });
    const result = await resolveDocumentReference(integrationManager, { connector: 'erp', kind: 'invoice-pdf', id: 'inv-1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc.filename).toBe('invoice-2026-0003.pdf');
      expect(result.doc.sha256).toBe(PDF_SHA256);
      expect(result.doc.bytes).toBe(PDF_BYTES.byteLength);
    }
    // $id substitution: the literal "kind" passed through, "id" substituted.
    expect(callTool).toHaveBeenCalledWith('erp', 'get_document', { kind: 'invoice-pdf', id: 'inv-1' });
  });

  it('refuses an undeclared document kind', async () => {
    const { integrationManager } = buildIntegrationManager({});
    const result = await resolveDocumentReference(integrationManager, { connector: 'erp', kind: 'nonexistent-kind', id: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNDECLARED_KIND');
  });

  it('refuses an unknown connector', async () => {
    const { integrationManager } = buildIntegrationManager({});
    const result = await resolveDocumentReference(integrationManager, { connector: 'not-a-connector', kind: 'invoice-pdf', id: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNKNOWN_CONNECTOR');
  });

  it('refuses when the connector claims a sha256 that does not match the actual bytes', async () => {
    const { integrationManager } = buildIntegrationManager({
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
      contentBase64: PDF_BASE64,
      sha256: 'deadbeef'.repeat(8),
    });
    const result = await resolveDocumentReference(integrationManager, { connector: 'erp', kind: 'invoice-pdf', id: 'inv-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('HASH_MISMATCH');
  });

  it('refuses a malformed result missing required fields', async () => {
    const { integrationManager } = buildIntegrationManager({ filename: 'x.pdf' });
    const result = await resolveDocumentReference(integrationManager, { connector: 'erp', kind: 'invoice-pdf', id: 'inv-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MALFORMED_RESULT');
  });
});

describe('documentChangedSinceSealing', () => {
  it('false when the re-resolved sha256 matches the sealed one', async () => {
    const { integrationManager } = buildIntegrationManager({
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
      contentBase64: PDF_BASE64,
      sha256: PDF_SHA256,
    });
    const changed = await documentChangedSinceSealing(integrationManager, { connector: 'erp', kind: 'invoice-pdf', id: 'inv-1' }, PDF_SHA256);
    expect(changed).toBe(false);
  });

  it('true (refuse) when the sha256 differs — the document changed since sealing', async () => {
    const { integrationManager } = buildIntegrationManager({
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
      contentBase64: PDF_BASE64,
      sha256: PDF_SHA256,
    });
    const changed = await documentChangedSinceSealing(integrationManager, { connector: 'erp', kind: 'invoice-pdf', id: 'inv-1' }, 'some-other-sha');
    expect(changed).toBe(true);
  });

  it('true (fail closed) when the document cannot be resolved at all', async () => {
    const { integrationManager } = buildIntegrationManager({});
    const changed = await documentChangedSinceSealing(integrationManager, { connector: 'erp', kind: 'does-not-exist', id: 'x' }, PDF_SHA256);
    expect(changed).toBe(true);
  });
});

// UI spec §15.2 — the approval/ticket card's live attachment preview route's
// underlying orchestration (apps/mcp-server/bin/http.ts's own
// POST /internal/document-preview is a thin wrapper around this).
describe('resolveAttachmentPreview', () => {
  it('status "ok" with the bytes when the re-resolved sha256 matches the sealed one', async () => {
    const { integrationManager } = buildIntegrationManager({
      filename: 'invoice-2026-0003.pdf',
      contentType: 'application/pdf',
      contentBase64: PDF_BASE64,
      sha256: PDF_SHA256,
    });
    const result = await resolveAttachmentPreview(integrationManager, { connector: 'erp', kind: 'invoice-pdf', id: 'inv-1' }, PDF_SHA256);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.filename).toBe('invoice-2026-0003.pdf');
      expect(result.sha256).toBe(PDF_SHA256);
      expect(result.contentBase64).toBe(PDF_BASE64);
    }
  });

  it('status "changed" — never served under the old fingerprint — when the sha256 no longer matches', async () => {
    const { integrationManager } = buildIntegrationManager({
      filename: 'invoice-2026-0003.pdf',
      contentType: 'application/pdf',
      contentBase64: PDF_BASE64,
      sha256: PDF_SHA256,
    });
    const result = await resolveAttachmentPreview(integrationManager, { connector: 'erp', kind: 'invoice-pdf', id: 'inv-1' }, 'some-other-sealed-sha');
    expect(result.status).toBe('changed');
    if (result.status === 'changed') {
      expect(result.message).toMatch(/changed since it was sealed/);
      expect(result).not.toHaveProperty('contentBase64');
    }
  });

  it('status "not_found" when the read tool answers isError (no such document)', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'no such document' }], isError: true });
    const tools: DiscoveredTool[] = [
      {
        originalName: 'get_document',
        namespacedName: 'erp__get_document',
        integrationId: 'erp',
        description: '',
        inputSchema: { type: 'object' },
        gating: { profile: 'invoicing', executionMapping: {}, staticExecution: {}, category: 'read', internal: true } as unknown as DiscoveredTool['gating'],
        internal: true,
      },
    ];
    const integrationManager = { getAllTools: () => tools, callTool, isBuiltin: () => false } as unknown as IntegrationManager;
    const result = await resolveAttachmentPreview(integrationManager, { connector: 'erp', kind: 'invoice-pdf', id: 'missing' }, PDF_SHA256);
    expect(result.status).toBe('not_found');
  });

  it('status "error" for an undeclared document kind', async () => {
    const { integrationManager } = buildIntegrationManager({});
    const result = await resolveAttachmentPreview(integrationManager, { connector: 'erp', kind: 'does-not-exist', id: 'x' }, PDF_SHA256);
    expect(result.status).toBe('error');
  });

  it('status "unavailable" when the connector claims a sha256 that does not match its own bytes', async () => {
    const { integrationManager } = buildIntegrationManager({
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
      contentBase64: PDF_BASE64,
      sha256: 'deadbeef'.repeat(8),
    });
    const result = await resolveAttachmentPreview(integrationManager, { connector: 'erp', kind: 'invoice-pdf', id: 'inv-1' }, PDF_SHA256);
    expect(result.status).toBe('unavailable');
  });
});
