/**
 * v0.8 wire, through tool-proxy.ts's REAL automatic write path:
 *
 *  - A3 (protocol.md → Ticket Request Schema, rules 7–8): only what a bound
 *    reads travels — no scope value, no `action_type` inside executionContext
 *    (it travels once, as `actionType`), no `_` key. The request is
 *    inspected here.
 *  - A2 (rule 1): the request names the mandate by its signed `mandate_id`.
 *  - A3 (Ticket Issuance, stage 7): a negative or non-numeric value a bound
 *    reads is refused locally; under an automatic mandate an absent amount
 *    under a governing `cumulative_sum` bound is refused locally too. Neither
 *    reaches the Gatekeeper's AS round trip.
 *  - A2 (Ticket Payload Schema, rule 4): a ticket naming a mandate outside
 *    the grant is refused (TICKET_REQUEST_MISMATCH), the tool never runs.
 *
 * Only the Authority Server's HTTP call is a test double (signing for real).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerProfile, clearProfiles, type AgentProfile } from '@hap/core';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { CachedAuthorization } from '../src/lib/attestation-cache';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import { testReceiptKeypair, makeSignedReceipt, echoTicketRequest } from './helpers/real-receipt';

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/charge-v08-test@1';
const SHORT = 'charge-v08-test';

const PROFILE: AgentProfile = {
  id: PROFILE_ID,
  version: '1',
  description: 'test — a sum bound without appliesTo, plus a scope field',
  boundsSchema: {
    keyOrder: ['profile', 'amount_max', 'amount_daily_max'],
    fields: {
      profile: { type: 'string', required: true },
      amount_max: { type: 'number', required: true, boundType: { kind: 'per_transaction', of: 'amount' } },
      amount_daily_max: { type: 'number', required: true, boundType: { kind: 'cumulative_sum', of: 'amount', window: 'daily' } },
    },
  },
  executionContextSchema: {
    fields: {
      action_type: { source: 'declared', description: '', required: true, constraint: { type: 'string', enforceable: ['enum'] } },
      amount: { source: 'declared', description: '', required: false, constraint: { type: 'number', enforceable: ['max'] } },
      currency: { source: 'declared', description: '', required: false, constraint: { type: 'string', enforceable: ['enum'] } },
    },
  },
  requiredGates: [],
  ttl: { default: 1, max: 1 },
  retention_minimum: 1,
} as unknown as AgentProfile;

const TOOL: DiscoveredTool = {
  originalName: 'CreatePaymentLink',
  namespacedName: 'mollie__CreatePaymentLink',
  integrationId: 'mollie',
  description: '',
  inputSchema: { type: 'object', properties: { amount: {}, currency: {} } },
  gating: {
    profile: SHORT,
    executionMapping: { amount: 'amount', currency: 'currency' },
    staticExecution: { action_type: 'charge' },
  } as unknown as DiscoveredTool['gating'],
};

const AUTH: CachedAuthorization = {
  authorizationId: 'authz_00000000-0000-4000-8000-0000000v08aa',
  boundsHash: 'sha256:bounds-v08',
  profileId: PROFILE_ID,
  path: 'charge-routine',
  frame: { profile: PROFILE_ID, path: 'charge-routine' },
  attestations: [],
  requiredDomains: [],
  attestedDomains: [],
  deferredCommitmentDomains: [],
  signedCommitmentMode: 'automatic',
  mandateId: 'mandate-live',
  mandateIds: ['mandate-expired', 'mandate-live'],
  mandateVersion: '0.8',
  complete: true,
} as unknown as CachedAuthorization;

function buildState(ticketOverrides: Record<string, unknown> = {}) {
  const kp = testReceiptKeypair();
  const postReceipt = vi.fn().mockImplementation(async (req: Record<string, unknown>) => ({
    receipt: makeSignedReceipt(kp, {
      id: 'rcpt-v08',
      action: req.action as string,
      ...echoTicketRequest(req),
      executionContext: (req.executionContext ?? {}) as Record<string, unknown>,
      authorizationId: req.authorizationId,
      profileId: req.profileId,
      idempotencyKey: req.idempotencyKey,
      ...ticketOverrides,
    }),
    idempotent: false,
  }));
  const verifyExecution = vi.fn().mockResolvedValue({ result: { approved: true, errors: [] }, authorization: AUTH });
  const enriched: EnrichedAuthorization[] = [{ ...AUTH, gateContent: null } as EnrichedAuthorization];
  const state = {
    getEnrichedAuthorizations: () => enriched,
    spClient: { postReceipt, isUnlocked: () => true },
    cache: { getAllAuthorizations: () => [AUTH], getPublicKey: async () => kp.publicKeyHex, getTrustedIssuer: async () => kp.issuer },
    gatekeeper: { verifyExecution },
    executionLog: { record: vi.fn() },
    executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
    archiveReceipt: vi.fn().mockResolvedValue(undefined),
  } as unknown as SharedState;
  return { state, postReceipt, verifyExecution };
}

function buildIntegrationManager() {
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"id":"tr_1"}' }] });
  return { integrationManager: { getAllTools: () => [TOOL], callTool } as unknown as IntegrationManager, callTool };
}

beforeEach(() => registerProfile(PROFILE_ID, PROFILE));
afterEach(() => clearProfiles());

describe('v0.8 ticket request — only what a bound reads travels', () => {
  it('sends executionContext {amount} only, actionType beside it, and the live mandate id', async () => {
    const { state, postReceipt } = buildState();
    const { integrationManager, callTool } = buildIntegrationManager();

    const result = await createGatedToolHandler(TOOL, integrationManager, state)({ amount: 5, currency: 'EUR', _source: 'crm:1' });

    expect(result.isError, result.content[0].text).toBeFalsy();
    const req = postReceipt.mock.calls[0][0] as Record<string, unknown>;
    expect(req.executionContext).toEqual({ amount: 5 });
    expect(req.actionType).toBe('charge');
    expect(req.mandateId).toBe('mandate-live');
    expect(req.boundsHash).toBe('sha256:bounds-v08');
    expect(JSON.stringify(req)).not.toContain('EUR');
    expect(JSON.stringify(req)).not.toContain('crm:1');
    expect(callTool).toHaveBeenCalledOnce();
  });

  it('accepts a ticket naming another of the grant\'s own mandates (the AS picks the live one)', async () => {
    const { state } = buildState({ mandateId: 'mandate-expired' });
    const { integrationManager, callTool } = buildIntegrationManager();
    const result = await createGatedToolHandler(TOOL, integrationManager, state)({ amount: 5 });
    expect(result.isError, result.content[0].text).toBeFalsy();
    expect(callTool).toHaveBeenCalledOnce();
  });

  it('refuses a ticket naming a mandate outside the grant — the tool never runs', async () => {
    const { state } = buildState({ mandateId: 'mandate-of-someone-else' });
    const { integrationManager, callTool } = buildIntegrationManager();
    const result = await createGatedToolHandler(TOOL, integrationManager, state)({ amount: 5 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/TICKET_REQUEST_MISMATCH/);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('refuses a ticket whose actionType is not the request\'s', async () => {
    const { state } = buildState({ actionType: 'refund' });
    const { integrationManager, callTool } = buildIntegrationManager();
    const result = await createGatedToolHandler(TOOL, integrationManager, state)({ amount: 5 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/TICKET_REQUEST_MISMATCH/);
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('v0.8 local refusals — before anything leaves the machine', () => {
  it('a negative amount is refused', async () => {
    const { state, postReceipt, verifyExecution } = buildState();
    const { integrationManager, callTool } = buildIntegrationManager();
    const result = await createGatedToolHandler(TOOL, integrationManager, state)({ amount: -5 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/finite, non-negative number/);
    expect(verifyExecution).not.toHaveBeenCalled();
    expect(postReceipt).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('an absent amount under a governing sum bound is refused under an automatic mandate', async () => {
    const { state, postReceipt } = buildState();
    const { integrationManager, callTool } = buildIntegrationManager();
    const result = await createGatedToolHandler(TOOL, integrationManager, state)({ currency: 'EUR' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/amount_daily_max/);
    expect(postReceipt).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('under a v0.7 mandate an absent amount is left to the Authority Server (0.7 rules)', async () => {
    const { state, postReceipt } = buildState();
    const enriched = state.getEnrichedAuthorizations();
    (enriched[0] as { mandateVersion?: string }).mandateVersion = '0.7';
    const { integrationManager, callTool } = buildIntegrationManager();
    const result = await createGatedToolHandler(TOOL, integrationManager, state)({ currency: 'EUR' });
    expect(result.isError, result.content[0].text).toBeFalsy();
    expect(postReceipt).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledOnce();
  });
});

describe('v0.8 review proposal — readers named by DID (protocol.md → Proposals, rule 2)', () => {
  function reviewState(version: '0.8' | '0.7') {
    const kp = testReceiptKeypair();
    const auth = {
      ...AUTH,
      authorizationId: 'authz_00000000-0000-4000-8000-0000000v08rv',
      signedCommitmentMode: 'review',
      deferredCommitmentDomains: ['owner'],
      mandateVersion: version,
      proposalReaders: { version, ownerDid: 'did:key:z6MkOwner', deciders: [] },
    } as unknown as CachedAuthorization;
    const submitProposal = vi.fn().mockResolvedValue({ proposal: { id: 'prop-v08' }, unreadableFor: [] });
    const state = {
      getEnrichedAuthorizations: () => [{ ...auth, gateContent: null } as EnrichedAuthorization],
      spClient: { postReceipt: vi.fn(), submitProposal, isUnlocked: () => true, getAuthorizationSummary: vi.fn().mockResolvedValue({ created_by: 'owner-id' }) },
      cache: { getAllAuthorizations: () => [auth], getPublicKey: async () => kp.publicKeyHex, getTrustedIssuer: async () => kp.issuer },
      proposalSubmissions: { record: vi.fn(), get: () => undefined },
      gatekeeper: { verifyExecution: vi.fn().mockResolvedValue({ result: { approved: true, errors: [] }, authorization: auth }) },
      executionLog: { record: vi.fn() },
      executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
      archiveReceipt: vi.fn().mockResolvedValue(undefined),
    } as unknown as SharedState;
    return { state, submitProposal };
  }

  it('under a 0.8 mandate the submission names the owner DID (and the signed deciders) as readers', async () => {
    const { state, submitProposal } = reviewState('0.8');
    const { integrationManager, callTool } = buildIntegrationManager();
    await createGatedToolHandler(TOOL, integrationManager, state)({ amount: 5, currency: 'EUR' });
    expect(callTool).not.toHaveBeenCalled();
    expect(submitProposal).toHaveBeenCalledOnce();
    const submitted = submitProposal.mock.calls[0][0] as { readers?: unknown; recipientUserIds: string[] };
    expect(submitted.readers).toEqual({ ownerDid: 'did:key:z6MkOwner', deciders: [] });
    expect(submitted.recipientUserIds).toEqual(['owner-id']);
  });

  it('under a 0.7 mandate nothing is added — readers stay by account id', async () => {
    const { state, submitProposal } = reviewState('0.7');
    const { integrationManager } = buildIntegrationManager();
    await createGatedToolHandler(TOOL, integrationManager, state)({ amount: 5, currency: 'EUR' });
    expect(submitProposal).toHaveBeenCalledOnce();
    expect((submitProposal.mock.calls[0][0] as { readers?: unknown }).readers).toBeUndefined();
  });
});
