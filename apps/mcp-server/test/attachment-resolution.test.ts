/**
 * attachment-resolution.ts — the orchestration point tool-proxy.ts calls
 * for a write tool declaring `attachmentsArg`/`insertFields`: shape check →
 * policy check → resolve → substitute → build the transport-specific
 * outgoing payload. Covers both connector transports (field, mime-raw) and
 * every required refusal.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { registerProfile } from '@hap/core';
import { loadManifests } from '../src/lib/manifest-loader';
import {
  resolveAttachmentsAndInserts,
  finalizeAttachmentsForExecution,
  stripAttachmentsSealedMeta,
  ATTACHMENTS_SEALED_META_KEY,
} from '../src/lib/attachment-resolution';
import { ATTACHMENT_SOURCES_FIELD } from '../src/lib/attachment-policy';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';

const HYPOTHETICAL_PROFILE = 'email-attachments-test';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

const PDF_BYTES = Buffer.from('%PDF-1.4 fake invoice bytes');
const PDF_BASE64 = PDF_BYTES.toString('base64');
const PDF_SHA256 = sha256(PDF_BYTES);

let manifestDir: string;

beforeAll(() => {
  registerProfile(HYPOTHETICAL_PROFILE, {
    id: HYPOTHETICAL_PROFILE,
    version: '0.9',
    description: 'test — email profile with the allowed-attachment-sources field declared',
    scopeSchema: { keyOrder: [ATTACHMENT_SOURCES_FIELD], fields: { [ATTACHMENT_SOURCES_FIELD]: { type: 'string', required: false } } },
    executionContextSchema: { fields: {} },
    requiredGates: [],
    ttl: { default: 1, max: 1 },
    retention_minimum: 1,
  });

  manifestDir = mkdtempSync(join(tmpdir(), 'hap-attachment-resolution-manifests-'));
  for (const id of ['erp', 'mail', 'gmail', 'mollie']) mkdirSync(join(manifestDir, id));
  writeFileSync(
    join(manifestDir, 'index.json'),
    JSON.stringify({ integrations: { erp: 'erp/manifest.json', mail: 'mail/manifest.json', gmail: 'gmail/manifest.json', mollie: 'mollie/manifest.json' } }),
  );
  writeFileSync(
    join(manifestDir, 'erp/manifest.json'),
    JSON.stringify({
      id: 'erp', name: 'ERP', version: '1', profile: 'invoicing',
      mcp: { command: 'node', args: [] }, credentials: { fields: [], envMapping: {} }, oauth: null,
      documents: { 'invoice-pdf': { tool: 'get_document', args: { kind: 'invoice-pdf', id: '$id' } } },
      toolGating: { default: { executionMapping: {} }, overrides: { get_document: { category: 'read', internal: true } } },
    }),
  );
  writeFileSync(
    join(manifestDir, 'mail/manifest.json'),
    JSON.stringify({
      id: 'mail', name: 'Mail', version: '1', profile: HYPOTHETICAL_PROFILE,
      mcp: { command: 'node', args: [] }, credentials: { fields: [], envMapping: {} }, oauth: null,
      attachments: { transport: 'field', arg: 'attachments' },
      toolGating: {
        default: { executionMapping: {} },
        overrides: {
          send_message: {
            executionMapping: {}, staticExecution: { action_type: 'send' },
            attachmentsArg: 'attachments', insertFields: ['body'],
          },
        },
      },
    }),
  );
  writeFileSync(
    join(manifestDir, 'gmail/manifest.json'),
    JSON.stringify({
      id: 'gmail', name: 'Gmail', version: '1', profile: HYPOTHETICAL_PROFILE,
      mcp: { command: 'node', args: [] }, credentials: { fields: [], envMapping: {} }, oauth: null,
      attachments: { transport: 'mime-raw', arg: 'raw' },
      toolGating: {
        default: { executionMapping: {} },
        overrides: {
          send_message: {
            executionMapping: {}, staticExecution: { action_type: 'send' }, blockedArgs: ['raw'],
            attachmentsArg: 'attachments', insertFields: ['body'],
          },
        },
      },
    }),
  );
  writeFileSync(
    join(manifestDir, 'mollie/manifest.json'),
    JSON.stringify({
      id: 'mollie', name: 'Mollie', version: '1', profile: 'charge',
      mcp: { command: 'node', args: [] }, credentials: { fields: [], envMapping: {} }, oauth: null,
      values: {
        'payment-link': { tool: 'GetPaymentLink', args: { id: '$id' }, path: '_links.paymentLink.href', allowedHosts: ['paymentlink.mollie.com'] },
      },
      toolGating: { default: { executionMapping: {} }, overrides: { GetPaymentLink: { category: 'read', readGovernance: 'none', readGovernanceReason: 'test' } } },
    }),
  );
  loadManifests(manifestDir);
});

afterAll(() => rmSync(manifestDir, { recursive: true, force: true }));

function buildIntegrationManager(responses: Record<string, Record<string, unknown>>) {
  const callTool = vi.fn().mockImplementation(async (_integrationId: string, toolName: string) => ({
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: responses[toolName] ?? {},
  }));
  const tools: DiscoveredTool[] = [
    { originalName: 'get_document', namespacedName: 'erp__get_document', integrationId: 'erp', description: '', inputSchema: { type: 'object' }, gating: { profile: 'invoicing', executionMapping: {}, category: 'read', internal: true } as unknown as DiscoveredTool['gating'], internal: true },
    { originalName: 'GetPaymentLink', namespacedName: 'mollie__GetPaymentLink', integrationId: 'mollie', description: '', inputSchema: { type: 'object' }, gating: { profile: 'charge', executionMapping: {}, category: 'read' } as unknown as DiscoveredTool['gating'] },
  ];
  return { getAllTools: () => tools, callTool, isBuiltin: () => false } as unknown as IntegrationManager;
}

const sendMessageMailTool = { integrationId: 'mail', namespacedName: 'mail__send_message', gating: { attachmentsArg: 'attachments', insertFields: ['body'] } };
const sendMessageGmailTool = { integrationId: 'gmail', namespacedName: 'gmail__send_message', gating: { attachmentsArg: 'attachments', insertFields: ['body'] } };
const plainTool = { integrationId: 'erp', namespacedName: 'erp__create_quote', gating: {} };

describe('resolveAttachmentsAndInserts — fast no-op', () => {
  it('passes args through unchanged when the tool declares neither attachmentsArg nor insertFields', async () => {
    const im = buildIntegrationManager({});
    const args = { customer_id: 'c1' };
    const result = await resolveAttachmentsAndInserts(im, plainTool, 'sales', args);
    expect(result).toEqual({ ok: true, args });
  });
});

describe('resolveAttachmentsAndInserts — attachments', () => {
  it('refuses AI-supplied bytes instead of a reference', async () => {
    const im = buildIntegrationManager({});
    const result = await resolveAttachmentsAndInserts(im, sendMessageMailTool, HYPOTHETICAL_PROFILE, {
      to: ['x@y.com'], subject: 'S', body: 'B',
      attachments: [{ filename: 'x.pdf', contentType: 'application/pdf', contentBase64: 'AAAA' }],
    });
    expect(result.ok).toBe(false);
  });

  it('refuses by default when the profile value does not list the referenced source (no allowedSourcesValue given)', async () => {
    const im = buildIntegrationManager({ get_document: { filename: 'x.pdf', contentType: 'application/pdf', contentBase64: PDF_BASE64, sha256: PDF_SHA256 } });
    const result = await resolveAttachmentsAndInserts(im, sendMessageMailTool, HYPOTHETICAL_PROFILE, {
      to: ['x@y.com'], subject: 'S', body: 'B',
      attachments: [{ connector: 'erp', kind: 'invoice-pdf', id: 'inv-1' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not allowed/);
  });

  it('refuses an undeclared document kind — caught by policy first (not in the allowed source list)', async () => {
    const im = buildIntegrationManager({});
    const result = await resolveAttachmentsAndInserts(
      im, sendMessageMailTool, HYPOTHETICAL_PROFILE,
      { to: ['x@y.com'], subject: 'S', body: 'B', attachments: [{ connector: 'erp', kind: 'does-not-exist', id: 'inv-1' }] },
      'erp:invoice-pdf',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not allowed/);
  });

  it('refuses an undeclared document kind even when the source string itself is allowed by the mandate', async () => {
    const im = buildIntegrationManager({});
    const result = await resolveAttachmentsAndInserts(
      im, sendMessageMailTool, HYPOTHETICAL_PROFILE,
      { to: ['x@y.com'], subject: 'S', body: 'B', attachments: [{ connector: 'erp', kind: 'does-not-exist', id: 'inv-1' }] },
      'erp:does-not-exist',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/resolve/);
  });

  it('resolve for display: seals the fingerprint but does NOT embed bytes into the outgoing args (item 3 — no bytes in a proposal)', async () => {
    const im = buildIntegrationManager({ get_document: { filename: 'invoice-2026-0003.pdf', contentType: 'application/pdf', contentBase64: PDF_BASE64, sha256: PDF_SHA256 } });
    const result = await resolveAttachmentsAndInserts(
      im, sendMessageMailTool, HYPOTHETICAL_PROFILE,
      { to: ['buchhaltung@drautal.at'], subject: 'Rechnung', body: 'Anbei die Rechnung.', attachments: [{ connector: 'erp', kind: 'invoice-pdf', id: 'inv-1' }] },
      'erp:invoice-pdf',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // No transport key, no bytes — field transport's own arg name ("attachments")
      // is deleted, never re-populated at this stage.
      expect(result.args.attachments).toBeUndefined();
      expect(result.args.insert).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(PDF_BASE64);
      expect(result.sealed?.attachments).toEqual([
        { connector: 'erp', kind: 'invoice-pdf', id: 'inv-1', filename: 'invoice-2026-0003.pdf', contentType: 'application/pdf', sha256: PDF_SHA256, bytes: PDF_BYTES.byteLength },
      ]);
    }
  });
});

describe('finalizeAttachmentsForExecution', () => {
  it('is a no-op when args carry no sealed meta', async () => {
    const im = buildIntegrationManager({});
    const args = { to: ['x@y.com'] };
    const result = await finalizeAttachmentsForExecution(im, 'mail', args);
    expect(result).toEqual({ ok: true, args });
  });

  it('is a no-op when the sealed meta is present but empty', async () => {
    const im = buildIntegrationManager({});
    const args = { to: ['x@y.com'], [ATTACHMENTS_SEALED_META_KEY]: { attachments: [], inserts: [] } };
    const result = await finalizeAttachmentsForExecution(im, 'mail', args);
    expect(result).toEqual({ ok: true, args });
  });

  it('field transport: re-resolves and builds the exact {filename, contentType, contentBase64} payload', async () => {
    const responses = { get_document: { filename: 'invoice-2026-0003.pdf', contentType: 'application/pdf', contentBase64: PDF_BASE64, sha256: PDF_SHA256 } };
    const im = buildIntegrationManager(responses);
    const resolved = await resolveAttachmentsAndInserts(
      im, sendMessageMailTool, HYPOTHETICAL_PROFILE,
      { to: ['buchhaltung@drautal.at'], subject: 'Rechnung', body: 'Anbei die Rechnung.', attachments: [{ connector: 'erp', kind: 'invoice-pdf', id: 'inv-1' }] },
      'erp:invoice-pdf',
    );
    if (!resolved.ok) throw new Error('setup failed');
    const sealedArgs = { ...resolved.args, [ATTACHMENTS_SEALED_META_KEY]: resolved.sealed };
    const result = await finalizeAttachmentsForExecution(im, 'mail', sealedArgs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.attachments).toEqual([{ filename: 'invoice-2026-0003.pdf', contentType: 'application/pdf', contentBase64: PDF_BASE64 }]);
    }
  });

  it('mime-raw transport: re-resolves and builds a base64url "raw" payload', async () => {
    const responses = { get_document: { filename: 'invoice.pdf', contentType: 'application/pdf', contentBase64: PDF_BASE64, sha256: PDF_SHA256 } };
    const im = buildIntegrationManager(responses);
    const resolved = await resolveAttachmentsAndInserts(
      im, sendMessageGmailTool, HYPOTHETICAL_PROFILE,
      { to: ['buchhaltung@drautal.at'], subject: 'Rechnung', body: 'Anbei die Rechnung.', attachments: [{ connector: 'erp', kind: 'invoice-pdf', id: 'inv-1' }] },
      'erp:invoice-pdf',
    );
    if (!resolved.ok) throw new Error('setup failed');
    const sealedArgs = { ...resolved.args, [ATTACHMENTS_SEALED_META_KEY]: resolved.sealed };
    const result = await finalizeAttachmentsForExecution(im, 'gmail', sealedArgs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.args.raw).toBe('string');
      expect((result.args.raw as string)).not.toMatch(/[+/=]/); // base64url, no padding
      expect(result.args.attachments).toBeUndefined();
      const decoded = Buffer.from((result.args.raw as string).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      expect(decoded).toContain('invoice.pdf');
      expect(decoded).toContain('application/pdf');
    }
  });

  it('refuses — nothing built — when the document changed since it was sealed (sha256 mismatch)', async () => {
    const responses = { get_document: { filename: 'invoice.pdf', contentType: 'application/pdf', contentBase64: PDF_BASE64, sha256: PDF_SHA256 } };
    const im = buildIntegrationManager(responses);
    const resolved = await resolveAttachmentsAndInserts(
      im, sendMessageMailTool, HYPOTHETICAL_PROFILE,
      { to: ['x@y.com'], subject: 'S', body: 'B', attachments: [{ connector: 'erp', kind: 'invoice-pdf', id: 'inv-1' }] },
      'erp:invoice-pdf',
    );
    if (!resolved.ok) throw new Error('setup failed');
    const sealedArgs = { ...resolved.args, [ATTACHMENTS_SEALED_META_KEY]: resolved.sealed };
    // The document changed between proposal and approval.
    const CHANGED_BYTES = Buffer.from('%PDF-1.4 a DIFFERENT invoice');
    responses.get_document = { filename: 'invoice.pdf', contentType: 'application/pdf', contentBase64: CHANGED_BYTES.toString('base64'), sha256: sha256(CHANGED_BYTES) };
    const result = await finalizeAttachmentsForExecution(im, 'mail', sealedArgs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/changed since this was approved/);
  });

  it('refuses — nothing built — when an inserted value changed since it was sealed', async () => {
    const responses = { GetPaymentLink: { _links: { paymentLink: { href: 'https://paymentlink.mollie.com/payment/x' } } } };
    const im = buildIntegrationManager(responses);
    const resolved = await resolveAttachmentsAndInserts(im, sendMessageMailTool, HYPOTHETICAL_PROFILE, {
      to: ['x@y.com'], subject: 'S', body: 'Pay here: {{link}}',
      insert: [{ placeholder: '{{link}}', connector: 'mollie', kind: 'payment-link', id: 'pl_1' }],
    });
    if (!resolved.ok) throw new Error('setup failed');
    const sealedArgs = { ...resolved.args, [ATTACHMENTS_SEALED_META_KEY]: resolved.sealed };
    // The value read from Mollie changed between proposal and approval.
    responses.GetPaymentLink = { _links: { paymentLink: { href: 'https://paymentlink.mollie.com/payment/DIFFERENT' } } };
    const result = await finalizeAttachmentsForExecution(im, 'mail', sealedArgs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/changed since this was approved/);
  });
});

describe('resolveAttachmentsAndInserts — inserts', () => {
  it('substitutes a resolved value into the declared insertFields', async () => {
    const im = buildIntegrationManager({ GetPaymentLink: { _links: { paymentLink: { href: 'https://paymentlink.mollie.com/payment/x' } } } });
    const result = await resolveAttachmentsAndInserts(im, sendMessageMailTool, HYPOTHETICAL_PROFILE, {
      to: ['x@y.com'], subject: 'S', body: 'Pay here: {{link}}',
      insert: [{ placeholder: '{{link}}', connector: 'mollie', kind: 'payment-link', id: 'pl_1' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.body).toBe('Pay here: https://paymentlink.mollie.com/payment/x');
      expect(result.args.insert).toBeUndefined();
      expect(result.sealed?.inserts).toEqual([{ placeholder: '{{link}}', connector: 'mollie', kind: 'payment-link', id: 'pl_1', value: 'https://paymentlink.mollie.com/payment/x' }]);
    }
  });

  it('refuses a placeholder in the text with no matching insert', async () => {
    const im = buildIntegrationManager({});
    const result = await resolveAttachmentsAndInserts(im, sendMessageMailTool, HYPOTHETICAL_PROFILE, {
      to: ['x@y.com'], subject: 'S', body: 'Pay here: {{link}}',
    });
    expect(result.ok).toBe(false);
  });

  it('refuses an insert on a tool that declares no insertable fields', async () => {
    const im = buildIntegrationManager({ GetPaymentLink: { _links: { paymentLink: { href: 'https://paymentlink.mollie.com/x' } } } });
    const noInsertTool = { integrationId: 'mail', namespacedName: 'mail__send_message', gating: { attachmentsArg: 'attachments' } };
    const result = await resolveAttachmentsAndInserts(im, noInsertTool, HYPOTHETICAL_PROFILE, {
      to: ['x@y.com'], subject: 'S', body: 'B',
      insert: [{ placeholder: '{{link}}', connector: 'mollie', kind: 'payment-link', id: 'pl_1' }],
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a disallowed-host value even when the insert would otherwise match', async () => {
    const im = buildIntegrationManager({ GetPaymentLink: { _links: { paymentLink: { href: 'https://evil.example.com/x' } } } });
    const result = await resolveAttachmentsAndInserts(im, sendMessageMailTool, HYPOTHETICAL_PROFILE, {
      to: ['x@y.com'], subject: 'S', body: 'Pay here: {{link}}',
      insert: [{ placeholder: '{{link}}', connector: 'mollie', kind: 'payment-link', id: 'pl_1' }],
    });
    expect(result.ok).toBe(false);
  });
});

describe('stripAttachmentsSealedMeta', () => {
  it('removes the meta key, leaving everything else untouched', () => {
    const args = { to: ['x@y.com'], [ATTACHMENTS_SEALED_META_KEY]: { attachments: [], inserts: [] } };
    expect(stripAttachmentsSealedMeta(args)).toEqual({ to: ['x@y.com'] });
  });

  it('is a no-op when the key is absent', () => {
    const args = { to: ['x@y.com'] };
    expect(stripAttachmentsSealedMeta(args)).toBe(args);
  });
});
