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
    const { im } = erpDouble({ check_vat_id: vatCheck('valid') });
    const r = await buildInternalPreview(im, 'erp', 'create_customer', args);
    expect(checksOf(r)).toEqual([
      ['vat-format', 'pass', null],
      ['vies', 'pass', 'checked 2026-10-21'],
      ['duplicate', 'pass', null],
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
    tax_mode: { now: 'normal', after: 'reverse_charge' },
    issued_documents: { invoices: 4, credit_notes: 1, last_number: '2026-014' }, open_quotes: 1,
    vat_check: { uid: 'DE123456789', format: 'ok', duplicate: false, duplicate_of: null,
      vies: { status: 'valid', reason: null, checked_at: '2026-10-21T09:15:00Z', request_id: 'R1', name: null, address: null } },
    ...over,
  });
  const args = { id: 'c1', revision: 3, name: 'Steiner GmbH', address_lines: ['a'], country: 'DE', uid: 'DE123456789' };

  it('shows VIES, tax-mode change and "already issued — they keep the old data"', async () => {
    const { im } = erpDouble({ preview_customer_change: change({}) });
    const r = await buildInternalPreview(im, 'erp', 'update_customer_tax_data', args);
    expect(checksOf(r)).toEqual([
      ['vies', 'pass', 'checked 2026-10-21'],
      ['duplicate', 'pass', null],
      ['tax-mode', 'notice', 'normal → reverse_charge'],
      ['already-invoiced', 'notice', '4 invoices, 1 credit notes — they keep the old data'],
    ]);
  });

  it('only the address changed → no already-issued line', async () => {
    const { im } = erpDouble({ preview_customer_change: change({ uid_or_country_changed: false, tax_mode: { now: 'normal', after: 'normal' } }) });
    const r = await buildInternalPreview(im, 'erp', 'update_customer_tax_data', args);
    expect(checksOf(r).map((c) => c[0])).not.toContain('already-invoiced');
  });
});

describe('create_invoice card — catalogue deviation (§5.3) and D2', () => {
  const customer: Answer = () => ({ id: 'c1', name: 'Steiner GmbH', uid: 'ATU12345678', revision: 2,
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
      ['vies', 'not_checked', 'VIES unreachable'],
      ['list-price', 'notice', 'line 1: 95.00 EUR — list price 120.00 EUR'],
      ['item-vat', 'pass', 'line 1: 20% — item 20%'],
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
  it('shipped erp.json: no AU4 hash over the VIES read; the customer is created', async () => {
    const { result, complete, callTool, previewHash } = await approveThenExecute();
    expect(previewHash).toBeUndefined();
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
