import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { registerProfile, clearProfiles } from '@hap/core';
import { listAuthorizationsHandler } from '../src/tools/authorizations';
import { checkPendingHandler } from '../src/tools/pending';
import { createGatedToolHandler, buildProxiedToolDescription } from '../src/lib/tool-proxy';
import { SPReceiptError } from '../src/lib/sp-client';
import type { AttestationCache, CachedAuthorization } from '../src/lib/attestation-cache';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';

// ─── Mock factories ──────────────────────────────────────────────────────────

function mockExecutionLog() {
  return {
    record: vi.fn(),
    sumByWindow: vi.fn().mockReturnValue(0),
    getAll: () => [],
    size: 0,
  };
}

function mockState(authorizations: CachedAuthorization[] = []): SharedState {
  const enriched: EnrichedAuthorization[] = authorizations.map(a => ({
    ...a,
    gateContent: null,
  }));

  return {
    getEnrichedAuthorizations: () => enriched,
    // Signed in. Without this the handlers short-circuit to the locked notice,
    // which is correct behaviour but not what these cases are exercising —
    // see locked-notice.test.ts for that path.
    spClient: { isUnlocked: () => true },
    executionLog: mockExecutionLog(),
    cache: {
      getAllAuthorizations: () => authorizations,
      getAuthorization: (path: string) => authorizations.find(a => a.path === path) ?? null,
      getPublicKey: async () => 'mock-pubkey',
      getPendingAttestations: async () => [],
      syncAuthorization: async () => null,
      cacheAuthorization: () => {},
    },
  } as unknown as SharedState;
}

