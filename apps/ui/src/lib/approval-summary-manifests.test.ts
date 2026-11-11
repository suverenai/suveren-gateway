/**
 * The approved title rule (Andreas, 2026-11-11), end to end through the real
 * bundled manifests and the card's own preview read: "Change price of
 * Beratungsstunde: 130.00 EUR, VAT 20 %" — the name alone, the currency from
 * the manifest's display.currencyField, read from the card's read.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IntegrationManifest, PreviewResponse } from './sp-client';
import { approvalSummary } from './approval-summary';
import { summaryPreviewFrom } from './preview-store';

const dir = join(import.meta.dirname, '..', '..', '..', '..', 'content', 'integrations');
const erp = JSON.parse(readFileSync(join(dir, 'erp.json'), 'utf8')) as IntegrationManifest;

const ID = '62953e2e-41d8-4b6e-9a1f-0c5d2e8b7a64';
const preview = {
  status: 'ok', integration: 'erp', tool: 'get_item', readAt: 0, body: {},
  reads: [{ tool: 'get_item', attach: 'id', result: { status: 'ok', body: { structured: { id: ID, name: 'Beratungsstunde', currency: 'EUR', list_price: 120, vat_rate: 20, revision: 3 } } } }],
} as unknown as PreviewResponse;

describe('erp item titles through the bundled manifest', () => {
  it('price change: name only, money in the card format with the read\'s currency', () => {
    const args = { id: ID, revision: 3, list_price: 130, vat_rate: 20 };
    expect(approvalSummary('erp__update_item_price', args, [erp], undefined, summaryPreviewFrom(preview, args)))
      .toBe('Change price of Beratungsstunde: 130.00 EUR, VAT 20 %');
  });
  it('item change: name only', () => {
    const args = { id: ID, revision: 3, active: false };
    expect(approvalSummary('erp__update_item', args, [erp], undefined, summaryPreviewFrom(preview, args))).toBe('Change item Beratungsstunde');
  });
});
