/**
 * insert-values.ts — resolves {placeholder, connector, kind, id} references
 * read from another system (e.g. a Mollie payment link) and substitutes
 * them into declared text fields, with a host allow-list and two-way
 * placeholder matching.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifests } from '../src/lib/manifest-loader';
import { resolveInsertValue, applyInserts, type ResolvedInsert } from '../src/lib/insert-values';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';

let manifestDir: string;

beforeAll(() => {
  manifestDir = mkdtempSync(join(tmpdir(), 'hap-insert-values-manifests-'));
  mkdirSync(join(manifestDir, 'mollie'));
  writeFileSync(join(manifestDir, 'index.json'), JSON.stringify({ integrations: { mollie: 'mollie/manifest.json' } }));
  writeFileSync(
    join(manifestDir, 'mollie/manifest.json'),
    JSON.stringify({
      id: 'mollie',
      name: 'Mollie',
      version: '1',
      profile: 'charge',
      mcp: { command: 'node', args: [] },
      credentials: { fields: [], envMapping: {} },
      oauth: null,
      values: {
        'payment-link': {
          tool: 'GetPaymentLink',
          args: { id: '$id' },
          path: '_links.paymentLink.href',
          allowedHosts: ['paymentlink.mollie.com', 'mollie.com'],
        },
      },
      toolGating: {
        default: { executionMapping: {}, staticExecution: {} },
        overrides: {
          GetPaymentLink: { category: 'read', readGovernance: 'none', readGovernanceReason: 'test' },
        },
      },
    }),
  );
  loadManifests(manifestDir);
});

afterAll(() => rmSync(manifestDir, { recursive: true, force: true }));

function buildIntegrationManager(answer: unknown) {
  const callTool = vi.fn().mockImplementation(async () => ({
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: answer,
  }));
  const tools: DiscoveredTool[] = [
    {
      originalName: 'GetPaymentLink',
      namespacedName: 'mollie__GetPaymentLink',
      integrationId: 'mollie',
      description: '',
      inputSchema: { type: 'object' },
      gating: { profile: 'charge', executionMapping: {}, staticExecution: {}, category: 'read' } as unknown as DiscoveredTool['gating'],
    },
  ];
  const integrationManager = { getAllTools: () => tools, callTool, isBuiltin: () => false } as unknown as IntegrationManager;
  return { integrationManager, callTool };
}

describe('resolveInsertValue', () => {
  it('reads the declared path and accepts an https URL on an allowed host', async () => {
    const { integrationManager } = buildIntegrationManager({
      _links: { paymentLink: { href: 'https://paymentlink.mollie.com/payment/abc/xyz' } },
    });
    const result = await resolveInsertValue(integrationManager, { placeholder: '{{link}}', connector: 'mollie', kind: 'payment-link', id: 'pl_1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.insert.value).toBe('https://paymentlink.mollie.com/payment/abc/xyz');
  });

  it('accepts a subdomain of an allowed host', async () => {
    const { integrationManager } = buildIntegrationManager({
      _links: { paymentLink: { href: 'https://www.mollie.com/foo' } },
    });
    const result = await resolveInsertValue(integrationManager, { placeholder: '{{link}}', connector: 'mollie', kind: 'payment-link', id: 'pl_1' });
    expect(result.ok).toBe(true);
  });

  it('refuses a value on a host not in allowedHosts', async () => {
    const { integrationManager } = buildIntegrationManager({
      _links: { paymentLink: { href: 'https://evil.example.com/payment/abc' } },
    });
    const result = await resolveInsertValue(integrationManager, { placeholder: '{{link}}', connector: 'mollie', kind: 'payment-link', id: 'pl_1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('DISALLOWED_HOST');
  });

  it('refuses a non-https value', async () => {
    const { integrationManager } = buildIntegrationManager({
      _links: { paymentLink: { href: 'http://paymentlink.mollie.com/payment/abc' } },
    });
    const result = await resolveInsertValue(integrationManager, { placeholder: '{{link}}', connector: 'mollie', kind: 'payment-link', id: 'pl_1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_HTTPS');
  });

  it('refuses an undeclared value kind', async () => {
    const { integrationManager } = buildIntegrationManager({});
    const result = await resolveInsertValue(integrationManager, { placeholder: '{{link}}', connector: 'mollie', kind: 'not-a-kind', id: 'pl_1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNDECLARED_KIND');
  });
});

describe('applyInserts', () => {
  const insert: ResolvedInsert = { placeholder: '{{zahlungslink}}', value: 'https://paymentlink.mollie.com/x', connector: 'mollie', kind: 'payment-link' };

  it('substitutes a matched placeholder into the text', () => {
    const result = applyInserts({ body: 'Pay here: {{zahlungslink}}' }, [insert]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.fields.body).toBe('Pay here: https://paymentlink.mollie.com/x');
  });

  it('refuses a placeholder in the text with no matching insert', () => {
    const result = applyInserts({ body: 'Pay here: {{zahlungslink}}' }, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNMATCHED_PLACEHOLDER');
  });

  it('refuses an insert whose placeholder is missing from the text', () => {
    const result = applyInserts({ body: 'No placeholder here.' }, [insert]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PLACEHOLDER_NOT_FOUND');
  });

  it('substitutes across multiple fields and multiple inserts', () => {
    const second: ResolvedInsert = { placeholder: '{{other}}', value: 'VALUE2', connector: 'mollie', kind: 'payment-link' };
    const result = applyInserts(
      { subject: 'Re: {{other}}', body: 'Link: {{zahlungslink}}' },
      [insert, second],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fields.subject).toBe('Re: VALUE2');
      expect(result.fields.body).toBe('Link: https://paymentlink.mollie.com/x');
    }
  });
});
