/**
 * The wire path of a large document, against a REAL MCP server over stdio
 * (fixtures/doc-server.mjs) with the gateway's own transport setting. What it
 * pins: a reply bigger than the SDK's 10 MiB default arrives; 25 MiB is the
 * most one attachment may be; 25 MiB is the most per email; the base64 handed
 * on is the canonical encoding of the bytes that were hashed; connector
 * warnings arrive cleaned.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadManifests } from '../src/lib/manifest-loader';
import { resolveDocumentReference } from '../src/lib/document-source';
import { finalizeAttachmentsForExecution, ATTACHMENTS_SEALED_META_KEY } from '../src/lib/attachment-resolution';
import { CONNECTOR_STDIO_MAX_BUFFER_BYTES } from '../src/lib/attachment-limits';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';

let manifestDir: string;
let client: Client;
let manager: IntegrationManager;

beforeAll(async () => {
  manifestDir = mkdtempSync(join(tmpdir(), 'hap-doc-wire-'));
  mkdirSync(join(manifestDir, 'docs'));
  writeFileSync(join(manifestDir, 'index.json'), JSON.stringify({ integrations: { docs: 'docs/manifest.json' } }));
  writeFileSync(join(manifestDir, 'docs/manifest.json'), JSON.stringify({
    id: 'docs', name: 'Docs', version: '1', profile: 'documents',
    mcp: { command: 'node', args: [] }, credentials: { fields: [], envMapping: {} }, oauth: null,
    attachments: { transport: 'field', arg: 'attachments' },
    documents: { file: { tool: 'get_document', args: { kind: 'file', id: '$id' }, aiSupplied: true } },
    toolGating: { default: { executionMapping: {}, staticExecution: {} }, overrides: { get_document: { category: 'read', internal: true } } },
  }));
  loadManifests(manifestDir);

  const server = join(import.meta.dirname, 'fixtures', 'doc-server.mjs');
  client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [server],
    cwd: join(import.meta.dirname, '..'),
    maxBufferSize: CONNECTOR_STDIO_MAX_BUFFER_BYTES,
  }));
  const tools: DiscoveredTool[] = [{
    originalName: 'get_document', namespacedName: 'docs__get_document', integrationId: 'docs', description: '',
    inputSchema: { type: 'object' }, internal: true,
    gating: { profile: 'documents', executionMapping: {}, staticExecution: {}, category: 'read', internal: true } as unknown as DiscoveredTool['gating'],
  }];
  manager = {
    getAllTools: () => tools,
    isBuiltin: () => false,
    callTool: async (_i: string, name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      return { content: r.content as Array<{ type: string; text: string }>, isError: r.isError as boolean | undefined, structuredContent: r.structuredContent as Record<string, unknown> | undefined };
    },
  } as unknown as IntegrationManager;
}, 30_000);

afterAll(async () => {
  await client?.close().catch(() => {});
  rmSync(manifestDir, { recursive: true, force: true });
});

describe('a large document over the real stdio wire', () => {
  it('delivers a 12 MiB document (the SDK default buffer would close the connection)', async () => {
    const r = await resolveDocumentReference(manager, { connector: 'docs', kind: 'file', id: '12mb' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bytes = Buffer.alloc(12 * 1024 * 1024, 7);
    expect(r.doc.bytes).toBe(bytes.byteLength);
    expect(r.doc.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    // The base64 handed on is the encoding of the hashed bytes.
    expect(Buffer.from(r.doc.contentBase64, 'base64').equals(bytes)).toBe(true);
    expect(r.doc.aiSupplied).toBe(true);
  }, 60_000);

  it('delivers exactly 25 MiB and refuses 26 MiB as too large', async () => {
    const ok = await resolveDocumentReference(manager, { connector: 'docs', kind: 'file', id: '25mb' });
    expect(ok.ok).toBe(true);
    const big = await resolveDocumentReference(manager, { connector: 'docs', kind: 'file', id: '26mb' });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error.code).toBe('TOO_LARGE');
  }, 120_000);

  it('hands on cleaned connector warnings only', async () => {
    const r = await resolveDocumentReference(manager, { connector: 'docs', kind: 'file', id: 'warn' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.warnings).toHaveLength(3);
    expect(r.doc.warnings![0]).toBe('The PDF has form fields.');
    expect(r.doc.warnings![1]).toBe('ev il line');
    expect(r.doc.warnings![2]).toHaveLength(300);
  });

  it('refuses an email whose attachments add up to more than 25 MiB, for the total and not for a changed file', async () => {
    const real = await resolveDocumentReference(manager, { connector: 'docs', kind: 'file', id: '13mb' });
    if (!real.ok) throw new Error('setup');
    const a = { connector: 'docs', kind: 'file', id: '13mb', filename: '13mb.pdf', contentType: 'application/pdf', sha256: real.doc.sha256, bytes: real.doc.bytes };
    const r = await finalizeAttachmentsForExecution(manager, 'docs', { [ATTACHMENTS_SEALED_META_KEY]: { attachments: [a, a], inserts: [] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/in total/);
  }, 60_000);
});