function mockCache(authorizations: CachedAuthorization[] = []): AttestationCache {
  return {
    getAllAuthorizations: () => authorizations,
    getAuthorization: (path: string) => authorizations.find(a => a.path === path) ?? null,
    getPublicKey: async () => 'mock-pubkey',
    getPendingAttestations: async () => [],
    syncAuthorization: async () => null,
    cacheAuthorization: () => {},
  } as unknown as AttestationCache;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('list-authorizations', () => {
  it('returns empty message when no authorizations', async () => {
    const handler = listAuthorizationsHandler(mockState());
    const result = await handler();
    expect(result.content[0].text).toContain('No active authorizations');
  });

  it('lists active authorizations with bounds and TTL', async () => {
    const now = Math.floor(Date.now() / 1000);
    const handler = listAuthorizationsHandler(mockState([
      {
        authorizationId: 'authz_00000000-0000-4000-8000-0000000000ab',
        profileId: 'charge@0.3',
        path: 'charge-routine',
        frame: {
          profile: 'charge@0.3',
          path: 'charge-routine',
          amount_max: 80,
          currency: 'EUR',
          action_type: 'charge',
        },
        attestations: [{ domain: 'finance', blob: 'blob', expiresAt: now + 2700 }],
        requiredDomains: ['finance'],
        attestedDomains: ['finance'],
        complete: true,
      },
    ]));

    const result = await handler();
    const text = result.content[0].text;
    expect(text).toContain('Active authorizations');
    expect(text).toContain('charge-routine');
    expect(text).toContain('amount_max: 80');
    expect(text).toContain('currency: EUR');
  });

  it('lists pending authorizations with missing domains', async () => {
    const now = Math.floor(Date.now() / 1000);
    const handler = listAuthorizationsHandler(mockState([
      {
        authorizationId: 'authz_00000000-0000-4000-8000-0000000000ab',
        profileId: 'charge@0.3',
        path: 'charge-reviewed',
        frame: {
          profile: 'charge@0.3',
          path: 'charge-reviewed',
          amount_max: 5000,
          currency: 'EUR',
          action_type: 'charge',
        },
        attestations: [{ domain: 'finance', blob: 'blob', expiresAt: now + 3600 }],
        requiredDomains: ['finance', 'compliance'],
        attestedDomains: ['finance'],
        complete: false,
      },
    ]));

    const result = await handler();
    const text = result.content[0].text;
    expect(text).toContain('Pending');
    expect(text).toContain('compliance');
  });

  it('returns domain-scoped detail when domain param is provided', async () => {
    const now = Math.floor(Date.now() / 1000);
    const handler = listAuthorizationsHandler(mockState([
      {
        authorizationId: 'authz_00000000-0000-4000-8000-0000000000ab',
        profileId: 'charge@0.3',
        path: 'charge-routine',
        frame: {
          profile: 'charge@0.3',
          path: 'charge-routine',
          amount_max: 100,
          currency: 'USD',
          action_type: 'charge',
          amount_daily_max: 500,
          amount_monthly_max: 5000,
          transaction_count_daily_max: 20,
        },
        attestations: [{ domain: 'finance', blob: 'blob', expiresAt: now + 2700 }],
        requiredDomains: ['finance'],
        attestedDomains: ['finance'],
        complete: true,
      },
    ]));

    const result = await handler({ domain: 'charge' });
    const text = result.content[0].text;
    expect(text).toContain('[charge-routine]');
    expect(text).toContain('charge@0.3');
    expect(text).toContain('Bounds:');
    expect(text).toContain('amount_max: 100');
  });

  it('returns error for unknown domain', async () => {
    const now = Math.floor(Date.now() / 1000);
    const handler = listAuthorizationsHandler(mockState([
      {
        authorizationId: 'authz_00000000-0000-4000-8000-0000000000ab',
        profileId: 'charge@0.3',
        path: 'charge-routine',
        frame: { profile: 'charge@0.3', path: 'charge-routine', amount_max: 100, currency: 'USD', action_type: 'charge' },
        attestations: [{ domain: 'finance', blob: 'blob', expiresAt: now + 3600 }],
        requiredDomains: ['finance'],
        attestedDomains: ['finance'],
        complete: true,
      },
    ]));

    const result = await handler({ domain: 'ship' });
    const text = result.content[0].text;
    expect(text).toContain('No authorizations found for domain "ship"');
    expect(text).toContain('charge');
  });

  it('compact overview includes call-to-action for domain details', async () => {
    const now = Math.floor(Date.now() / 1000);
    const handler = listAuthorizationsHandler(mockState([
      {
        authorizationId: 'authz_00000000-0000-4000-8000-0000000000ab',
        profileId: 'charge@0.3',
        path: 'charge-routine',
        frame: { profile: 'charge@0.3', path: 'charge-routine', amount_max: 100, currency: 'USD', action_type: 'charge' },
        attestations: [{ domain: 'finance', blob: 'blob', expiresAt: now + 3600 }],
        requiredDomains: ['finance'],
        attestedDomains: ['finance'],
        complete: true,
      },
    ]));

    const result = await handler();
    const text = result.content[0].text;
    expect(text).toContain('list-authorizations(domain: "charge")');
  });
});

describe('check-pending-attestations', () => {
  it('returns empty message when no pending', async () => {
    const handler = checkPendingHandler(mockCache());
    const result = await handler({ domain: 'compliance' });
    expect(result.content[0].text).toContain('No pending attestations');
  });
});

// ─── Tool proxy receipt integration tests ─────────────────────────────────

function mockGatedState(opts: {
  postReceipt?: () => Promise<unknown>;
  verifyResult?: { approved: boolean; errors?: Array<{ code: string; message: string; field?: string }> };
} = {}): SharedState {
  const now = Math.floor(Date.now() / 1000);
  const auth: CachedAuthorization = {
    authorizationId: 'authz_00000000-0000-4000-8000-0000000000ab',
    profileId: 'github.com/humanagencyprotocol/hap-profiles/charge@0.3',
    path: 'charge-routine',
    frame: { profile: 'github.com/humanagencyprotocol/hap-profiles/charge@0.3', path: 'charge-routine', amount_max: 100, currency: 'EUR', action_type: 'charge' },
    attestations: [{ domain: 'finance', blob: 'blob', expiresAt: now + 3600 }],
    requiredDomains: ['finance'],
    attestedDomains: ['finance'],
    complete: true,
  };

  const enriched: EnrichedAuthorization[] = [{ ...auth, gateContent: null }];

  return {
    getEnrichedAuthorizations: () => enriched,
    spClient: {
      postReceipt: opts.postReceipt ?? vi.fn().mockResolvedValue({ receipt: { id: 'r1' } }),
      isUnlocked: () => true,
    },
    gatekeeper: {
      verifyExecution: vi.fn().mockResolvedValue({
        result: opts.verifyResult ?? { approved: true, errors: [] },
        authorization: auth,
      }),
    },
    executionLog: {
      record: vi.fn(),
    },
  } as unknown as SharedState;
}

function mockTool(profile: string): DiscoveredTool {
  return {
    originalName: 'stripe_charge',
    namespacedName: 'stripe__stripe_charge',
    integrationId: 'stripe',
    description: 'Charge a card',
    inputSchema: {},
    gating: {
      profile,
      executionMapping: { amount: 'amount', currency: 'currency' },
      staticExecution: { action_type: 'charge' },
    },
  };
}

function mockIntegrationManager(): IntegrationManager {
  return {
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Payment processed' }],
    }),
  } as unknown as IntegrationManager;
}

