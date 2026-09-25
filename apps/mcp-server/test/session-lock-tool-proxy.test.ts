/**
 * A 401 from the AS on a gated call must produce the 'expired' locked notice
 * — not the old "SP unavailable — tool call blocked. Authentication
 * required", which read like a transient fault and never told the agent (or,
 * relayed, the human) what actually happened or how to fix it.
 *
 * SPClient itself is responsible for clearing its cookie the instant it sees
 * a 401 (pinned in session-expiry.test.ts); these tests only need
 * `isUnlocked()` to reflect that AFTER the failing call, exactly as the real
 * client would leave it. Built on the same harness as receipt-privacy.test.ts.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { registerProfile, clearProfiles } from '@hap/core';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { CachedAuthorization } from '../src/lib/attestation-cache';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import { SPReceiptError } from '../src/lib/sp-client';

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/session-lock-test@0.5';
const SHORT = 'session-lock-test';

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

afterAll(() => {
  clearProfiles();
});

const TOOL: DiscoveredTool = {
  originalName: 'create_charge',
  namespacedName: 'charge__create_charge',
  integrationId: 'charge',
  description: '',
  inputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
  gating: {
    profile: SHORT,
    executionMapping: {},
    staticExecution: { action_type: 'charge' },
  } as unknown as DiscoveredTool['gating'],
};

const AUTH: CachedAuthorization = {
  authorizationId: 'authz_00000000-0000-4000-8000-00000000face',
  profileId: PROFILE_ID,
  path: 'charge-routine',
  frame: { profile: PROFILE_ID, path: 'charge-routine' },
  attestations: [],
  requiredDomains: [],
  attestedDomains: [],
  complete: true,
} as unknown as CachedAuthorization;

/**
 * `isUnlocked` starts true (the lockedGuard pre-check must pass to reach
 * postReceipt at all) and flips to false — exactly what SPClient.fetch()
 * does internally the moment it sees the 401, before the rejection even
 * reaches this handler's catch block.
 */
function buildState(postReceiptError: unknown) {
  let unlocked = true;
  const postReceipt = vi.fn().mockImplementation(async () => {
    unlocked = false;
    throw postReceiptError;
  });
  const enriched: EnrichedAuthorization[] = [{ ...AUTH, gateContent: null } as EnrichedAuthorization];
  const state = {
    getEnrichedAuthorizations: () => enriched,
    spClient: { postReceipt, isUnlocked: () => unlocked, getLockReason: () => (unlocked ? null : 'expired') },
    cache: { getAllAuthorizations: () => [AUTH], invalidate: vi.fn() },
    gatekeeper: {
      verifyExecution: vi.fn().mockResolvedValue({ result: { approved: true, errors: [] }, authorization: AUTH }),
    },
    executionLog: { record: vi.fn() },
    executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
    archiveReceipt: vi.fn(),
  } as unknown as SharedState;
  return { state, postReceipt };
}

function buildIntegrationManager() {
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  return { integrationManager: { getAllTools: () => [TOOL], callTool } as unknown as IntegrationManager, callTool };
}

describe('gated write tool — the AS session ending mid-call', () => {
  it('a 401 (session expired) returns the EXPIRED locked notice, not "SP unavailable"', async () => {
    const err = new SPReceiptError('Authentication required', 401, { error: 'Authentication required' });
    const { state, postReceipt } = buildState(err);
    const { integrationManager, callTool } = buildIntegrationManager();

    const result = await createGatedToolHandler(TOOL, integrationManager, state)({ amount: 10 });

    expect(postReceipt).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('LOCKED');
    expect(text).toContain("sign-in has ended");
    expect(text).toContain('30 days');
    expect(text).not.toContain('SP unavailable');
    expect(text).not.toContain('Authentication required');
    // The lock is real by the time the agent reads the notice — no execution.
    expect(state.spClient.isUnlocked()).toBe(false);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('a network error still fails closed with the OLD generic message — not a lock', async () => {
    const { state, postReceipt } = buildState(new TypeError('fetch failed'));
    const { integrationManager, callTool } = buildIntegrationManager();
    // Network failure must not touch isUnlocked — override the harness's
    // "unlocked flips false on any postReceipt throw" so this test's fake
    // matches what SPClient really does (only a 401 flips it).
    (state.spClient as unknown as { isUnlocked: () => boolean }).isUnlocked = () => true;

    const result = await createGatedToolHandler(TOOL, integrationManager, state)({ amount: 10 });

    expect(postReceipt).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SP unavailable');
    expect(result.content[0].text).not.toContain('LOCKED');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('a 500 (after retries) also stays a plain SP failure, not a lock', async () => {
    const err = new SPReceiptError('SP receipt request failed: 500', 500, {});
    const { state, postReceipt } = buildState(err);
    (state.spClient as unknown as { isUnlocked: () => boolean }).isUnlocked = () => true;
    const { integrationManager, callTool } = buildIntegrationManager();

    const result = await createGatedToolHandler(TOOL, integrationManager, state)({ amount: 10 });

    expect(postReceipt).toHaveBeenCalledOnce();
    expect(result.content[0].text).toContain('SP unavailable');
    expect(result.content[0].text).not.toContain('LOCKED');
    expect(callTool).not.toHaveBeenCalled();
  });
});
