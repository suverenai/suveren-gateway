/**
 * ERP local-production contract — Part D against the SHIPPED erp.json and the
 * real profiles: the card's checks (D1), `when` on preview reads + absent
 * args omitted (D2), and amendment AM1 (the VIES read is display-only, so an
 * approval survives a second VIES answer). The connector is a double that
 * answers with the contract's shapes (§3.4); the gateway's own preview,
 * check and execution code runs for real.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { clearProfiles } from '@hap/core';
import { loadProfiles } from '../src/lib/profile-loader';
import { loadManifests, getManifest } from '../src/lib/manifest-loader';
import { buildInternalPreview, computeSubmissionPreviewHash, mapPreviewArgs } from '../src/lib/preview';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import type { CheckResult } from '../src/lib/tool-gating-types';
import { ensureMasterDataProfile } from './helpers/master-data-standin';

const MANIFESTS_DIR = join(import.meta.dirname, '..', '..', '..', 'content', 'integrations');
const PROFILES_DIR = process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');

beforeAll(() => {
  loadProfiles(PROFILES_DIR);
  ensureMasterDataProfile(); // TEMPORARY — see the helper
  loadManifests(MANIFESTS_DIR);
});
afterAll(() => clearProfiles());

const tool = (name: string): DiscoveredTool => ({
  originalName: name, namespacedName: `erp__${name}`, integrationId: 'erp',
  description: '', inputSchema: { type: 'object' }, gating: null,
} as unknown as DiscoveredTool);

type Answer = (args: Record<string, unknown>) => Record<string, unknown> | undefined;

/** A connector double: each tool answers with the contract's shape. */
export function erpDouble(answers: Record<string, Answer>) {
  const callTool = vi.fn().mockImplementation(async (_i: string, name: string, args: Record<string, unknown>) => {
    const answer = answers[name]?.(args);
    if (!answer) return { isError: true, content: [{ type: 'text', text: `No ${name} for ${JSON.stringify(args)}` }] };
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: answer };
  });
  const tools = [...Object.keys(answers), 'create_customer', 'create_invoice'].map(tool);
  const im = { getAllTools: () => tools, callTool, isBuiltin: () => false } as unknown as IntegrationManager;
  return { im, callTool };
}

export const vatCheck = (status: string, extra: Record<string, unknown> = {}): Answer => (args) => ({
  uid: args.uid, format: 'ok', duplicate: false, duplicate_of: null,
  vies: { status, reason: null, checked_at: '2026-10-21T09:15:00Z', request_id: 'WAPIAAAA1', name: null, address: null, ...extra },
});

/** check_customer_duplicates (hap-erp-mcp #33): the customer id holding each, or null. */
export const dups = (vat: string | null = null, crm: string | null = null): Answer => (a) => ({
  uid: a.uid ?? null, crm_contact_id: a.crm_contact_id ?? null, vat_duplicate_of: vat, crm_contact_duplicate_of: crm });

const checksOf = (r: { checks?: CheckResult[] }) => (r.checks ?? []).map((c) => [c.key, c.status, c.detail ?? c.reason ?? null]);

describe('erp.json loads with the new declarations', () => {
  it('is not refused, declares the VIES outside call and the quote-pdf document', () => {
    const m = getManifest('erp');
    expect(m).toBeDefined();
    expect(m!.network).toEqual([expect.objectContaining({ host: 'ec.europa.eu', modes: { live: ['local'] } })]);
    expect(m!.documents?.['quote-pdf']).toMatchObject({ tool: 'get_document', args: { kind: 'quote-pdf', id: '$id' } });
  });

  it('customer + catalogue writes live in master-data only (R9: no readAlsoUnder on a write)', () => {
    const o = getManifest('erp')!.toolGating.overrides as Record<string, { profile?: string; category?: string; readAlsoUnder?: string[]; staticExecution?: Record<string, unknown> }>;
    const writes = { create_customer: 'customer_create', update_customer: 'customer_update', update_customer_tax_data: 'customer_tax',
      create_item: 'item_create', update_item: 'item_update', update_item_price: 'item_price' };
    for (const [t, actionType] of Object.entries(writes)) {
      expect(o[t].profile, t).toBe('master-data');
      expect(o[t].staticExecution?.action_type, t).toBe(actionType);
    }
    for (const [t, e] of Object.entries(o)) {
      if (e && e.category !== 'read') expect(e.readAlsoUnder, t).toBeUndefined();
    }
  });
});