describe('createGatedToolHandler — SP receipt integration', () => {
  it('proxies tool call when SP returns receipt', async () => {
    const postReceipt = vi.fn().mockResolvedValue({ receipt: { id: 'r1' } });
    const state = mockGatedState({ postReceipt });
    const im = mockIntegrationManager();
    const handler = createGatedToolHandler(mockTool('charge'), im, state);

    const result = await handler({ amount: 50, currency: 'EUR' });

    expect(postReceipt).toHaveBeenCalledOnce();
    expect(postReceipt).toHaveBeenCalledWith(expect.objectContaining({
      // The receipt references the grant by its per-ceremony id; boundsHash
      // rides along as an optional cross-check.
      authorizationId: 'authz_00000000-0000-4000-8000-0000000000ab',
      profileId: 'github.com/humanagencyprotocol/hap-profiles/charge@0.3',
      // `action` is the namespaced tool name (the SP uses it for the review-mode
      // PROPOSAL_MISMATCH equality check), not the short profile name.
      action: 'stripe__stripe_charge',
    }));
    // M3: every gated tool call must carry a stable idempotency key so the SP
    // can dedup a retried receipt instead of double-counting. This is the
    // production wiring at tool-proxy.ts — assert it actually happens.
    const receiptArg = postReceipt.mock.calls[0][0] as { idempotencyKey?: unknown };
    expect(typeof receiptArg.idempotencyKey).toBe('string');
    expect((receiptArg.idempotencyKey as string).length).toBeGreaterThan(0);
    expect((im.callTool as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect(result.content[0].text).toBe('Payment processed');
  });

  it('blocks tool call when SP rejects with 403', async () => {
    const postReceipt = vi.fn().mockRejectedValue(
      new SPReceiptError('Daily limit exceeded', 403, { error: 'Daily limit exceeded' }),
    );
    const state = mockGatedState({ postReceipt });
    const im = mockIntegrationManager();
    const handler = createGatedToolHandler(mockTool('charge'), im, state);

    const result = await handler({ amount: 50, currency: 'EUR' });

    expect(postReceipt).toHaveBeenCalledOnce();
    expect((im.callTool as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Blocked by SP');
    expect(result.content[0].text).toContain('Daily limit exceeded');
  });

  it('blocks tool call when SP is unreachable (fail closed)', async () => {
    const postReceipt = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const state = mockGatedState({ postReceipt });
    const im = mockIntegrationManager();
    const handler = createGatedToolHandler(mockTool('charge'), im, state);

    const result = await handler({ amount: 50, currency: 'EUR' });

    expect(postReceipt).toHaveBeenCalledOnce();
    expect((im.callTool as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SP unavailable');
    expect(result.content[0].text).toContain('fetch failed');
  });

  it('P8.2: submits proposal with creator+approvers when SP returns 409 approval_required', async () => {
    const approvers = ['bob', 'carol'];
    const postReceipt = vi.fn().mockRejectedValue(
      new SPReceiptError('Approval required', 409, {
        error: 'approval_required',
        approvers,
        authorizationId: 'authz_00000000-0000-4000-8000-0000000000ab',
        field: 'amount_daily_max',
        cap: 1000,
      }),
    );
    const submitProposal = vi.fn().mockResolvedValue({
      proposal: { id: 'prop-123', status: 'pending' },
    });
    const getAuthorizationSummary = vi.fn().mockResolvedValue({
      authorization_id: 'authz_00000000-0000-4000-8000-0000000000ab',
      profile_id: 'github.com/humanagencyprotocol/hap-profiles/charge@0.3',
      above_cap: true,
      approvers_frozen: ['bob', 'carol'],
      created_by: 'alice',
    });

    const state = {
      ...mockGatedState({ postReceipt }),
      spClient: {
        postReceipt,
        submitProposal,
        getAuthorizationSummary,
        // Overriding spClient wholesale drops mockGatedState's isUnlocked, so
        // the handler would short-circuit to the locked notice.
        isUnlocked: () => true,
      },
    } as unknown as import('../src/lib/shared-state').SharedState;

    const im = mockIntegrationManager();
    const handler = createGatedToolHandler(mockTool('charge'), im, state);

    const result = await handler({ amount: 50, currency: 'EUR' });

    expect(postReceipt).toHaveBeenCalledOnce();
    expect(submitProposal).toHaveBeenCalledOnce();
    // pendingApprovers must include creator (alice) + approvers from 409 body
    const submitCall = (submitProposal as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(submitCall.pendingApprovers).toContain('alice');
    expect(submitCall.pendingApprovers).toContain('bob');
    expect(submitCall.pendingApprovers).toContain('carol');
    // Tool must NOT have been called
    expect((im.callTool as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    // Response should mention approval required
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Approval required');
    expect(result.content[0].text).toContain('prop-123');
  });

  it('P8.2: returns hard error when SP returns 422 (no approver path)', async () => {
    const postReceipt = vi.fn().mockRejectedValue(
      new SPReceiptError('cap_exceeded', 422, { error: 'cap_exceeded', field: 'amount_max', cap: 500 }),
    );
    const state = mockGatedState({ postReceipt });
    const im = mockIntegrationManager();
    const handler = createGatedToolHandler(mockTool('charge'), im, state);

    const result = await handler({ amount: 50, currency: 'EUR' });

    expect(postReceipt).toHaveBeenCalledOnce();
    expect((im.callTool as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('hard team ceiling');
  });
});

// ─── buildProxiedToolDescription — gating tags ──────────────────────────────

// ─── Execution mapping transforms ─────────────────────────────────────────

describe('createGatedToolHandler — mapping transforms', () => {
  function mockEmailTool(): DiscoveredTool {
    return {
      originalName: 'send_message',
      namespacedName: 'gmail__send_message',
      integrationId: 'gmail',
      description: 'Send an email',
      inputSchema: {},
      gating: {
        profile: 'email',
        executionMapping: {
          to: [
            { field: 'recipient_count', transform: 'length' },
            { field: 'allowed_recipients', transform: 'join' },
            { field: 'allowed_domains', transform: 'join_domains' },
          ],
        },
        staticExecution: {},
      },
    };
  }

  it('length transform counts array items', async () => {
    const state = mockGatedState();
    const im = mockIntegrationManager();
    // Override the tool to use email mapping
    const tool = mockEmailTool();
    // Patch profile to match
    (state.getEnrichedAuthorizations()[0] as Record<string, unknown>).profileId = 'github.com/humanagencyprotocol/hap-profiles/email@0.4';
    const handler = createGatedToolHandler(tool, im, state);

    await handler({ to: ['alice@gmail.com', 'bob@acme.com'] });

    const verifyCall = (state.gatekeeper as { verifyExecution: ReturnType<typeof vi.fn> }).verifyExecution;
    const executionArg = verifyCall.mock.calls[0][1] as Record<string, unknown>;
    expect(executionArg.recipient_count).toBe(2);
  });

  it('join transform joins array to comma-separated string', async () => {
    const state = mockGatedState();
    const im = mockIntegrationManager();
    const tool = mockEmailTool();
    (state.getEnrichedAuthorizations()[0] as Record<string, unknown>).profileId = 'github.com/humanagencyprotocol/hap-profiles/email@0.4';
    const handler = createGatedToolHandler(tool, im, state);

    await handler({ to: ['alice@gmail.com', 'bob@acme.com'] });

    const verifyCall = (state.gatekeeper as { verifyExecution: ReturnType<typeof vi.fn> }).verifyExecution;
    const executionArg = verifyCall.mock.calls[0][1] as Record<string, unknown>;
    expect(executionArg.allowed_recipients).toBe('alice@gmail.com,bob@acme.com');
  });

  it('join_domains extracts domains, deduplicates, and sorts', async () => {
    const state = mockGatedState();
    const im = mockIntegrationManager();
    const tool = mockEmailTool();
    (state.getEnrichedAuthorizations()[0] as Record<string, unknown>).profileId = 'github.com/humanagencyprotocol/hap-profiles/email@0.4';
    const handler = createGatedToolHandler(tool, im, state);

    await handler({ to: ['alice@gmail.com', 'bob@acme.com', 'charlie@gmail.com'] });

    const verifyCall = (state.gatekeeper as { verifyExecution: ReturnType<typeof vi.fn> }).verifyExecution;
    const executionArg = verifyCall.mock.calls[0][1] as Record<string, unknown>;
    expect(executionArg.allowed_domains).toBe('acme.com,gmail.com');
  });

  it('handles single string arg (non-array) with transforms', async () => {
    const state = mockGatedState();
    const im = mockIntegrationManager();
    const tool = mockEmailTool();
    (state.getEnrichedAuthorizations()[0] as Record<string, unknown>).profileId = 'github.com/humanagencyprotocol/hap-profiles/email@0.4';
    const handler = createGatedToolHandler(tool, im, state);

    await handler({ to: 'alice@gmail.com' });

    const verifyCall = (state.gatekeeper as { verifyExecution: ReturnType<typeof vi.fn> }).verifyExecution;
    const executionArg = verifyCall.mock.calls[0][1] as Record<string, unknown>;
    expect(executionArg.recipient_count).toBe(1);
    expect(executionArg.allowed_recipients).toBe('alice@gmail.com');
    expect(executionArg.allowed_domains).toBe('gmail.com');
  });
});

describe('buildProxiedToolDescription', () => {
  it('returns [Suveren: no gating config] for tools with no gating', () => {
    const tool: DiscoveredTool = {
      originalName: 'list_products',
      namespacedName: 'stripe__list_products',
      integrationId: 'stripe',
      description: 'List all products',
      inputSchema: {},
      gating: null,
    };
    const state = mockState();
    const desc = buildProxiedToolDescription(tool, state);
    expect(desc).toBe('[Suveren: no gating config] List all products');
  });

  it('returns gating tag with action type and checked fields for gated tool with auth', () => {
    const now = Math.floor(Date.now() / 1000);
    const fullProfileId = 'github.com/humanagencyprotocol/hap-profiles/charge@0.3';
    const tool: DiscoveredTool = {
      originalName: 'create_payment_link',
      namespacedName: 'stripe__create_payment_link',
      integrationId: 'stripe',
      description: 'Create a payment link',
      inputSchema: {},
      gating: {
        profile: 'charge',
        executionMapping: { unit_amount: { field: 'amount', divisor: 100 }, currency: 'currency' },
        staticExecution: { action_type: 'charge' },
      },
    };
    const state = mockState([{
      authorizationId: 'authz_00000000-0000-4000-8000-0000000000ab',
      profileId: fullProfileId,
      path: 'charge-routine',
      frame: { profile: fullProfileId, path: 'charge-routine', amount_max: 100, currency: 'USD', action_type: 'charge' },
      attestations: [{ domain: 'finance', blob: 'blob', expiresAt: now + 3600 }],
      requiredDomains: ['finance'],
      attestedDomains: ['finance'],
      complete: true,
    }]);

    const desc = buildProxiedToolDescription(tool, state);
    expect(desc).toContain('[Suveren: charge');
    expect(desc).toContain('charge');
    expect(desc).toContain('amount, currency checked');
    expect(desc).toContain('Create a payment link');
  });

  it('returns no active authorization tag for gated tool without auth', () => {
    const tool: DiscoveredTool = {
      originalName: 'create_payment_link',
      namespacedName: 'stripe__create_payment_link',
      integrationId: 'stripe',
      description: 'Create a payment link',
      inputSchema: {},
      gating: {
        profile: 'charge',
        executionMapping: { unit_amount: { field: 'amount', divisor: 100 } },
        staticExecution: { action_type: 'charge' },
      },
    };
    const state = mockState(); // no authorizations

    const desc = buildProxiedToolDescription(tool, state);
    expect(desc).toContain('[Suveren: charge — no active authorization]');
    expect(desc).toContain('Create a payment link');
  });
});

// ─── F9: an ungoverned read tool is denied at runtime ───────────────────────
describe('createGatedToolHandler — F9 ungoverned read is denied', () => {
  function mockReadTool(gating: Record<string, unknown>): DiscoveredTool {
    return {
      originalName: 'export_crm',
      namespacedName: 'crm__export_crm',
      integrationId: 'crm',
      description: 'Export the CRM',
      inputSchema: {},
      gating: { profile: 'customers', executionMapping: {}, category: 'read', ...gating },
    };
  }

  it('denies a read tool with no gate, no adapter, no exemption — before any downstream call', async () => {
    const state = mockGatedState();
    const im = mockIntegrationManager();
    const handler = createGatedToolHandler(mockReadTool({}), im, state);

    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('declares no read governance');
    // Fail closed BEFORE reaching the downstream integration.
    expect((im.callTool as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('allows a read tool once it declares an explicit exemption', async () => {
    const state = mockGatedState();
    const im = mockIntegrationManager();
    // profile mismatch (customers vs the charge auth in mockGatedState) makes this
    // stop at the auth check, NOT the F9 gate — proving governance passed.
    const handler = createGatedToolHandler(
      mockReadTool({ readGovernance: 'none', readGovernanceReason: 'test' }),
      im,
      state,
    );

    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('declares no read governance');
    expect(result.content[0].text).toContain('No active authorization');
  });
});

// ─── Fail-closed on an unset read-age window (F11) ──────────────────────────
describe('createGatedToolHandler — unset read-age window fails closed', () => {
  // Minimal email-like profile: read_max_age_days is a per_transaction bound
  // over the adapter's produced age field, and is OPTIONAL (a grant may omit it).
  beforeAll(() => {
    registerProfile('email-test', {
      id: 'email-test', name: 'Email Test', version: '0',
      boundsSchema: {
        keyOrder: ['read_max_age_days'],
        fields: { read_max_age_days: { type: 'number', boundType: { kind: 'per_transaction', of: 'read_age_days' } } },
      },
      contextSchema: { keyOrder: [], fields: {} },
    } as unknown as Parameters<typeof registerProfile>[1]);
  });
  afterAll(() => clearProfiles());

  function emailReadTool(): DiscoveredTool {
    return {
      originalName: 'list_messages',
      namespacedName: 'gmail__list_messages',
      integrationId: 'gmail',
      description: 'List messages',
      inputSchema: {},
      gating: {
        profile: 'email-test',
        executionMapping: {},
        category: 'read',
        read: { ageField: 'read_age_days', queryArg: 'q', ageConstraint: 'newer_than:{days}d' },
      } as unknown as DiscoveredTool['gating'],
    };
  }

  function emailAuth(bounds: Record<string, string | number>): CachedAuthorization {
    const now = Math.floor(Date.now() / 1000);
    return {
      authorizationId: 'authz_00000000-0000-4000-8000-0000000000cd',
      profileId: 'email-test',
      path: 'email-test',
      frame: { profile: 'email-test', path: 'email-test', ...bounds },
      attestations: [{ domain: 'communications', blob: 'blob', expiresAt: now + 3600 }],
      requiredDomains: ['communications'],
      attestedDomains: ['communications'],
      complete: true,
    } as unknown as CachedAuthorization;
  }

  it('DENIES the read when no grant sets read_max_age_days (unbounded window)', async () => {
    const state = mockState([emailAuth({})]); // no read_max_age_days
    const record = vi.fn();
    (state as unknown as { denialLog: { record: typeof record } }).denialLog = { record };
    const im = mockIntegrationManager();
    const handler = createGatedToolHandler(emailReadTool(), im, state);

    const result = await handler({ q: 'invoices' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no read-age window is set');
    // Fail closed BEFORE any downstream fetch.
    expect((im.callTool as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    // And the block is RECORDED for the human (denial log), with no content.
    expect(record).toHaveBeenCalledOnce();
    const rec = record.mock.calls[0][0] as { reason: string; tool: string; detail: string };
    expect(rec.reason).toBe('unset_age');
    expect(rec.tool).toBe('list_messages');
    expect(rec.detail).not.toContain('invoices'); // no agent query / content leaks in
  });

  it('proceeds (and injects the age ceiling) when a grant sets read_max_age_days', async () => {
    const state = mockState([emailAuth({ read_max_age_days: 30 })]);
    const im = mockIntegrationManager();
    const handler = createGatedToolHandler(emailReadTool(), im, state);

    await handler({ q: 'invoices' });

    expect((im.callTool as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    const sentArgs = (im.callTool as ReturnType<typeof vi.fn>).mock.calls[0][2] as { q: string };
    expect(sentArgs.q).toBe('(invoices) newer_than:30d');
  });
});
