/**
 * AU10 — `_source` is stripped before the downstream tool ever runs, on
 * every execution path (doc/au10-request-context.md §1: "stripped before
 * execution — like `_imagePreview`"). Harness mirrors receipt-privacy.test.ts
 * (same two call sites: tool-proxy.ts's automatic path, commitments.ts's
 * review/committed-executor path).
 *
 * The third path the contract names — "edit-before-signing" — is
 * `create-mandate-prefill.ts`'s `mandatePrefillGate`, covered separately in
 * apps/ui/src/lib/__tests__/create-mandate-prefill.test.ts (it never reads
 * `_source` at all, by construction: the mandate screen only carries
 * limits/scope/intent/mode/duration forward).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { registerProfile, clearProfiles } from '@hap/core';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import { executeCommitted } from '../src/tools/commitments';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { CachedAuthorization } from '../src/lib/attestation-cache';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import type { SPProposal } from '../src/lib/sp-client';
import { hashToolArgs } from '../src/lib/execution-journal';
import { testReceiptKeypair, makeSignedReceipt } from './helpers/real-receipt';

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/au10-strip-test@0.5';
const SHORT = 'au10-strip-test';

const SOURCE = { connector: 'mail', kind: 'message', id: 'm-17' };
const ARGS = {
  name: 'J. Kraus',
  email: 'j.kraus@bavaria-umform.de',
  type: 'customer',
  _source: SOURCE,
};

beforeAll(() => {
  registerProfile(PROFILE_ID, {
    id: PROFILE_ID,
    version: '0.5',
    description: 'test',
    executionContextSchema: { fields: {} },
    requiredGates: [],
    ttl: { default: 1, max: 1 },
    retention_minimum: 1,
  } as never);
});

afterAll(() => clearProfiles());

const TOOL: DiscoveredTool = {
  originalName: 'create_contact',
  namespacedName: 'crm__create_contact',
  integrationId: 'crm',
  description: '',
  inputSchema: { type: 'object', properties: { name: {}, email: {}, type: {}, _source: { type: 'object' } } },
  gating: {
    profile: SHORT,
    executionMapping: {},
    staticExecution: { action_type: 'write' },
  } as unknown as DiscoveredTool['gating'],
};

const AUTH: CachedAuthorization = {
  authorizationId: 'authz_00000000-0000-4000-8000-00000000au10',
  profileId: PROFILE_ID,
  path: 'crm-routine',
  frame: { profile: PROFILE_ID, path: 'crm-routine' },
  attestations: [],
  requiredDomains: [],
  attestedDomains: [],
  complete: true,
} as unknown as CachedAuthorization;

const PROPOSAL: SPProposal = {
  id: 'prop-au10-1',
  authorizationId: AUTH.authorizationId,
  profileId: PROFILE_ID,
  path: 'crm-routine',
  pendingDomains: [],
  committedBy: { owner: { userId: 'andreas', at: 0 } },
  rejectedBy: null,
  tool: 'crm__create_contact',
  toolArgs: { ...ARGS },
  executionContext: { action_type: 'write' },
  status: 'committed',
  executionResult: null,
  createdAt: 0,
  expiresAt: 0,
} as unknown as SPProposal;

function buildState() {
  const kp = testReceiptKeypair();
  const postReceipt = vi.fn().mockImplementation(async (req: {
    action: string;
    executionContext?: Record<string, unknown>;
    authorizationId?: string;
    profileId?: string;
    proposalId?: string;
    idempotencyKey?: string;
  }) => ({
    receipt: makeSignedReceipt(kp, {
      id: 'rcpt-au10-1',
      action: req.action,
      executionContext: req.executionContext ?? {},
      authorizationId: req.authorizationId,
      profileId: req.profileId,
      proposalId: req.proposalId,
      idempotencyKey: req.idempotencyKey,
    }),
  }));
  const enriched: EnrichedAuthorization[] = [{ ...AUTH, gateContent: null } as EnrichedAuthorization];
  const state = {
    getEnrichedAuthorizations: () => enriched,
    spClient: { postReceipt, isUnlocked: () => true },
    cache: { getAllAuthorizations: () => [AUTH], getPublicKey: async () => kp.publicKeyHex, getTrustedIssuer: async () => kp.issuer },
    proposalSubmissions: {
      get: (id: string) =>
        id === PROPOSAL.id
          ? {
              proposalId: PROPOSAL.id,
              tool: PROPOSAL.tool,
              toolArgsHash: hashToolArgs(PROPOSAL.toolArgs),
              executionContextHash: hashToolArgs(PROPOSAL.executionContext),
              authorizationId: PROPOSAL.authorizationId,
              profileId: PROPOSAL.profileId,
              submittedAt: Math.floor(Date.now() / 1000),
            }
          : undefined,
      record: vi.fn(),
    },
    gatekeeper: {
      verifyExecution: vi.fn().mockResolvedValue({
        result: { approved: true, errors: [] },
        authorization: AUTH,
      }),
    },
    executionLog: { record: vi.fn() },
    executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
    archiveReceipt: vi.fn().mockResolvedValue(undefined),
  } as unknown as SharedState;
  return { state, postReceipt };
}

function buildIntegrationManager() {
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"id":"c-1"}' }] });
  return {
    integrationManager: { getAllTools: () => [TOOL], callTool } as unknown as IntegrationManager,
    callTool,
  };
}

describe('AU10 — _source stripped before execution', () => {
  it('automatic path (tool-proxy.ts): the downstream tool never receives _source', async () => {
    const { state } = buildState();
    const { integrationManager, callTool } = buildIntegrationManager();

    const result = await createGatedToolHandler(TOOL, integrationManager, state)({ ...ARGS });

    expect((result as { isError?: boolean }).isError).not.toBe(true);
    expect(callTool).toHaveBeenCalledOnce();
    const outgoingArgs = callTool.mock.calls[0][2] as Record<string, unknown>;
    expect('_source' in outgoingArgs).toBe(false);
  });

  it('review/committed-executor path (commitments.ts): the downstream tool never receives _source', async () => {
    const { state } = buildState();
    const { integrationManager, callTool } = buildIntegrationManager();

    const outcome = await executeCommitted(PROPOSAL, state, integrationManager);

    expect(outcome.isError).not.toBe(true);
    expect(callTool).toHaveBeenCalledOnce();
    const outgoingArgs = callTool.mock.calls[0][2] as Record<string, unknown>;
    expect('_source' in outgoingArgs).toBe(false);
  });

  it('_source still travels as part of what the proposal records (for the card) — not silently dropped before submission', async () => {
    // Deferred-commitment path: create a SEPARATE authorization requiring
    // approval, so the call submits a proposal instead of executing.
    const kp = testReceiptKeypair();
    const deferredAuth = {
      ...AUTH,
      authorizationId: 'authz_00000000-0000-4000-8000-00000000defd',
      deferredCommitmentDomains: ['owner'],
    } as unknown as CachedAuthorization;
    const submitProposal = vi.fn().mockResolvedValue({ proposal: { id: 'prop-new' }, unreadableFor: [] });
    const state = {
      getEnrichedAuthorizations: () => [{ ...deferredAuth, gateContent: null } as EnrichedAuthorization],
      spClient: { postReceipt: vi.fn(), submitProposal, isUnlocked: () => true, getAuthorizationSummary: vi.fn().mockResolvedValue(null) },
      cache: { getAllAuthorizations: () => [deferredAuth], getPublicKey: async () => kp.publicKeyHex, getTrustedIssuer: async () => kp.issuer },
      proposalSubmissions: { record: vi.fn(), get: () => undefined },
      gatekeeper: { verifyExecution: vi.fn().mockResolvedValue({ result: { approved: true, errors: [] }, authorization: deferredAuth }) },
      executionLog: { record: vi.fn() },
      executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
      archiveReceipt: vi.fn().mockResolvedValue(undefined),
    } as unknown as SharedState;
    const { integrationManager, callTool } = buildIntegrationManager();

    await createGatedToolHandler(TOOL, integrationManager, state)({ ...ARGS });

    expect(callTool).not.toHaveBeenCalled(); // nothing executes yet
    expect(submitProposal).toHaveBeenCalledOnce();
    const submitted = submitProposal.mock.calls[0][0] as { toolArgs: Record<string, unknown> };
    expect(submitted.toolArgs._source).toEqual(SOURCE);
  });
});
