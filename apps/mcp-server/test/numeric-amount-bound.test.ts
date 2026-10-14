/**
 * The Mollie `amount` bug, end to end through tool-proxy.ts's write path —
 * github.com/humanagencyprotocol/hap-profiles/charge@0.6, repro from
 * suveren-gateway bug report (review mode, amount_max 10 EUR):
 *
 *   1. amount "0.10" (string, what Mollie's own schema requires) used to be
 *      refused by the Gatekeeper before any proposal: a `string` can't be
 *      compared against `amount_max`'s `number`.
 *   2. amount 0.10 (number) used to pass the Gatekeeper, but Mollie then
 *      rejected it at execution — its schema wants a string back.
 *
 * So no amount passed both. These pin, through the REAL write path (not just
 * the helper unit-tested in numeric-execution.test.ts), that a numeric
 * STRING argument:
 *   - reaches the Gatekeeper's `execution` object as a NUMBER (so the bound
 *     comparison it does — unchanged, hap-core's own logic — now runs against
 *     the right type), and the same parsed number travels to the Authority
 *     Server in the receipt request (`executionContext.amount` / `amount`);
 *   - reaches the DOWNSTREAM tool call completely UNCHANGED — still the
 *     exact original string, because Mollie's schema is the one requirement
 *     the gateway has no say over.
 *
 * `gatekeeper.verifyExecution` is a test double here (as in
 * receipt-privacy.test.ts) so these tests isolate tool-proxy.ts's OWN
 * responsibility — building `execution` and forwarding `args` — from
 * hap-core's bound-comparison logic, which is unit-tested in hap-core itself
 * and is not what regressed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerProfile, clearProfiles, type AgentProfile } from '@hap/core';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { CachedAuthorization } from '../src/lib/attestation-cache';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import { testReceiptKeypair, makeSignedReceipt } from './helpers/real-receipt';

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/charge-amount-test@1';
const SHORT = 'charge-amount-test';

const PROFILE: AgentProfile = {
  id: PROFILE_ID,
  version: '1',
  description: 'test — mirrors charge@0.6\'s amount shape',
  // Only what wireExecutionContext (tool-proxy.ts, Item 7) needs to allow
  // "amount" onto the wire to the Authority Server — the real charge@0.6
  // profile's amount_max bound, trimmed to its boundType.
  boundsSchema: {
    keyOrder: ['profile', 'amount_max'],
    fields: {
      profile: { type: 'string', required: true },
      amount_max: {
        type: 'number',
        required: true,
        boundType: { kind: 'per_transaction', of: 'amount' },
      },
    },
  },
  executionContextSchema: {
    fields: {
      action_type: { source: 'declared', description: '', required: true, constraint: { type: 'string', enforceable: ['enum'] } },
      amount: { source: 'declared', description: '', required: true, constraint: { type: 'number', enforceable: ['max'] } },
      currency: { source: 'declared', description: '', required: true, constraint: { type: 'string', enforceable: ['enum'] } },
    },
  },
  requiredGates: [],
  ttl: { default: 1, max: 1 },
  retention_minimum: 1,
};

/** The Mollie CreatePaymentLink shape: direct executionMapping amount→amount. */
const TOOL: DiscoveredTool = {
  originalName: 'CreatePaymentLink',
  namespacedName: 'mollie__CreatePaymentLink',
  integrationId: 'mollie',
  description: '',
  inputSchema: { type: 'object', properties: { amount: { type: 'string' }, currency: {}, testmode: {} } },
  gating: {
    profile: SHORT,
    executionMapping: { amount: 'amount', currency: 'currency' },
    staticExecution: { action_type: 'charge' },
  } as unknown as DiscoveredTool['gating'],
};

const AUTH: CachedAuthorization = {
  authorizationId: 'authz_00000000-0000-4000-8000-00000000cafe',
  profileId: PROFILE_ID,
  path: 'charge-routine',
  frame: { profile: PROFILE_ID, path: 'charge-routine' },
  attestations: [],
  requiredDomains: [],
  attestedDomains: [],
  complete: true,
} as unknown as CachedAuthorization;

function buildState(verifyExecution: ReturnType<typeof vi.fn>) {
  const kp = testReceiptKeypair();
  const postReceipt = vi.fn().mockImplementation(async (req: {
    action: string;
    executionContext?: Record<string, unknown>;
    authorizationId?: string;
    profileId?: string;
    amount?: number;
    idempotencyKey?: string;
  }) => ({
    receipt: makeSignedReceipt(kp, {
      id: 'rcpt-1',
      action: req.action,
      executionContext: req.executionContext ?? {},
      authorizationId: req.authorizationId,
      profileId: req.profileId,
      idempotencyKey: req.idempotencyKey,
    }),
  }));
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
  return { state, postReceipt };
}

function buildIntegrationManager() {
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"id":"tr_1"}' }] });
  return {
    integrationManager: { getAllTools: () => [TOOL], callTool } as unknown as IntegrationManager,
    callTool,
  };
}

/** Approves unconditionally — these tests are about WHAT tool-proxy hands the
 * Gatekeeper, not hap-core's own bound comparison (see file header). */
function approvingGatekeeper() {
  return vi.fn().mockResolvedValue({ result: { approved: true, errors: [] }, authorization: AUTH });
}

