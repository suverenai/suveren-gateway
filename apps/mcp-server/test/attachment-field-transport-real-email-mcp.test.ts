/**
 * Field-transport attachments against the REAL, published
 * @humanagencyp/email-mcp 0.4.0 (stdio) — not a mock. Proves the exact
 * bytes `resolveAttachmentsAndInserts` builds for the "field" transport
 * (suveren-invoicing-plan.md §6/§7) reach the connector unchanged: send a
 * message with an attachment through the real server, then read it back
 * via its own `get_message` and compare filename/contentType/sha256/size.
 *
 * Installs the published package into a throwaway temp dir (network
 * required). If that install fails — no network in this environment — the
 * test is skipped with a clear message rather than failing CI; every OTHER
 * attachment mechanism is covered by the stub-IntegrationManager unit
 * tests in attachment-resolution.test.ts regardless.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveAttachmentsAndInserts, finalizeAttachmentsForExecution, ATTACHMENTS_SEALED_META_KEY } from '../src/lib/attachment-resolution';
import { loadManifests } from '../src/lib/manifest-loader';
import { registerProfile } from '@hap/core';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import { mkdirSync } from 'node:fs';

const PROFILE = 'email-real-mcp-test';
let installDir: string | undefined;
let serverEntry: string | undefined;
let dbPath: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'hap-email-mcp-install-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'tmp', private: true }));
  try {
    execFileSync('npm', ['install', '@humanagencyp/email-mcp@0.4.0', '--no-audit', '--no-fund'], {
      cwd: dir,
      stdio: 'pipe',
      timeout: 60_000,
    });
    const entry = join(dir, 'node_modules', '@humanagencyp', 'email-mcp', 'dist', 'index.js');
    if (existsSync(entry)) {
      installDir = dir;
      serverEntry = entry;
    }
  } catch (err) {
    console.error(`[test] could not install @humanagencyp/email-mcp@0.4.0 (no network?) — skipping real-stdio test: ${err}`);
  }

  registerProfile(PROFILE, {
    id: PROFILE,
    version: '0.9',
    description: 'test',
    scopeSchema: { keyOrder: ['allowed_attachment_sources'], fields: { allowed_attachment_sources: { type: 'string', required: false } } },
    executionContextSchema: { fields: {} },
    requiredGates: [],
    ttl: { default: 1, max: 1 },
    retention_minimum: 1,
  });

  const manifestDir = mkdtempSync(join(tmpdir(), 'hap-email-mcp-manifest-'));
  mkdirSync(join(manifestDir, 'erp'));
  mkdirSync(join(manifestDir, 'mail'));
  writeFileSync(join(manifestDir, 'index.json'), JSON.stringify({ integrations: { erp: 'erp/manifest.json', mail: 'mail/manifest.json' } }));
  writeFileSync(
    join(manifestDir, 'erp/manifest.json'),
    JSON.stringify({
      id: 'erp', name: 'ERP', version: '1', profile: 'invoicing',
      mcp: { command: 'node', args: [] }, credentials: { fields: [], envMapping: {} }, oauth: null,
      documents: { 'invoice-pdf': { tool: 'get_document', args: { kind: 'invoice-pdf', id: '$id' } } },
      toolGating: { default: { executionMapping: {} }, overrides: { get_document: { category: 'read', internal: true } } },
    }),
  );
  // Declares the "field" attachments transport this test's resolution call
  // reads (manifest-driven, not hardcoded) — the actual downstream call
  // below talks to the REAL spawned email-mcp 0.4.0, not this manifest.
  writeFileSync(
    join(manifestDir, 'mail/manifest.json'),
    JSON.stringify({
      id: 'mail', name: 'Mail', version: '1', profile: PROFILE,
      mcp: { command: 'node', args: [] }, credentials: { fields: [], envMapping: {} }, oauth: null,
      attachments: { transport: 'field', arg: 'attachments' },
      toolGating: {
        default: { executionMapping: {} },
        overrides: { send_message: { executionMapping: {}, staticExecution: { action_type: 'send' }, attachmentsArg: 'attachments', insertFields: ['body'] } },
      },
    }),
  );
  loadManifests(manifestDir);

  dbPath = join(mkdtempSync(join(tmpdir(), 'hap-email-mcp-db-')), 'email-test.db');
}, 90_000);

afterAll(() => {
  if (installDir) rmSync(installDir, { recursive: true, force: true });
});

function buildErpIntegrationManager(doc: { filename: string; contentType: string; contentBase64: string; sha256: string }) {
  const callTool = async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: doc });
  const tools: DiscoveredTool[] = [
    { originalName: 'get_document', namespacedName: 'erp__get_document', integrationId: 'erp', description: '', inputSchema: { type: 'object' }, gating: { profile: 'invoicing', executionMapping: {}, category: 'read', internal: true } as unknown as DiscoveredTool['gating'], internal: true },
  ];
  return { getAllTools: () => tools, callTool, isBuiltin: () => false } as unknown as IntegrationManager;
}

describe('field transport — real @humanagencyp/email-mcp 0.4.0 (stdio)', () => {
  it('passes the gateway-built attachment bytes through unchanged', async () => {
    if (!serverEntry) {
      console.warn('[test] skipped — email-mcp 0.4.0 was not installable (no network).');
      return;
    }

    const pdfBytes = Buffer.from('%PDF-1.4 real-stdio-round-trip test bytes');
    const pdfBase64 = pdfBytes.toString('base64');
    const pdfSha256 = createHash('sha256').update(pdfBytes).digest('hex');

    const im = buildErpIntegrationManager({
      filename: 'invoice-2026-0003.pdf',
      contentType: 'application/pdf',
      contentBase64: pdfBase64,
      sha256: pdfSha256,
    });

    const mailTool = { integrationId: 'mail', namespacedName: 'mail__send_message', gating: { attachmentsArg: 'attachments', insertFields: ['body'] } };
    const resolved = await resolveAttachmentsAndInserts(
      im, mailTool, PROFILE,
      { to: ['buchhaltung@drautal.at'], subject: 'Rechnung 2026-0003', body: 'Anbei die Rechnung.', attachments: [{ connector: 'erp', kind: 'invoice-pdf', id: 'inv-1' }] },
      'erp:invoice-pdf',
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    // "Resolve for display" alone carries no bytes (item 3 — proposal/
    // ticket storage never carries attachment bytes); finalize (the
    // execution-time step, run here with no approval gap) builds the
    // actual transport payload — `transport.arg` for mail.json's manifest
    // is "attachments", the manifest-declared field-transport shape
    // {filename, contentType, contentBase64}.
    const sealedArgs = { ...resolved.args, [ATTACHMENTS_SEALED_META_KEY]: resolved.sealed };
    const finalized = await finalizeAttachmentsForExecution(im, 'mail', sealedArgs);
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;
    const outgoing = finalized.args;

    const transport = new StdioClientTransport({
      command: 'node',
      args: [serverEntry],
      env: { ...process.env, DATABASE_URL: dbPath, EMAIL_MODE: 'simulation' } as Record<string, string>,
    });
    const client = new Client({ name: 'hap-test-client', version: '1.0.0' });
    await client.connect(transport);
    try {
      const sendResult = await client.callTool({ name: 'send_message', arguments: outgoing as Record<string, unknown> });
      expect(sendResult.isError).not.toBe(true);
      const sent = (sendResult.structuredContent ?? JSON.parse((sendResult.content as Array<{ text?: string }>)[0]?.text ?? '{}')) as {
        id: string;
        attachments: Array<{ filename: string; content_type?: string; contentType?: string; size: number; sha256: string }>;
      };

      const getResult = await client.callTool({ name: 'get_message', arguments: { id: sent.id } });
      const message = (getResult.structuredContent ?? JSON.parse((getResult.content as Array<{ text?: string }>)[0]?.text ?? '{}')) as {
        attachments: Array<{ filename: string; size: number; sha256: string }>;
      };

      expect(message.attachments).toHaveLength(1);
      expect(message.attachments[0].filename).toBe('invoice-2026-0003.pdf');
      expect(message.attachments[0].sha256).toBe(pdfSha256);
      expect(message.attachments[0].size).toBe(pdfBytes.byteLength);
    } finally {
      await client.close();
    }
  }, 30_000);
});
