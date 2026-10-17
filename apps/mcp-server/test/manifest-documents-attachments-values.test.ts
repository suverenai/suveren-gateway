/**
 * Manifest validation for `documents` / `attachments` / `values`
 * (suveren-invoicing-plan.md §6/§7) — manifest-loader.ts's
 * invalidManifestDocumentsReason/invalidManifestAttachmentsReason/
 * invalidManifestValuesReason, and that a malformed manifest is refused
 * WHOLE (never partially loaded), same discipline as every other
 * manifest-shape check here (au10-manifest-context.test.ts, manifest-
 * summary.test.ts, ...).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadManifests,
  getManifest,
  invalidManifestDocumentsReason,
  invalidManifestAttachmentsReason,
  invalidManifestValuesReason,
} from '../src/lib/manifest-loader';

let dir: string | undefined;

function writeManifest(id: string, manifest: Record<string, unknown>): string {
  dir = mkdtempSync(join(tmpdir(), 'hap-doc-attach-manifests-'));
  mkdirSync(join(dir, id));
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ integrations: { [id]: `${id}/manifest.json` } }));
  writeFileSync(join(dir, `${id}/manifest.json`), JSON.stringify(manifest));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const BASE = {
  name: 'Test',
  version: '1',
  profile: 'invoicing',
  mcp: { command: 'node', args: [] },
  credentials: { fields: [], envMapping: {} },
  oauth: null,
};

describe('invalidManifestDocumentsReason', () => {
  it('null for a manifest with no documents block', () => {
    expect(invalidManifestDocumentsReason({ toolGating: { default: { executionMapping: {} } } })).toBeNull();
  });

  it('refuses a document kind whose tool is not marked internal', () => {
    const reason = invalidManifestDocumentsReason({
      documents: { 'invoice-pdf': { tool: 'get_document', args: { kind: 'invoice-pdf', id: '$id' } } },
      toolGating: { default: { executionMapping: {} }, overrides: { get_document: { category: 'read' } } },
    });
    expect(reason).toMatch(/internal/);
  });

  it('accepts a document kind whose tool IS marked internal', () => {
    const reason = invalidManifestDocumentsReason({
      documents: { 'invoice-pdf': { tool: 'get_document', args: { kind: 'invoice-pdf', id: '$id' } } },
      toolGating: { default: { executionMapping: {} }, overrides: { get_document: { category: 'read', internal: true } } },
    });
    expect(reason).toBeNull();
  });

  it('refuses a malformed read shape (missing args)', () => {
    const reason = invalidManifestDocumentsReason({
      documents: { 'invoice-pdf': { tool: 'get_document' } },
      toolGating: { default: { executionMapping: {} }, overrides: { get_document: { category: 'read', internal: true } } },
    });
    expect(reason).toMatch(/args/);
  });

  it('the real erp.json manifest loads cleanly with its documents block', () => {
    loadManifests(join(import.meta.dirname, '../../../content/integrations'));
    expect(getManifest('erp')?.documents?.['invoice-pdf']).toEqual({
      tool: 'get_document',
      args: { kind: 'invoice-pdf', id: '$id' },
    });
  });
});

describe('invalidManifestAttachmentsReason', () => {
  it('null for a manifest with no attachments transport and no override opting in', () => {
    expect(invalidManifestAttachmentsReason({ toolGating: { default: { executionMapping: {} } } })).toBeNull();
  });

  it('refuses an invalid transport value', () => {
    expect(invalidManifestAttachmentsReason({ attachments: { transport: 'carrier-pigeon', arg: 'attachments' } })).toMatch(/transport/);
  });

  it('refuses an override declaring attachmentsArg with no top-level attachments transport', () => {
    const reason = invalidManifestAttachmentsReason({
      toolGating: { default: { executionMapping: {} }, overrides: { send_message: { attachmentsArg: 'attachments' } } },
    });
    expect(reason).toMatch(/attachmentsArg/);
  });

  it('accepts an override declaring attachmentsArg when the transport is declared', () => {
    const reason = invalidManifestAttachmentsReason({
      attachments: { transport: 'field', arg: 'attachments' },
      toolGating: { default: { executionMapping: {} }, overrides: { send_message: { attachmentsArg: 'attachments' } } },
    });
    expect(reason).toBeNull();
  });

  it('refuses a non-array insertFields', () => {
    const reason = invalidManifestAttachmentsReason({
      toolGating: { default: { executionMapping: {} }, overrides: { send_message: { insertFields: 'body' } } },
    });
    expect(reason).toMatch(/insertFields/);
  });
});

describe('invalidManifestValuesReason', () => {
  it('null for a manifest with no values block', () => {
    expect(invalidManifestValuesReason({})).toBeNull();
  });

  it('refuses a value kind missing allowedHosts', () => {
    const reason = invalidManifestValuesReason({
      values: { 'payment-link': { tool: 'GetPaymentLink', args: { id: '$id' }, path: '_links.paymentLink.href' } },
    });
    expect(reason).toMatch(/allowedHosts/);
  });

  it('refuses a value kind missing path', () => {
    const reason = invalidManifestValuesReason({
      values: { 'payment-link': { tool: 'GetPaymentLink', args: { id: '$id' }, allowedHosts: ['mollie.com'] } },
    });
    expect(reason).toMatch(/path/);
  });

  it('accepts a well-formed value kind', () => {
    const reason = invalidManifestValuesReason({
      values: {
        'payment-link': {
          tool: 'GetPaymentLink',
          args: { id: '$id' },
          path: '_links.paymentLink.href',
          allowedHosts: ['paymentlink.mollie.com'],
        },
      },
    });
    expect(reason).toBeNull();
  });
});

describe('loadManifests refuses the whole manifest on a documents/attachments/values defect', () => {
  it('a document kind pointing at a non-internal tool refuses the whole manifest', () => {
    const d = writeManifest('baddoc', {
      id: 'baddoc',
      ...BASE,
      documents: { 'invoice-pdf': { tool: 'get_document', args: { kind: 'invoice-pdf', id: '$id' } } },
      toolGating: { default: { executionMapping: {} }, overrides: { get_document: { category: 'read' } } },
    });
    loadManifests(d);
    expect(getManifest('baddoc')).toBeUndefined();
  });
});
