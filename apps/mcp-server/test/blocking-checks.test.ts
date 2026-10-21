/**
 * Decision 2026-10-21 (Andreas): a manifest check declared `blocking` that
 * FAILS refuses the call in tool-proxy.ts — before any proposal or card —
 * through the existing refusal path (Blocked record, isError text to the AI).
 * `not_checked` (a read that cannot answer) never blocks.
 *
 * Genericity: the main fixture is NOT the ERP — a payments connector whose
 * payment-link amount must equal an invoice's gross from a preview read.
 * The handler, the preview reads and the check evaluation are the real
 * gateway code; the Authority Server, Gatekeeper verdict and connector are
 * doubles (same harness as au10-source-stripped.test.ts).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProfile, clearProfiles } from '@hap/core';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import { loadManifests } from '../src/lib/manifest-loader';
import type { DiscoveredTool } from '../src/lib/integration-manager';
import { reviewHarness } from './helpers/review-harness';

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/blocking-test@0.1';
let dir: string;

beforeAll(() => {
  registerProfile(PROFILE_ID, {
    id: PROFILE_ID, version: '0.1', description: 'test', executionContextSchema: { fields: {} },
    requiredGates: [], ttl: { default: 1, max: 1 }, retention_minimum: 1,
  } as never);
  registerProfile('blocking-test', { id: PROFILE_ID } as never);
  dir = mkdtempSync(join(tmpdir(), 'hap-blocking-checks-'));
  mkdirSync(join(dir, 'pay'));
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ integrations: { pay: 'pay/manifest.json' } }));
  writeFileSync(join(dir, 'pay/manifest.json'), JSON.stringify({
    id: 'pay', name: 'Payments', version: '1', description: 'test', icon: 'x', profile: 'blocking-test',
    mcp: { command: 'node', args: [] }, credentials: { fields: [], envMapping: {} }, oauth: null,
    toolGating: {
      default: { executionMapping: {}, staticExecution: {} },
      overrides: {
        get_invoice: { category: 'read', internal: true },
        create_payment_link: {
          executionMapping: {}, staticExecution: { action_type: 'link' },
          preview: [{ tool: 'get_invoice', args: { id: 'invoice_id' }, attach: 'invoice_id' }],
          checks: [{
            key: 'amount', label: 'Amount = invoice gross', path: 'amount', blocking: true,
            compare: { op: 'eq', to: 'invoice_id.gross' }, detail: '{amount|money}, invoice {invoice_id.gross|money}',
          }],
        },
      },
    },
  }));
  expect(loadManifests(dir)).toBe(1);
});

afterAll(() => { clearProfiles(); rmSync(dir, { recursive: true, force: true }); });

const TOOL: DiscoveredTool = {
  originalName: 'create_payment_link', namespacedName: 'pay__create_payment_link', integrationId: 'pay',
  description: '', inputSchema: { type: 'object' },
  gating: { profile: 'blocking-test', executionMapping: {}, staticExecution: { action_type: 'link' } } as unknown as DiscoveredTool['gating'],
};
const READ: DiscoveredTool = { ...TOOL, originalName: 'get_invoice', namespacedName: 'pay__get_invoice', gating: null } as DiscoveredTool;

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0].text);

describe('blocking checks — generic (non-ERP fixture)', () => {
  const invoice = (gross: number) => (tool: string) => (tool === 'get_invoice' ? { id: 'inv-1', gross } : undefined);

  it('amount differs from the invoice gross → refused, no proposal, recorded on the Blocked page', async () => {
    const h = reviewHarness(PROFILE_ID, [TOOL, READ], invoice(1080));
    const r = await createGatedToolHandler(TOOL, h.im, h.state)({ invoice_id: 'inv-1', amount: 1000, currency: 'EUR' });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(text(r)).toMatch(/^Refused: Amount = invoice gross: failed \(1000\) — 1000\.00 EUR, invoice 1080\.00 EUR\. Nothing was proposed/);
    expect(h.submitProposal).not.toHaveBeenCalled();
    expect(h.callTool).not.toHaveBeenCalledWith('pay', 'create_payment_link', expect.anything());
    expect(h.denials).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'check', code: 'CHECK_FAILED', field: 'amount', who: 'gateway', tool: 'create_payment_link',
      detail: 'Check failed: Amount = invoice gross.',
    }));
  });

  it('amount matches → a proposal (the card), nothing blocked', async () => {
    const h = reviewHarness(PROFILE_ID, [TOOL, READ], invoice(1000));
    const r = await createGatedToolHandler(TOOL, h.im, h.state)({ invoice_id: 'inv-1', amount: 1000, currency: 'EUR' });
    expect((r as { isError?: boolean }).isError).not.toBe(true);
    expect(h.submitProposal).toHaveBeenCalledOnce();
    expect(h.denials).not.toHaveBeenCalled();
  });

  it('the read cannot answer → never blocks (the card shows the gap instead)', async () => {
    const h = reviewHarness(PROFILE_ID, [TOOL, READ], () => undefined);
    await createGatedToolHandler(TOOL, h.im, h.state)({ invoice_id: 'inv-1', amount: 1000, currency: 'EUR' });
    expect(h.submitProposal).toHaveBeenCalledOnce();
    expect(h.denials).not.toHaveBeenCalled();
  });
});
