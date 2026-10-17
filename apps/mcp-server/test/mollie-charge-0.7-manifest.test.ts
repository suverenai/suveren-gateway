/**
 * Mollie's manifest rewritten for charge@0.7 ("Payments" — doc/payments-
 * billing-and-spend.md §11, approved by Andreas 2026-10-17): actionTypes
 * `charge` + `manage` only, `read_access` enum switch, `amount_max`
 * per_transaction of `amount` requiredFor `charge`. Invoices/credit notes
 * are Invoicing (ERP); refunds, subscriptions and outgoing money are not
 * covered — every tool Mollie's hosted MCP offers in those areas is
 * `category:"disabled"` here, not silently left to the (now dead, see
 * integration-manager.ts's `resolveToolGating`) manifest `default`.
 *
 * Profiles load the normal way: SUVEREN_PROFILES_DIR, else the sibling
 * hap-profiles checkout (as CI provides it) — the real index.json →
 * short-name registration path (profile-loader.ts).
 *
 * What this file pins, mirroring erp-invoicing-manifest.test.ts's own
 * stated scope: the DATA that makes hap-core's OWN (separately unit-
 * tested) bound enforcement land correctly for Mollie's tools — every
 * tool has an explicit entry, charge acts map `amount`, manage acts move
 * no money, reads that touch customer/payment data require
 * `read_access:unlimited`, and tools outside the profile's two action
 * types are refused. Real end-to-end refusal is exercised, through the
 * genuine `createGatedToolHandler` write/read paths, only where the
 * REFUSAL ITSELF is tool-proxy.ts's own responsibility (disabled category;
 * the static read gate) — not hap-core's bound comparison, which
 * numeric-amount-bound.test.ts already isolates and hap-core tests itself.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProfile, clearProfiles, type AgentProfile } from '@hap/core';
import { loadProfiles } from '../src/lib/profile-loader';
import {
  loadManifests,
  getManifest,
  invalidManifestOverrideProfilesReason,
  invalidManifestReadGateReason,
  invalidManifestPreviewReason,
  invalidManifestContextReason,
} from '../src/lib/manifest-loader';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { CachedAuthorization } from '../src/lib/attestation-cache';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import { testReceiptKeypair, makeSignedReceipt } from './helpers/real-receipt';

const MANIFESTS_DIR = join(import.meta.dirname, '..', '..', '..', 'content', 'integrations');

const PROFILES_DIR = process.env.SUVEREN_PROFILES_DIR
  ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');

beforeAll(() => {
  const loadedProfiles = loadProfiles(PROFILES_DIR);
  expect(loadedProfiles).toBeGreaterThan(0);
  const loadedManifests = loadManifests(MANIFESTS_DIR);
  expect(loadedManifests).toBeGreaterThan(0);
});

afterAll(() => {
  clearProfiles();
});

// ─── A. charge@0.7 resolves, mollie.json loads clean ───────────────────────

describe('charge@0.7 ("Payments") resolves and mollie.json loads under it', () => {
  it('the charge profile resolves (short name) and is version 0.7', () => {
    const profile = getProfile('charge') as AgentProfile | undefined;
    expect(profile).toBeTruthy();
    expect(profile!.version).toBe('0.7');
    expect(profile!.name).toBe('Payments');
  });

  it('charge@0.7\'s actionTypes are exactly charge + manage', () => {
    const profile = getProfile('charge')!;
    const boundsSchema = profile.boundsSchema as { actionTypes: string[] };
    expect(boundsSchema.actionTypes).toEqual(['charge', 'manage']);
  });

  it('amount_max is a per_transaction bound of amount, requiredFor charge only', () => {
    const profile = getProfile('charge')!;
    const fields = (profile.boundsSchema as { fields: Record<string, { boundType?: { kind: string; of?: string; requiredFor?: string[] } }> }).fields;
    expect(fields.amount_max.boundType).toMatchObject({ kind: 'per_transaction', of: 'amount', requiredFor: ['charge'] });
  });

  it('read_access is an enum switch of unlimited/none', () => {
    const profile = getProfile('charge')!;
    const fields = (profile.boundsSchema as { fields: Record<string, { boundType?: { kind: string; values?: string[] } }> }).fields;
    expect(fields.read_access.boundType).toMatchObject({ kind: 'enum', values: ['unlimited', 'none'] });
  });

  it('mollie.json loads (not refused)', () => {
    expect(getManifest('mollie')).toBeDefined();
  });

  it('mollie.json passes every manifest-load-time check', () => {
    const manifest = JSON.parse(readFileSync(join(MANIFESTS_DIR, 'mollie.json'), 'utf8'));
    expect(invalidManifestOverrideProfilesReason(manifest)).toBeNull();
    expect(invalidManifestReadGateReason(manifest)).toBeNull();
    expect(invalidManifestContextReason(manifest)).toBeNull();
    // Checks every override's summary/display/preview shape in one pass.
    expect(invalidManifestPreviewReason(manifest)).toBeNull();
  });
});

// ─── B. every Mollie tool has an explicit override ─────────────────────────

// Exact tool names Mollie's hosted MCP offers (from the task brief).
const ALL_MOLLIE_TOOLS = [
  'AggregatePaymentLinks', 'AggregatePayments', 'CancelDraftTransfer', 'CancelSubscription',
  'CreateCapture', 'CreateCustomer', 'CreateDraftTransfer', 'CreatePayment', 'CreatePaymentLink',
  'CreateSalesInvoice', 'CreateWebhook', 'GetBalance', 'GetBalanceReport', 'GetCapture',
  'GetClientDocs', 'GetDraftTransfer', 'GetInvoice', 'GetMandate', 'GetNextSettlement',
  'GetOpenSettlement', 'GetOrganizationDetails', 'GetPayment', 'GetPaymentLink', 'GetPaymentMethod',
  'GetPrimaryBalance', 'GetProfile', 'GetSalesInvoice', 'GetSettlement', 'GetSubscription',
  'GetTerminal', 'GetWebhook', 'GetWebhookEvent', 'ListAllPaymentMethods', 'ListAllSubscriptions',
  'ListBalanceTransactions', 'ListBalances', 'ListBusinessAccounts', 'ListCaptures',
  'ListCustomerSubscriptions', 'ListCustomers', 'ListDraftTransfers', 'ListInvoices', 'ListMandates',
  'ListPaymentLinks', 'ListPaymentLinksWithinSpecifiedTimeInterval', 'ListPaymentMethods',
  'ListPaymentsForGivenCustomer', 'ListPaymentsForGivenPaymentLink', 'ListPaymentsFromGivenIDOnwards',
  'ListPaymentsWithinSpecifiedTimeInterval', 'ListProfiles', 'ListSalesInvoices',
  'ListSettlementCaptures', 'ListSettlementChargebacks', 'ListSettlementPayments',
  'ListSettlementRefunds', 'ListSettlements', 'ListSubscriptionPayments', 'ListTerminals',
  'ListWebhooks', 'RevokeMandate', 'SearchCustomers', 'SearchPaymentsByDescription', 'TestWebhook',
  'UpdateCustomer', 'UpdateSalesInvoice', 'UpdateSubscription', 'UpdateWebhook', 'fetch_docs',
  'list_doc_sources',
] as const;

function mollieOverrides(): Record<string, Record<string, unknown> | null> {
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, 'mollie.json'), 'utf8')).toolGating.overrides;
}

describe('every tool Mollie\'s hosted MCP offers has an explicit override (nothing falls to the dead "default")', () => {
  it(`all ${ALL_MOLLIE_TOOLS.length} tools are present in toolGating.overrides`, () => {
    const overrides = mollieOverrides();
    const missing = ALL_MOLLIE_TOOLS.filter((t) => !(t in overrides));
    expect(missing, `missing overrides: ${missing.join(', ')}`).toEqual([]);
  });

  it('the manifest declares no override for a tool OUTSIDE the known list (no stale entries)', () => {
    const overrides = mollieOverrides();
    const known = new Set<string>(ALL_MOLLIE_TOOLS);
    const stale = Object.keys(overrides).filter((t) => !known.has(t as typeof ALL_MOLLIE_TOOLS[number]));
    expect(stale, `stale overrides: ${stale.join(', ')}`).toEqual([]);
  });

  it('every override resolves to a known category: read, disabled, or a mapped write (charge/manage)', () => {
    const overrides = mollieOverrides();
    for (const [toolName, entry] of Object.entries(overrides)) {
      expect(entry, toolName).not.toBeNull();
      const e = entry as Record<string, unknown>;
      const isRead = e.category === 'read';
      const isDisabled = e.category === 'disabled';
      const isWrite = e.staticExecution !== undefined
        && ['charge', 'manage'].includes((e.staticExecution as { action_type?: string }).action_type ?? '');
      expect(isRead || isDisabled || isWrite, `${toolName}: ${JSON.stringify(entry)}`).toBe(true);
    }
  });
});

// ─── C. charge acts map an amount, and are refused without one ────────────

describe('charge acts (CreatePayment, CreatePaymentLink, CreateCapture) map an amount', () => {
  const CHARGE_TOOLS: Array<[string, string, string]> = [
    ['CreatePayment', 'amount', 'currency'],
    ['CreatePaymentLink', 'amount', 'currency'],
    ['CreateCapture', 'amount_value', 'amount_currency'],
  ];

  it.each(CHARGE_TOOLS)('%s maps %s->amount, %s->currency, under action_type "charge"', (tool, amountArg, currencyArg) => {
    const overrides = mollieOverrides();
    const entry = overrides[tool] as { executionMapping: Record<string, string>; staticExecution: Record<string, string> };
    expect(entry.executionMapping[amountArg]).toBe('amount');
    expect(entry.executionMapping[currencyArg]).toBe('currency');
    expect(entry.staticExecution.action_type).toBe('charge');
  });

  it('the profile requires "amount" for action_type "charge" (hap-core\'s own enforcement — unit-tested there, pinned here as the DATA the mapping above feeds it)', () => {
    const profile = getProfile('charge')!;
    const fields = (profile.boundsSchema as { fields: Record<string, { boundType?: { requiredFor?: string[] } }> }).fields;
    expect(fields.amount_max.boundType!.requiredFor).toContain('charge');
  });

  // End-to-end through the REAL write path (tool-proxy.ts), with a stand-in
  // Gatekeeper that encodes exactly hap-core's documented per_transaction
  // `requiredFor` rule (amount_max.requiredFor: ["charge"]) — isolating
  // tool-proxy's OWN responsibility (did the mapped field actually reach
  // the Gatekeeper, or stay silently absent?) from hap-core's bound-
  // comparison code, same split numeric-amount-bound.test.ts documents.
  const SHORT = 'charge';
  const AUTH: CachedAuthorization = {
    authorizationId: 'authz_00000000-0000-4000-8000-0000000000c7',
    profileId: SHORT,
    path: 'charge-routine',
    frame: { profile: SHORT, amount_max: 1000, read_access: 'unlimited' },
    bounds: { profile: SHORT, amount_max: 1000, read_access: 'unlimited' },
    attestations: [],
    requiredDomains: [],
    attestedDomains: [],
    complete: true,
  } as unknown as CachedAuthorization;

  function requiredAmountGatekeeper() {
    return vi.fn().mockImplementation(async (_authId: unknown, execution: Record<string, unknown>) => {
      if (execution.action_type === 'charge' && execution.amount === undefined) {
        return { result: { approved: false, errors: [{ code: 'BOUND_EXCEEDED', message: 'amount is required for charge' }] } };
      }
      return { result: { approved: true, errors: [] }, authorization: AUTH };
    });
  }

  function buildState(verifyExecution: ReturnType<typeof vi.fn>) {
    const kp = testReceiptKeypair();
    const postReceipt = vi.fn().mockImplementation(async (req: {
      action: string;
      executionContext?: Record<string, unknown>;
      authorizationId?: string;
      profileId?: string;
      idempotencyKey?: string;
      contentHash?: string;
      contentBinding?: unknown;
    }) => ({
      receipt: makeSignedReceipt(kp, {
        id: 'rcpt-mollie-charge',
        action: req.action,
        executionContext: req.executionContext ?? {},
        authorizationId: req.authorizationId,
        profileId: req.profileId,
        idempotencyKey: req.idempotencyKey,
        // charge@0.7 declares content_binding (jcs) — CreatePaymentLink's
        // `description` arg is auto-detected prose, so a real contentHash is
        // computed and ticket-verify.ts checks the receipt echoes it back.
        // Omitting this (as a content_binding-less test profile safely can)
        // would fail closed here with "contentHash does not match".
        ...(req.contentHash ? { contentHash: req.contentHash, contentBinding: req.contentBinding } : {}),
      }),
    }));
    const enriched: EnrichedAuthorization[] = [{ ...AUTH, gateContent: null } as EnrichedAuthorization];
    return {
      getEnrichedAuthorizations: () => enriched,
      spClient: { postReceipt, isUnlocked: () => true },
      cache: { getAllAuthorizations: () => [AUTH], getPublicKey: async () => kp.publicKeyHex, getTrustedIssuer: async () => kp.issuer },
      gatekeeper: { verifyExecution },
      executionLog: { record: vi.fn() },
      executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
      archiveReceipt: vi.fn().mockResolvedValue(undefined),
    } as unknown as SharedState;
  }

  function toolFromManifest(name: string): DiscoveredTool {
    const entry = mollieOverrides()[name] as { executionMapping: Record<string, unknown>; staticExecution: Record<string, unknown> };
    return {
      originalName: name,
      namespacedName: `mollie__${name}`,
      integrationId: 'mollie',
      description: '',
      inputSchema: { type: 'object', properties: {} },
      gating: { profile: SHORT, executionMapping: entry.executionMapping, staticExecution: entry.staticExecution },
    } as unknown as DiscoveredTool;
  }

  function managerFor(tool: DiscoveredTool) {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"id":"tr_1"}' }] });
    return { getAllTools: () => [tool], callTool } as unknown as IntegrationManager;
  }

  it('CreatePaymentLink WITH an amount is approved and executed', async () => {
    const tool = toolFromManifest('CreatePaymentLink');
    const verifyExecution = requiredAmountGatekeeper();
    const state = buildState(verifyExecution);
    const manager = managerFor(tool);

    const result = await createGatedToolHandler(tool, manager, state)({ amount: '10.00', currency: 'EUR', description: 'invoice 1' });

    expect(result.isError).toBeFalsy();
    expect(verifyExecution).toHaveBeenCalledOnce();
    const execution = verifyExecution.mock.calls[0][1] as Record<string, unknown>;
    expect(execution.amount).toBe(10);
  });

  it('CreatePaymentLink WITHOUT an amount (open-amount link) is refused — no amount reaches the Gatekeeper as a value, and the stand-in rule (hap-core\'s real one, unit-tested there) refuses it', async () => {
    const tool = toolFromManifest('CreatePaymentLink');
    const verifyExecution = requiredAmountGatekeeper();
    const state = buildState(verifyExecution);
    const manager = managerFor(tool);

    const result = await createGatedToolHandler(tool, manager, state)({ currency: 'EUR', description: 'open amount' });

    expect(verifyExecution).toHaveBeenCalledOnce();
    const execution = verifyExecution.mock.calls[0][1] as Record<string, unknown>;
    expect(execution.amount).toBeUndefined();
    expect(result.isError).toBe(true);
    expect((manager.callTool as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('CreateCapture maps amount_value->amount and is refused without amount_value', async () => {
    const tool = toolFromManifest('CreateCapture');
    const verifyExecution = requiredAmountGatekeeper();
    const state = buildState(verifyExecution);
    const manager = managerFor(tool);

    const result = await createGatedToolHandler(tool, manager, state)({ payment_id: 'tr_1' });

    expect(result.isError).toBe(true);
    const execution = verifyExecution.mock.calls[0][1] as Record<string, unknown>;
    expect(execution.amount).toBeUndefined();
  });
});

// ─── D. manage acts move no money ──────────────────────────────────────────

describe('manage acts (CreateCustomer, UpdateCustomer, RevokeMandate)', () => {
  it.each(['CreateCustomer', 'UpdateCustomer', 'RevokeMandate'])('%s is staticExecution.action_type "manage"', (tool) => {
    const entry = mollieOverrides()[tool] as { staticExecution: Record<string, string> };
    expect(entry.staticExecution.action_type).toBe('manage');
  });

  it('none of the three manage acts map any amount/currency field (no money moves)', () => {
    for (const tool of ['CreateCustomer', 'UpdateCustomer', 'RevokeMandate']) {
      const entry = mollieOverrides()[tool] as { executionMapping: Record<string, string> };
      expect(Object.values(entry.executionMapping)).not.toContain('amount');
      expect(Object.values(entry.executionMapping)).not.toContain('currency');
    }
  });
});

// ─── E. disabled tools are refused end to end ──────────────────────────────

const DISABLED_TOOLS = [
  'CreateSalesInvoice', 'UpdateSalesInvoice', 'CancelSubscription', 'UpdateSubscription',
  'CreateWebhook', 'UpdateWebhook', 'TestWebhook', 'CreateDraftTransfer', 'CancelDraftTransfer',
  'GetDraftTransfer', 'ListDraftTransfers', 'ListBusinessAccounts',
] as const;

describe('refused tools (category:"disabled") — real write path, no ticket, no downstream call', () => {
  it('every disabled tool declares category:"disabled" with a written reason', () => {
    const overrides = mollieOverrides();
    for (const tool of DISABLED_TOOLS) {
      const entry = overrides[tool] as Record<string, unknown>;
      expect(entry.category, tool).toBe('disabled');
      expect(typeof entry._reason, tool).toBe('string');
      expect((entry._reason as string).length, tool).toBeGreaterThan(0);
    }
  });

  it.each(DISABLED_TOOLS)('%s is refused by createGatedToolHandler before any downstream call', async (toolName) => {
    const entry = mollieOverrides()[toolName] as Record<string, unknown>;
    const tool: DiscoveredTool = {
      originalName: toolName,
      namespacedName: `mollie__${toolName}`,
      integrationId: 'mollie',
      description: '',
      inputSchema: { type: 'object', properties: {} },
      gating: { profile: 'charge', executionMapping: {}, category: 'disabled' },
    } as unknown as DiscoveredTool;
    const callTool = vi.fn();
    const manager = { getAllTools: () => [tool], callTool } as unknown as IntegrationManager;
    const verifyExecution = vi.fn();
    const state = {
      getEnrichedAuthorizations: () => [],
      spClient: { postReceipt: vi.fn(), isUnlocked: () => true },
      cache: { getAllAuthorizations: () => [], getPublicKey: async () => '', getTrustedIssuer: async () => '' },
      gatekeeper: { verifyExecution },
      executionLog: { record: vi.fn() },
      executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
      archiveReceipt: vi.fn(),
    } as unknown as SharedState;

    const result = await createGatedToolHandler(tool, manager, state)({});

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/disabled/i);
    expect(callTool).not.toHaveBeenCalled();
    expect(verifyExecution).not.toHaveBeenCalled();
    void entry; // the manifest-level shape is checked in the test above
  });
});

// ─── F. customer/payment-data reads require read_access:unlimited ─────────

describe('reads that carry customer or payment data require read_access:unlimited', () => {
  const SHORT = 'charge';

  function readToolFromManifest(name: string): DiscoveredTool {
    const entry = mollieOverrides()[name] as { boundField?: string; requiredValue?: string; readGovernance?: string; readGovernanceReason?: string };
    return {
      originalName: name,
      namespacedName: `mollie__${name}`,
      integrationId: 'mollie',
      description: '',
      inputSchema: { type: 'object', properties: {} },
      gating: {
        profile: SHORT,
        executionMapping: {},
        category: 'read',
        boundField: entry.boundField,
        requiredValue: entry.requiredValue,
        readGovernance: entry.readGovernance,
        readGovernanceReason: entry.readGovernanceReason,
      },
    } as unknown as DiscoveredTool;
  }

  function authWith(readAccess: string): CachedAuthorization {
    return {
      authorizationId: 'authz_00000000-0000-4000-8000-0000000000d1',
      profileId: SHORT,
      path: 'charge-read',
      frame: { profile: SHORT, read_access: readAccess },
      bounds: { profile: SHORT, read_access: readAccess },
      attestations: [],
      requiredDomains: [],
      attestedDomains: [],
      complete: true,
    } as unknown as CachedAuthorization;
  }

  function stateFor(auth: CachedAuthorization) {
    const enriched: EnrichedAuthorization[] = [{ ...auth, gateContent: null } as EnrichedAuthorization];
    return {
      getEnrichedAuthorizations: () => enriched,
      spClient: { postReceipt: vi.fn(), isUnlocked: () => true },
      cache: { getAllAuthorizations: () => [auth], getPublicKey: async () => '', getTrustedIssuer: async () => '' },
      gatekeeper: { verifyExecution: vi.fn() },
      executionLog: { record: vi.fn() },
      executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
      archiveReceipt: vi.fn(),
    } as unknown as SharedState;
  }

  it.each(['GetPayment', 'ListCustomers', 'GetMandate', 'GetSettlement', 'GetSubscription', 'ListInvoices', 'GetSalesInvoice', 'GetWebhook'])(
    '%s with read_access:none is refused',
    async (toolName) => {
      const tool = readToolFromManifest(toolName);
      const manager = { getAllTools: () => [tool], callTool: vi.fn() } as unknown as IntegrationManager;
      const result = await createGatedToolHandler(tool, manager, stateFor(authWith('none')))({});
      expect(result.isError, toolName).toBe(true);
      expect((manager.callTool as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    },
  );

  it.each(['GetPayment', 'ListCustomers', 'GetMandate', 'GetSettlement', 'GetSubscription', 'ListInvoices', 'GetSalesInvoice', 'GetWebhook'])(
    '%s with read_access:unlimited proceeds',
    async (toolName) => {
      const tool = readToolFromManifest(toolName);
      const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });
      const manager = { getAllTools: () => [tool], callTool } as unknown as IntegrationManager;
      const result = await createGatedToolHandler(tool, manager, stateFor(authWith('unlimited')))({});
      expect(result.isError, toolName).toBeFalsy();
      expect(callTool).toHaveBeenCalledOnce();
    },
  );

  it.each(['ListProfiles', 'GetOrganizationDetails', 'GetPaymentMethod', 'ListTerminals', 'GetClientDocs', 'fetch_docs', 'list_doc_sources'])(
    '%s (readGovernance:"none") proceeds even with read_access:none — it carries no customer/payment data',
    async (toolName) => {
      const tool = readToolFromManifest(toolName);
      const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });
      const manager = { getAllTools: () => [tool], callTool } as unknown as IntegrationManager;
      const result = await createGatedToolHandler(tool, manager, stateFor(authWith('none')))({});
      expect(result.isError, toolName).toBeFalsy();
      expect(callTool).toHaveBeenCalledOnce();
    },
  );
});
