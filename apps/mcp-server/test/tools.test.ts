import { describe, it, expect, vi } from 'vitest';
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
        frameHash: 'sha256:abc',
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
        frameHash: 'sha256:abc',
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
        frameHash: 'sha256:abc',
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
        frameHash: 'sha256:abc',
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
        frameHash: 'sha256:abc',
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
    frameHash: 'sha256:abc',
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
      attestationHash: 'sha256:abc',
      profileId: 'github.com/humanagencyprotocol/hap-profiles/charge@0.3',
      path: 'charge-routine',
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
        frameHash: 'sha256:abc',
        field: 'amount_daily_max',
        cap: 1000,
      }),
    );
    const submitProposal = vi.fn().mockResolvedValue({
      proposal: { id: 'prop-123', status: 'pending' },
    });
    const getFrameMetadata = vi.fn().mockResolvedValue({
      frameHash: 'sha256:abc',
      profileId: 'github.com/humanagencyprotocol/hap-profiles/charge@0.3',
      aboveCap: true,
      approversFrozen: ['bob', 'carol'],
      createdBy: 'alice',
    });

    const state = {
      ...mockGatedState({ postReceipt }),
      spClient: {
        postReceipt,
        submitProposal,
        getFrameMetadata,
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
      frameHash: 'sha256:abc',
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