describe('create_customer card — VIES checks (D1, R3, R5)', () => {
  const args = { name: 'Steiner GmbH', address_lines: ['Hauptstr. 1', '1010 Wien'], country: 'AT', uid: 'ATU12345678' };

  it('valid → three passing checks, VIES line labelled with its time', async () => {
    const { im } = erpDouble({ check_vat_id: vatCheck('valid'), check_customer_duplicates: dups() });
    const r = await buildInternalPreview(im, 'erp', 'create_customer', args);
    expect(checksOf(r)).toEqual([
      ['vat-format', 'pass', null],
      ['vies', 'pass', 'checked 2026-10-21'],
      ['vat-duplicate', 'pass', null],
    ]);
  });

  it('VIES unreachable → "not checked" with the reason and the outage sentence; nothing fails', async () => {
    const { im } = erpDouble({ check_vat_id: vatCheck('not_checked', { checked_at: null, reason: 'VIES unreachable (timeout after 4 s)' }) });
    const r = await buildInternalPreview(im, 'erp', 'create_customer', args);
    expect(checksOf(r)).toContainEqual(['vies', 'not_checked', 'VIES unreachable (timeout after 4 s) — saving is not blocked while VIES is unreachable']);
    expect((r.checks ?? []).some((c) => c.status === 'fail')).toBe(false);
  });

  it('VIES invalid → fail', async () => {
    const { im } = erpDouble({ check_vat_id: vatCheck('invalid') });
    const r = await buildInternalPreview(im, 'erp', 'create_customer', args);
    expect(checksOf(r)).toContainEqual(['vies', 'fail', 'checked 2026-10-21']);
  });

  it('D2: no uid (or uid null) → check_vat_id is never called and no VAT check line appears', async () => {
    const { im, callTool } = erpDouble({ check_vat_id: vatCheck('valid') });
    for (const noUid of [{ name: 'X', address_lines: ['a'], country: 'AT' }, { name: 'X', address_lines: ['a'], country: 'AT', uid: null }]) {
      const r = await buildInternalPreview(im, 'erp', 'create_customer', noUid);
      expect(r.checks ?? []).toEqual([]);
    }
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('update_customer_tax_data card — own line for already-issued documents (R4)', () => {
  const change = (over: Record<string, unknown>): Answer => () => ({
    current: { name: 'Steiner GmbH', address_lines: ['a'], country: 'AT', uid: 'ATU12345678', revision: 3 },
    revision: 3, changed: ['uid', 'country'], uid_or_country_changed: true,
    tax_mode: { now: 'normal', after: 'reverse_charge', now_label: 'normal VAT', after_label: 'reverse charge' },
    issued_documents: { invoices: 4, credit_notes: 1, last_number: '2026-014' }, open_quotes: 1,
    vat_check: { uid: 'DE123456789', format: 'ok', duplicate: false, duplicate_of: null,
      vies: { status: 'valid', reason: null, checked_at: '2026-10-21T09:15:00Z', request_id: 'R1', name: null, address: null } },
    ...over,
  });
  const args = { id: 'c1', revision: 3, name: 'Steiner GmbH', address_lines: ['a'], country: 'DE', uid: 'DE123456789' };

  it('shows VIES, tax-mode change and "already issued — they keep the old data"', async () => {
    const { im } = erpDouble({ preview_customer_change: change({}), check_customer_duplicates: dups() });
    const r = await buildInternalPreview(im, 'erp', 'update_customer_tax_data', args);
    expect(checksOf(r)).toEqual([
      ['vies', 'pass', 'checked 2026-10-21'],
      ['vat-duplicate', 'pass', null],
      ['tax-mode', 'notice', 'normal VAT → reverse charge'],
      ['already-invoiced', 'notice', '4 invoices, 1 credit notes — they keep the old data'],
    ]);
  });

  it('only the address changed → no already-issued line', async () => {
    const { im } = erpDouble({ preview_customer_change: change({ uid_or_country_changed: false, tax_mode: { now: 'normal', after: 'normal', now_label: 'normal VAT', after_label: 'normal VAT' } }) });
    const r = await buildInternalPreview(im, 'erp', 'update_customer_tax_data', args);
    expect(checksOf(r).map((c) => c[0])).not.toContain('already-invoiced');
  });
});

describe('create_invoice card — catalogue deviation (§5.3) and D2', () => {
  const customer: Answer = () => ({ id: 'c1', name: 'Steiner GmbH', uid: 'ATU12345678', revision: 2,
    tax_mode: 'normal', tax_mode_label: 'normal VAT', vies_status: 'not_checked',
    vies: { status: 'not_checked', reason: 'VIES unreachable', checked_at: null } });
  const item: Answer = (a) => (a.id === 'i1' ? { id: 'i1', list_price: 120, vat_rate: 20, revision: 1 } : undefined);
  const args = {
    customer_id: 'c1', number: '2026-015', document_date: '2026-10-21', currency: 'EUR', net_total: 145,
    customer_revision: null,
    lines: [
      { item_id: 'i1', description: 'Beratung', qty: 1, unit_price: 95, vat_rate: 20 },
      { description: 'Fahrtkosten', qty: 1, unit_price: 50, vat_rate: 20 },
    ],
  };

  it('line priced off the list → notice naming both prices; stored "not checked" VIES shows', async () => {
    const { im } = erpDouble({ get_customer: customer, get_item: item, preview_invoice: () => ({ filename: 'x.pdf' }) });
    const r = await buildInternalPreview(im, 'erp', 'create_invoice', args);
    expect(checksOf(r)).toEqual([
      ['tax-supported', 'pass', 'normal VAT'],
      ['vies', 'not_checked', 'VIES unreachable'],
      ['list-price', 'notice', 'line 1: 95.00 EUR, list price 120.00 EUR'],
      ['item-vat', 'pass', 'line 1: 20%, item 20%'],
    ]);
  });

  it('D2: get_item only for lines with an item; get_quote not called without quote_id; null args never sent', async () => {
    const { im, callTool } = erpDouble({ get_customer: customer, get_item: item, get_quote: () => ({}), preview_invoice: () => ({ filename: 'x.pdf' }) });
    await buildInternalPreview(im, 'erp', 'create_invoice', args);
    const calls = callTool.mock.calls.map((c) => [c[1], c[2]]);
    expect(calls.filter((c) => c[0] === 'get_item')).toEqual([['get_item', { id: 'i1' }]]);
    expect(calls.some((c) => c[0] === 'get_quote')).toBe(false);
    for (const [, sent] of calls) expect(Object.values(sent as object)).not.toContain(null);
    expect(calls.find((c) => c[0] === 'get_customer')![1]).toEqual({ id: 'c1' });
  });

  it('mapPreviewArgs omits absent AND null sources', () => {
    expect(mapPreviewArgs({ args: { id: 'a', revision: 'r', x: 'x' } }, { a: 1, r: null })).toEqual({ id: 1 });
  });
});

// ─── AM1 — the VIES read is display-only: an approval survives a new answer ──

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { executeCommitted } from '../src/tools/commitments';
import type { SharedState } from '../src/lib/shared-state';
import type { SPProposal } from '../src/lib/sp-client';
import { testReceiptKeypair, makeSignedReceipt } from './helpers/real-receipt';
import { hashToolArgs } from '../src/lib/execution-journal';

const CUSTOMER_ARGS = { name: 'Steiner GmbH', address_lines: ['Hauptstr. 1', '1010 Wien'], country: 'AT', uid: 'ATU12345678' };
const PROPOSAL: SPProposal = {
  id: 'prop-am1', authorizationId: 'authz_md', profileId: 'master-data', path: 'master-data@0.1',
  pendingDomains: [], committedBy: { owner: { userId: 'andreas', at: 0 } }, rejectedBy: null,
  tool: 'erp__create_customer', toolArgs: CUSTOMER_ARGS, executionContext: { action_type: 'customer_create' },
  status: 'committed', executionResult: null, createdAt: 0, expiresAt: 0,
};

function executionState(previewHash: string | undefined) {
  const kp = testReceiptKeypair();
  const complete = vi.fn();
  const state = {
    spClient: { postReceipt: vi.fn().mockImplementation(async (req: Record<string, unknown>) => ({
      receipt: makeSignedReceipt(kp, { id: 'rcpt-am1', action: req.action as string, executionContext: (req.executionContext ?? {}) as Record<string, unknown>,
        authorizationId: req.authorizationId as string, profileId: req.profileId as string, proposalId: req.proposalId as string,
        // The AS signs the binding the gateway asked for (master-data binds the whole arguments).
        ...(req.contentHash ? { contentHash: req.contentHash, contentBinding: req.contentBinding } : {}) }),
    })) },
    proposalSubmissions: {
      get: () => ({ proposalId: PROPOSAL.id, tool: PROPOSAL.tool, toolArgsHash: hashToolArgs(PROPOSAL.toolArgs),
        executionContextHash: hashToolArgs(PROPOSAL.executionContext), authorizationId: PROPOSAL.authorizationId,
        profileId: PROPOSAL.profileId, submittedAt: Math.floor(Date.now() / 1000), previewHash }),
      record: vi.fn(),
    },
    cache: {
      getPublicKey: async () => kp.publicKeyHex,
      getTrustedIssuer: async () => kp.issuer,
      getAllAuthorizations: () => [{ authorizationId: 'authz_md', profileId: 'master-data', path: 'master-data@0.1', frame: {},
        attestations: [], requiredDomains: [], attestedDomains: [], deferredCommitmentDomains: [], complete: true }],
    },
    executionLog: { record: vi.fn() },
    archiveReceipt: vi.fn().mockResolvedValue(undefined),
    executionJournal: { begin: () => ({ ok: true }), complete },
  } as unknown as SharedState;
  return { state, complete };
}

/** VIES answers differently on every call: new consultation id, status flips. */
function flippingVies() {
  let n = 0;
  return erpDouble({
    check_vat_id: (a) => { n += 1; return vatCheck(n === 1 ? 'valid' : 'not_checked', { request_id: `WAPI-${n}` })(a); },
    check_customer_duplicates: dups(),
    create_customer: () => ({ id: 'cust-new', revision: 1 }),
  });
}

async function approveThenExecute() {
  const { im, callTool } = flippingVies();
  const previewHash = await computeSubmissionPreviewHash(im, 'erp', 'create_customer', CUSTOMER_ARGS); // at proposal
  await buildInternalPreview(im, 'erp', 'create_customer', CUSTOMER_ARGS); // the approver's card: a second VIES answer
  const { state, complete } = executionState(previewHash);
  const result = await executeCommitted(PROPOSAL, state, im);
  return { result, complete, callTool, previewHash };
}

describe('AM1 — create_customer approval survives a second VIES call', () => {
  it('shipped erp.json: the VIES read is not in the AU4 hash (only the stable duplicates read is); the customer is created', async () => {
    const { result, complete, callTool } = await approveThenExecute();
    expect(result.isError).toBeFalsy();
    expect(callTool).toHaveBeenCalledWith('erp', 'create_customer', expect.objectContaining({ uid: 'ATU12345678' }));
    expect(complete).toHaveBeenCalledWith('rcpt-am1', 'done');
  });

  it('control: the same manifest WITHOUT displayOnly refuses as "changed" — the flag is what makes it pass', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hap-am1-'));
    try {
      const erp = JSON.parse(readFileSync(join(MANIFESTS_DIR, 'erp.json'), 'utf8'));
      delete erp.toolGating.overrides.create_customer.preview[0].displayOnly;
      mkdirSync(join(dir, 'erp'));
      writeFileSync(join(dir, 'index.json'), JSON.stringify({ integrations: { erp: 'erp/manifest.json' } }));
      writeFileSync(join(dir, 'erp/manifest.json'), JSON.stringify(erp));
      loadManifests(dir);
      const { result, complete, callTool, previewHash } = await approveThenExecute();
      expect(previewHash).toBeDefined();
      expect(result.isError).toBe(true);
      expect(callTool).not.toHaveBeenCalledWith('erp', 'create_customer', expect.anything());
      expect(complete).toHaveBeenCalledWith('rcpt-am1', 'failed', 'changed', expect.any(String));
    } finally {
      loadManifests(MANIFESTS_DIR);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('create_invoice card — decision D1: reverse charge only with a VIES-confirmed VAT ID', () => {
  // Shape of erp-mcp feat/local-production get_customer: tax_mode, tax_mode_label, vies_status (null = never checked), vies.
  const customer = (tax_mode: string, vies: Record<string, unknown> | null): Answer => () => ({
    id: 'c9', name: 'Agrar Bayern GmbH', country: 'DE', uid: 'DE123456789', revision: 1,
    tax_mode, tax_mode_label: tax_mode === 'reverse_charge' ? 'reverse charge' : 'normal VAT',
    vies_status: vies ? vies.status : null, vies });
  const args = { customer_id: 'c9', number: '2026-016', document_date: '2026-10-21', currency: 'EUR', net_total: 100,
    lines: [{ description: 'Beratung', qty: 1, unit_price: 100, vat_rate: 0 }] };
  const rc = async (c: Answer) => {
    const { im } = erpDouble({ get_customer: c, preview_invoice: () => ({ filename: 'x.pdf' }) });
    return checksOf(await buildInternalPreview(im, 'erp', 'create_invoice', args)).filter((x) => x[0] === 'reverse-charge');
  };

  it('reverse charge + VIES not checked → a FAILED check on the card (preview passes, issuing would refuse)', async () => {
    expect(await rc(customer('reverse_charge', { status: 'not_checked', reason: 'VIES unreachable', checked_at: null })))
      .toEqual([['reverse-charge', 'fail', 'VIES unreachable']]);
  });

  it('reverse charge + never checked (vies null) → failed too, never "missing"', async () => {
    expect((await rc(customer('reverse_charge', null)))[0][1]).toBe('fail');
  });

  it('reverse charge + valid → pass; a normal-VAT customer gets no reverse-charge line', async () => {
    expect(await rc(customer('reverse_charge', { status: 'valid', reason: null, checked_at: '2026-10-20T08:00:00Z' }))).toEqual([['reverse-charge', 'pass', null]]);
    expect(await rc(customer('normal', { status: 'not_checked', reason: 'x', checked_at: null }))).toEqual([]);
  });
});

describe('create_quote / update_quote — the quote PDF as it will be issued (D3: no send_quote step in Local)', () => {
  const pdf: Answer = () => ({ filename: 'A-2026-001-r1.pdf', contentType: 'application/pdf', contentBase64: 'JVBERi0=', sha256: 'x', pages: 1 });
  it('create_quote: preview_quote gets exactly the create args, absent ones omitted', async () => {
    const { im, callTool } = erpDouble({ get_customer: () => ({ id: 'c1' }), preview_quote: pdf });
    const args = { customer_id: 'c1', number: 'S-A-2026-001', document_date: '2026-10-21', value: 120, discount_pct: 0, currency: 'EUR',
      lines: [{ description: 'Beratung', qty: 1, unit_price: 120, vat_rate: 20 }] };
    const r = await buildInternalPreview(im, 'erp', 'create_quote', args) as { reads?: Array<{ tool: string; kind?: string; result?: { status: string } }> };
    expect(callTool).toHaveBeenCalledWith('erp', 'preview_quote', args);
    expect(r.reads?.find((x) => x.tool === 'preview_quote')).toMatchObject({ kind: 'document', result: { status: 'ok' } });
  });

  it('simulation create_quote (no document_date) never calls preview_quote', async () => {
    const { im, callTool } = erpDouble({ get_customer: () => ({ id: 'c1' }), preview_quote: pdf });
    await buildInternalPreview(im, 'erp', 'create_quote', { customer_id: 'c1', lines: [], value: 0, discount_pct: 0, currency: 'EUR' });
    expect(callTool.mock.calls.some((c) => c[1] === 'preview_quote')).toBe(false);
  });

  it('update_quote: preview_quote gets id + revision + the new content', async () => {
    const { im, callTool } = erpDouble({ get_quote: () => ({ id: 'q1', revision: 2 }), preview_quote: pdf });
    await buildInternalPreview(im, 'erp', 'update_quote', { id: 'q1', revision: 2, document_date: '2026-10-21', value: 90, discount_pct: 0, currency: 'EUR' });
    expect(callTool).toHaveBeenCalledWith('erp', 'preview_quote', { id: 'q1', revision: 2, document_date: '2026-10-21', value: 90, discount_pct: 0, currency: 'EUR' });
  });

  it('quote-pdf document and preview_quote are internal; Local quote tools stay under sales', () => {
    const o = getManifest('erp')!.toolGating.overrides as Record<string, { profile?: string; internal?: boolean; staticExecution?: Record<string, unknown> }>;
    expect(o.preview_quote.internal).toBe(true);
    expect(o.create_quote.profile).toBeUndefined(); // manifest profile = sales
    expect(o.create_quote.staticExecution?.action_type).toBe('quote');
    expect(o.update_quote.staticExecution?.action_type).toBe('quote');
  });
});

// ─── Blocking checks in erp.json (decision 2026-10-21) ─────────────────────

import { createGatedToolHandler } from '../src/lib/tool-proxy';
import { reviewHarness } from './helpers/review-harness';

const erpTool = (name: string, profile: string, actionType: string): DiscoveredTool => ({
  ...tool(name),
  gating: { profile, executionMapping: {}, staticExecution: { action_type: actionType } } as unknown as DiscoveredTool['gating'],
});
const MD = 'github.com/humanagencyprotocol/hap-profiles/master-data@0.1';
const refusalText = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;

describe('erp.json blocking checks — refused before any card', () => {
  const CREATE = erpTool('create_customer', 'master-data', 'customer_create');
  const args = { name: 'Alpen Agrar GmbH', address_lines: ['Dorfplatz 1'], country: 'AT', uid: 'ATU99999999' };

  it('create_customer: VIES "invalid" → refused, no proposal, on the Blocked page', async () => {
    const h = reviewHarness(MD, [CREATE, tool('check_vat_id')], (t, a) => (t === 'check_vat_id' ? vatCheck('invalid')(a) : undefined));
    const r = await createGatedToolHandler(CREATE, h.im, h.state)({ ...args });
    expect(refusalText(r)).toMatch(/^Refused: VAT ID confirmed by VIES: failed \(invalid\) — checked 2026-10-21\. Nothing was proposed/);
    expect(h.submitProposal).not.toHaveBeenCalled();
    expect(h.denials).toHaveBeenCalledWith(expect.objectContaining({ kind: 'check', code: 'CHECK_FAILED', field: 'vies' }));
  });

  it('create_customer: VIES unreachable ("not_checked") → never blocks; a card is made', async () => {
    const h = reviewHarness(MD, [CREATE, tool('check_vat_id')], (t, a) => (t === 'check_vat_id' ? vatCheck('not_checked', { reason: 'VIES unreachable' })(a) : undefined));
    await createGatedToolHandler(CREATE, h.im, h.state)({ ...args });
    expect(h.submitProposal).toHaveBeenCalledOnce();
    expect(h.denials).not.toHaveBeenCalled();
  });

  it('update_customer_tax_data: new VAT ID "invalid" → refused', async () => {
    const T = erpTool('update_customer_tax_data', 'master-data', 'customer_tax');
    const h = reviewHarness(MD, [T, tool('preview_customer_change')], (t) => (t === 'preview_customer_change'
      ? { revision: 3, uid_or_country_changed: true, tax_mode: { now: 'normal', after: 'normal', now_label: 'n', after_label: 'n' },
          issued_documents: { invoices: 0, credit_notes: 0 },
          vat_check: { format: 'ok', duplicate: false, vies: { status: 'invalid', checked_at: '2026-10-21T09:00:00Z', reason: null } } }
      : undefined));
    const r = await createGatedToolHandler(T, h.im, h.state)({ id: 'c1', revision: 3, name: 'X', address_lines: ['a'], country: 'AT', uid: 'ATU99999999' });
    expect(refusalText(r)).toMatch(/^Refused: New VAT ID confirmed by VIES: failed \(invalid\)/);
    expect(h.submitProposal).not.toHaveBeenCalled();
  });

  it('create_invoice (also a quote conversion): reverse charge without VIES "valid" → refused (D1)', async () => {
    const INV = erpTool('create_invoice', 'invoicing', 'invoice');
    const inv = 'github.com/humanagencyprotocol/hap-profiles/invoicing@0.1';
    const h = reviewHarness(inv, [INV, tool('get_customer'), tool('get_quote'), tool('preview_invoice')], (t) => {
      if (t === 'get_customer') return { id: 'c9', uid: 'DE123456789', tax_mode: 'reverse_charge', vies_status: 'not_checked',
        vies: { status: 'not_checked', reason: 'VIES unreachable', checked_at: null } };
      if (t === 'get_quote') return { id: 'q1', revision: 2 };
      if (t === 'preview_invoice') return { filename: 'x.pdf' };
      return undefined;
    });
    const r = await createGatedToolHandler(INV, h.im, h.state)({ customer_id: 'c9', quote_id: 'q1', quote_revision: 2,
      number: '2026-016', document_date: '2026-10-21', net_total: 100, currency: 'EUR' });
    expect(refusalText(r)).toMatch(/^Refused: Reverse charge: VAT ID confirmed by VIES: failed \(not_checked\) — VIES unreachable\./);
    expect(h.submitProposal).not.toHaveBeenCalled();
  });
});

describe('erp.json — duplicates are refused before a card (R10: the connector would refuse them for sure)', () => {
  const C = erpTool('create_customer', 'master-data', 'customer_create');
  const answer = (vat: string | null, crm: string | null) => (t: string, a: Record<string, unknown>) =>
    t === 'check_vat_id' ? vatCheck('valid')(a) : t === 'check_customer_duplicates' ? dups(vat, crm)(a) : undefined;

  it('create_customer: another customer has this VAT ID → refused, naming the existing customer', async () => {
    const h = reviewHarness(MD, [C, tool('check_vat_id'), tool('check_customer_duplicates')], answer('cust-17', null));
    const r = await createGatedToolHandler(C, h.im, h.state)({ name: 'X', address_lines: ['a'], country: 'AT', uid: 'ATU12345678' });
    expect(refusalText(r)).toMatch(/^Refused: No other customer with this VAT ID: failed \(cust-17\) — already customer cust-17\./);
    expect(h.submitProposal).not.toHaveBeenCalled();
  });

  it('create_customer: the CRM contact already has a customer → refused', async () => {
    const h = reviewHarness(MD, [C, tool('check_vat_id'), tool('check_customer_duplicates')], answer(null, 'cust-9'));
    const r = await createGatedToolHandler(C, h.im, h.state)({ name: 'X', address_lines: ['a'], country: 'AT', crm_contact_id: 'crm-4' });
    expect(refusalText(r)).toMatch(/^Refused: No other customer for this CRM contact: failed \(cust-9\) — already customer cust-9\./);
    expect(h.submitProposal).not.toHaveBeenCalled();
  });

  it('create_customer: no duplicates → a card', async () => {
    const h = reviewHarness(MD, [C, tool('check_vat_id'), tool('check_customer_duplicates')], answer(null, null));
    await createGatedToolHandler(C, h.im, h.state)({ name: 'X', address_lines: ['a'], country: 'AT', uid: 'ATU12345678', crm_contact_id: 'crm-4' });
    expect(h.submitProposal).toHaveBeenCalledOnce();
  });

  it('update_customer: linking a CRM contact another customer has → refused; the read excludes this customer', async () => {
    const U = erpTool('update_customer', 'master-data', 'customer_update');
    const h = reviewHarness(MD, [U, tool('get_customer'), tool('check_customer_duplicates')], (t, a) =>
      t === 'get_customer' ? { id: 'c1', revision: 2 } : t === 'check_customer_duplicates' ? dups(null, 'cust-9')(a) : undefined);
    const r = await createGatedToolHandler(U, h.im, h.state)({ id: 'c1', revision: 2, crm_contact_id: 'crm-4' });
    expect(refusalText(r)).toMatch(/^Refused: No other customer for this CRM contact/);
    expect(h.callTool).toHaveBeenCalledWith('erp', 'check_customer_duplicates', { crm_contact_id: 'crm-4', id: 'c1' });
  });

  it('update_customer_tax_data: the new VAT ID belongs to another customer → refused', async () => {
    const T = erpTool('update_customer_tax_data', 'master-data', 'customer_tax');
    const h = reviewHarness(MD, [T, tool('preview_customer_change'), tool('check_customer_duplicates')], (t, a) => (t === 'preview_customer_change'
      ? { revision: 3, uid_or_country_changed: true, tax_mode: { now: 'normal', after: 'normal', now_label: 'n', after_label: 'n' },
          issued_documents: { invoices: 0, credit_notes: 0 },
          vat_check: { format: 'ok', vies: { status: 'valid', checked_at: null, reason: null } } }
      : t === 'check_customer_duplicates' ? dups('cust-17')(a) : undefined));
    const r = await createGatedToolHandler(T, h.im, h.state)({ id: 'c1', revision: 3, name: 'X', address_lines: ['a'], country: 'AT', uid: 'ATU12345678' });
    expect(refusalText(r)).toMatch(/^Refused: No other customer with this VAT ID: failed \(cust-17\)/);
    expect(h.submitProposal).not.toHaveBeenCalled();
  });
});

describe('version staleness works for a connector that answers as JSON text only', () => {
  it('update_customer: a get_customer answered without structuredContent still reports stale', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ id: 'c1', revision: 5, email: 'a@b.at' }) }] });
    const im = { getAllTools: () => [tool('get_customer')], callTool, isBuiltin: () => false } as unknown as IntegrationManager;
    const r = await buildInternalPreview(im, 'erp', 'update_customer', { id: 'c1', revision: 4, email: 'new@b.at' }) as
      { reads?: Array<{ version?: { stale: boolean; approved: unknown; current: unknown } }> };
    expect(r.reads?.[0].version).toMatchObject({ stale: true, approved: 4, current: 5 });
  });
});

describe('erp.json — customers outside the EU VAT area (hap-erp-mcp #34: tax_mode "unsupported")', () => {
  const outside = { id: 'c-ch', name: 'Zürich AG', country: 'CH', uid: 'CHE-123', revision: 1,
    tax_mode: 'unsupported', tax_mode_label: 'Not supported (outside the EU)', vies_status: null, vies: null };

  it('create_invoice → refused before a card, with the label', async () => {
    const INV = erpTool('create_invoice', 'invoicing', 'invoice');
    const h = reviewHarness('github.com/humanagencyprotocol/hap-profiles/invoicing@0.1', [INV, tool('get_customer'), tool('preview_invoice')],
      (t) => (t === 'get_customer' ? outside : t === 'preview_invoice' ? { filename: 'x.pdf' } : undefined));
    const r = await createGatedToolHandler(INV, h.im, h.state)({ customer_id: 'c-ch', number: '2026-020', document_date: '2026-10-21', net_total: 10, currency: 'EUR' });
    expect(refusalText(r)).toMatch(/^Refused: Tax treatment supported for this customer: failed \(unsupported\) — Not supported \(outside the EU\)\./);
    expect(h.submitProposal).not.toHaveBeenCalled();
  });

  it('create_quote → refused before a card', async () => {
    const Q = erpTool('create_quote', 'sales', 'quote');
    const h = reviewHarness('github.com/humanagencyprotocol/hap-profiles/sales@0.4', [Q, tool('get_customer'), tool('preview_quote')],
      (t) => (t === 'get_customer' ? outside : t === 'preview_quote' ? { filename: 'q.pdf' } : undefined));
    const r = await createGatedToolHandler(Q, h.im, h.state)({ customer_id: 'c-ch', number: 'A-1', document_date: '2026-10-21', lines: [], value: 0, discount_pct: 0, currency: 'EUR' });
    expect(refusalText(r)).toMatch(/^Refused: Tax treatment supported for this customer: failed \(unsupported\)/);
    expect(h.submitProposal).not.toHaveBeenCalled();
  });

  it('a tax_mode value the manifest does not name is "not checked" on the card — never a pass, never a block', async () => {
    const { im } = erpDouble({ get_customer: () => ({ ...outside, tax_mode: 'something_new', tax_mode_label: 'New' }), preview_invoice: () => ({ filename: 'x.pdf' }) });
    const r = await buildInternalPreview(im, 'erp', 'create_invoice', { customer_id: 'c-ch', net_total: 1, currency: 'EUR' });
    expect(checksOf(r).find((c) => c[0] === 'tax-supported')).toEqual(['tax-supported', 'not_checked', 'New']);
  });
});

describe('erp.json — a VAT ID in the wrong format is refused before a card (the connector refuses it for sure, §3.3)', () => {
  it('create_customer: wrong prefix → refused', async () => {
    const C = erpTool('create_customer', 'master-data', 'customer_create');
    const h = reviewHarness(MD, [C, tool('check_vat_id'), tool('check_customer_duplicates')], (t, a) =>
      t === 'check_vat_id' ? { ...vatCheck('not_checked')(a)!, format: 'wrong_prefix' } : t === 'check_customer_duplicates' ? dups()(a) : undefined);
    const r = await createGatedToolHandler(C, h.im, h.state)({ name: 'X', address_lines: ['a'], country: 'AT', uid: 'DE99999999' });
    expect(refusalText(r)).toMatch(/^Refused: VAT ID format: failed \(wrong_prefix\)/);
    expect(h.submitProposal).not.toHaveBeenCalled();
  });
});