beforeEach(() => {
  // The real gateway (profile-loader.ts) registers a profile under BOTH its
  // full id and its short name ("charge") — `tool.gating.profile` always
  // carries the short form, so tool-proxy.ts's profile lookups resolve
  // through that, not the full id.
  registerProfile(PROFILE_ID, PROFILE);
  registerProfile(SHORT, PROFILE);
});
afterEach(() => clearProfiles());

describe('Mollie amount: a numeric STRING argument', () => {
  it('reaches the Gatekeeper as a NUMBER, not the original string', async () => {
    const verifyExecution = approvingGatekeeper();
    const { state } = buildState(verifyExecution);
    const { integrationManager } = buildIntegrationManager();

    await createGatedToolHandler(TOOL, integrationManager, state)({
      amount: '0.10',
      currency: 'EUR',
      testmode: true,
    });

    expect(verifyExecution).toHaveBeenCalledOnce();
    const execution = verifyExecution.mock.calls[0][1] as Record<string, unknown>;
    expect(execution.amount).toBe(0.10);
    expect(typeof execution.amount).toBe('number');
  });

  it('reaches the downstream tool call UNCHANGED — still the original string', async () => {
    const verifyExecution = approvingGatekeeper();
    const { state } = buildState(verifyExecution);
    const { integrationManager, callTool } = buildIntegrationManager();

    await createGatedToolHandler(TOOL, integrationManager, state)({
      amount: '0.10',
      currency: 'EUR',
      testmode: true,
    });

    expect(callTool).toHaveBeenCalledOnce();
    const outgoingArgs = callTool.mock.calls[0][2] as Record<string, unknown>;
    expect(outgoingArgs.amount).toBe('0.10');
    expect(typeof outgoingArgs.amount).toBe('string');
  });

  it('reaches the Authority Server receipt request as a NUMBER (executionContext.amount)', async () => {
    const verifyExecution = approvingGatekeeper();
    const { state, postReceipt } = buildState(verifyExecution);
    const { integrationManager } = buildIntegrationManager();

    await createGatedToolHandler(TOOL, integrationManager, state)({
      amount: '0.10',
      currency: 'EUR',
      testmode: true,
    });

    expect(postReceipt).toHaveBeenCalledOnce();
    const sent = postReceipt.mock.calls[0][0] as { executionContext: Record<string, unknown>; amount?: number };
    expect(sent.executionContext.amount).toBe(0.10);
    expect(typeof sent.executionContext.amount).toBe('number');
    // Item 7's `amount` top-level field (tool-proxy.ts) is only ever sent
    // when `execution.amount` is already a number — before this fix a
    // string amount silently sent `undefined` here.
    expect(sent.amount).toBe(0.10);
  });

  it('CreateCapture\'s amount_value→amount mapping gets the same fix (no Mollie-specific code)', async () => {
    const captureTool: DiscoveredTool = {
      ...TOOL,
      originalName: 'CreateCapture',
      namespacedName: 'mollie__CreateCapture',
      gating: {
        profile: SHORT,
        executionMapping: { amount_value: 'amount', amount_currency: 'currency' },
        staticExecution: { action_type: 'charge' },
      } as unknown as DiscoveredTool['gating'],
    };
    const verifyExecution = approvingGatekeeper();
    const { state } = buildState(verifyExecution);
    const { integrationManager, callTool } = buildIntegrationManager();
    (integrationManager.getAllTools as () => DiscoveredTool[]) = () => [captureTool];

    await createGatedToolHandler(captureTool, integrationManager, state)({
      amount_value: '1.00',
      amount_currency: 'EUR',
    });

    const execution = verifyExecution.mock.calls[0][1] as Record<string, unknown>;
    expect(execution.amount).toBe(1.00);
    const outgoingArgs = callTool.mock.calls[0][2] as Record<string, unknown>;
    expect(outgoingArgs.amount_value).toBe('1.00');
  });

  it('a malformed numeric string is left as-is — the Gatekeeper still sees it and can refuse it', async () => {
    // "1e3" is exactly the kind of value Number() would silently accept —
    // parseNumericString refuses it, so it reaches the Gatekeeper unchanged
    // and hap-core's own type-mismatch bound check (unit-tested there) still
    // has something to refuse.
    const verifyExecution = approvingGatekeeper();
    const { state } = buildState(verifyExecution);
    const { integrationManager } = buildIntegrationManager();

    await createGatedToolHandler(TOOL, integrationManager, state)({
      amount: '1e3',
      currency: 'EUR',
    });

    const execution = verifyExecution.mock.calls[0][1] as Record<string, unknown>;
    expect(execution.amount).toBe('1e3');
  });
});

describe('Mollie amount: a NUMBER argument (the other half of the original bug)', () => {
  it('still reaches the downstream tool call unchanged, as a number', async () => {
    // Before this fix, sending a number made the Gatekeeper pass but Mollie
    // reject it (it wants a string). This fix is entirely about the STRING
    // case above — a number argument was never touched and must stay that
    // way: this call is forwarded exactly as received.
    const verifyExecution = approvingGatekeeper();
    const { state } = buildState(verifyExecution);
    const { integrationManager, callTool } = buildIntegrationManager();

    await createGatedToolHandler(TOOL, integrationManager, state)({
      amount: 0.10,
      currency: 'EUR',
    });

    const outgoingArgs = callTool.mock.calls[0][2] as Record<string, unknown>;
    expect(outgoingArgs.amount).toBe(0.10);
    expect(typeof outgoingArgs.amount).toBe('number');
  });
});
