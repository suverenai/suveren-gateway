/**
 * A revoked mandate must fall back to another valid mandate on the SAME
 * profile within the very same call — not fail and "self-heal" only on the
 * NEXT call.
 *
 * Found via hap-e2e `test/simulation-setup` (setup mandate revoked → work
 * mandate remains): the local cache can still offer a mandate the Authority
 * Server has since revoked (expired, or no longer has any record of). Before
 * this fix, tool-proxy.ts purged the dead entry from the cache on a 403
 * ("revoked" in the message) but returned the refusal straight to the
 * caller — the call failed even though a second, perfectly valid mandate for
 * the same profile existed and would have authorized it.
 *
 * Scenario here deliberately mirrors the real one: two mandates on the sales
 * profile (shipped `sales@0.2`, not an inline copy, per engineering.md §6),
 * named `work`/`setup` in the real bug. `work` sorts first lexicographically
 * (authz_a... < authz_b...) so scope-specificity's fail-safe tiebreak always
 * selects it first when both pass local verification — exactly reproducing
 * "the first call after a revoke picks the dead mandate".
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerProfile } from '@hap/core';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import { SPReceiptError } from '../src/lib/sp-client';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { CachedAuthorization } from '../src/lib/attestation-cache';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import { testReceiptKeypair, makeSignedReceipt } from './helpers/real-receipt';

const profilesDir =
  process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');
const SALES = JSON.parse(readFileSync(join(profilesDir, 'sales', '0.2.profile.json'), 'utf8'));

beforeAll(() => {
  registerProfile(SALES.id, SALES);
});

const TOOL: DiscoveredTool = {
  originalName: 'load_simulation',
  namespacedName: 'erp__load_simulation',
  integrationId: 'erp',
  description: '',
  inputSchema: { type: 'object', properties: {} },
  gating: {
    profile: 'sales',
    executionMapping: {},
    staticExecution: { action_type: 'setup' },
  } as unknown as DiscoveredTool['gating'],
};

/** Bounds that allow `setup` for both candidates — zeroCappedBound must never skip either. */
const BOUNDS = {
  read_access: 'unlimited',
  value_max: 1000,
  discount_max: 0,
  order_value_daily_max: 1000,
  quote_daily_max: 0,
  send_daily_max: 0,
  order_daily_max: 0,
  setup_daily_max: 1,
};

function makeAuth(id: string): CachedAuthorization {
  return {
    authorizationId: id,
    profileId: SALES.id,
    path: 'sales-routine',
    frame: BOUNDS,
    bounds: BOUNDS,
    context: { currency: 'EUR' },
    attestations: [],
    requiredDomains: [],
    attestedDomains: [],
    deferredCommitmentDomains: [],
    complete: true,
  } as unknown as CachedAuthorization;
}

// `work` sorts before `setup` so it is the fail-safe tiebreak's first pick —
// matching the real bug's naming and ordering exactly.
const WORK = makeAuth('authz_a0000000-0000-4000-8000-00000000a001');
const SETUP = makeAuth('authz_b0000000-0000-4000-8000-00000000b002');

const revokedError = () =>
  new SPReceiptError('This authorization has been revoked', 403, {
    errors: [{ code: 'MANDATE_REVOKED', message: 'This authorization has been revoked' }],
  });

const limitExceededError = () =>
  new SPReceiptError('Cumulative daily count (2) exceeds setup_daily_max=1', 403, {
    errors: [{ code: 'BOUND_EXCEEDED', message: 'Cumulative daily count (2) exceeds setup_daily_max=1' }],
  });

// Item 9 (re-approval UX) — the AS's ticket route returns this at 409 for a
// stored pre-0.7 mandate (protocol.md -> Error Codes: VERSION_UNSUPPORTED).
const versionUnsupportedError = () =>
  new SPReceiptError('This authorization was signed under a pre-0.7 protocol version. Please re-approve this mandate.', 409, {
    errors: [{ code: 'VERSION_UNSUPPORTED', message: 'Please re-approve this mandate.' }],
  });

function buildState(
  enriched: EnrichedAuthorization[],
  postReceipt: ReturnType<typeof vi.fn>,
  kp: ReturnType<typeof testReceiptKeypair>,
) {
  const invalidate = vi.fn();
  const markNeedsReapproval = vi.fn();
  const state = {
    getEnrichedAuthorizations: () => enriched,
    spClient: { postReceipt, isUnlocked: () => true },
    cache: {
      invalidate,
      markNeedsReapproval,
      getPublicKey: async () => kp.publicKeyHex,
      getTrustedIssuer: async () => kp.issuer,
    },
    gatekeeper: {
      // Local verification always approves here — the test is about the AS's
      // receipt-time refusal and the gateway's reaction to it, not local
      // bound evaluation (covered elsewhere, e.g. zero-capped-selection.test.ts).
      verifyExecution: vi.fn().mockResolvedValue({ result: { approved: true, errors: [] } }),
    },
    executionLog: { record: vi.fn() },
    executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
    archiveReceipt: vi.fn().mockResolvedValue(undefined),
  } as unknown as SharedState;
  return { state, invalidate, markNeedsReapproval };
}

function buildIntegrationManager() {
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  return { integrationManager: { getAllTools: () => [TOOL], callTool } as unknown as IntegrationManager, callTool };
}

describe('stale-mandate fallback (revoked / expired / not-found)', () => {
  it('a revoked mandate falls back to the remaining valid mandate — the tool executes exactly once', async () => {
    const enriched = [
      { ...WORK, gateContent: null } as EnrichedAuthorization,
      { ...SETUP, gateContent: null } as EnrichedAuthorization,
    ];
    const kp = testReceiptKeypair();
    const postReceipt = vi.fn().mockImplementation(async (req: {
      authorizationId: string;
      action: string;
      executionContext?: Record<string, unknown>;
      idempotencyKey?: string;
      contentHash?: string;
      contentBinding?: { version: string; kind: string; fields?: string[] };
    }) => {
      if (req.authorizationId === WORK.authorizationId) throw revokedError();
      // sales@0.2 declares a (binding-wide, no `fields`) content_binding, so
      // every receipt request carries a contentHash/contentBinding that
      // ticket-verify.ts checks the echoed receipt against — echo it back
      // exactly like the real AS does, same as receipt-privacy.test.ts.
      return { receipt: makeSignedReceipt(kp, {
        action: req.action,
        executionContext: req.executionContext ?? {},
        authorizationId: req.authorizationId,
        profileId: SALES.id,
        idempotencyKey: req.idempotencyKey,
        contentHash: req.contentHash,
        contentBinding: req.contentBinding,
      }) };
    });
    const { state, invalidate } = buildState(enriched, postReceipt, kp);
    const { integrationManager, callTool } = buildIntegrationManager();

    const result = await createGatedToolHandler(TOOL, integrationManager, state)({});

    expect(result.isError).toBeFalsy();
    // Exactly two ticket requests: the dead mandate, then the fallback.
    expect(postReceipt).toHaveBeenCalledTimes(2);
    expect(postReceipt.mock.calls[0][0].authorizationId).toBe(WORK.authorizationId);
    expect(postReceipt.mock.calls[1][0].authorizationId).toBe(SETUP.authorizationId);
    // The revoked mandate is purged from the cache so later calls stop offering it.
    expect(invalidate).toHaveBeenCalledWith(WORK.authorizationId);
    // The tool executes exactly ONCE, and only after the fallback ticket issued.
    expect(callTool).toHaveBeenCalledTimes(1);
    // Each attempt generates its own idempotencyKey — a retry under a
    // different mandate is a different ticket request, so there is no risk
    // of IDEMPOTENCY_MISMATCH (same key, different authorizationId) and no
    // double counting (the AS never issued a ticket for the dead mandate).
    expect(postReceipt.mock.calls[0][0].idempotencyKey).not.toBe(postReceipt.mock.calls[1][0].idempotencyKey);
  });

  it('revoked with no alternative mandate fails with the Authority Server\'s own reason', async () => {
    const enriched = [{ ...WORK, gateContent: null } as EnrichedAuthorization];
    const postReceipt = vi.fn().mockRejectedValue(revokedError());
    const { state, invalidate } = buildState(enriched, postReceipt, testReceiptKeypair());
    const { integrationManager, callTool } = buildIntegrationManager();

    const result = await createGatedToolHandler(TOOL, integrationManager, state)({});

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('revoked');
    expect(postReceipt).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith(WORK.authorizationId);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('BOUND_EXCEEDED (LIMIT_EXCEEDED) is never retried — fails closed exactly as before', async () => {
    const enriched = [
      { ...WORK, gateContent: null } as EnrichedAuthorization,
      { ...SETUP, gateContent: null } as EnrichedAuthorization,
    ];
    const postReceipt = vi.fn().mockRejectedValue(limitExceededError());
    const { state } = buildState(enriched, postReceipt, testReceiptKeypair());
    const { integrationManager, callTool } = buildIntegrationManager();

    const result = await createGatedToolHandler(TOOL, integrationManager, state)({});

    expect(result.isError).toBe(true);
    // Only the first-chosen mandate (work) was ever asked — a bound refusal
    // is about the CALL, not the mandate's validity, so it must never
    // trigger a fallback to the sibling mandate.
    expect(postReceipt).toHaveBeenCalledTimes(1);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('repeated revoked responses are bounded — tries each candidate at most once, then fails', async () => {
    const THIRD = makeAuth('authz_c0000000-0000-4000-8000-00000000c003');
    const enriched = [
      { ...WORK, gateContent: null } as EnrichedAuthorization,
      { ...SETUP, gateContent: null } as EnrichedAuthorization,
      { ...THIRD, gateContent: null } as EnrichedAuthorization,
    ];
    const postReceipt = vi.fn().mockRejectedValue(revokedError());
    const { state, invalidate } = buildState(enriched, postReceipt, testReceiptKeypair());
    const { integrationManager, callTool } = buildIntegrationManager();

    const result = await createGatedToolHandler(TOOL, integrationManager, state)({});

    expect(result.isError).toBe(true);
    // Exactly one attempt per candidate — never a second attempt for an
    // already-tried id, never an infinite loop against an AS that keeps
    // refusing.
    expect(postReceipt).toHaveBeenCalledTimes(3);
    const triedIds = postReceipt.mock.calls.map((c) => c[0].authorizationId);
    expect(new Set(triedIds).size).toBe(3);
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('re-approval UX (item 9) — VERSION_UNSUPPORTED', () => {
  it('flags the mandate (never invalidates it) and falls back to another candidate', async () => {
    const enriched = [
      { ...WORK, gateContent: null } as EnrichedAuthorization,
      { ...SETUP, gateContent: null } as EnrichedAuthorization,
    ];
    const kp = testReceiptKeypair();
    const postReceipt = vi.fn().mockImplementation(async (req: {
      authorizationId: string;
      action: string;
      executionContext?: Record<string, unknown>;
      idempotencyKey?: string;
      contentHash?: string;
      contentBinding?: { version: string; kind: string; fields?: string[] };
    }) => {
      if (req.authorizationId === WORK.authorizationId) throw versionUnsupportedError();
      return { receipt: makeSignedReceipt(kp, {
        action: req.action,
        executionContext: req.executionContext ?? {},
        authorizationId: req.authorizationId,
        profileId: SALES.id,
        idempotencyKey: req.idempotencyKey,
        contentHash: req.contentHash,
        contentBinding: req.contentBinding,
      }) };
    });
    const { state, invalidate, markNeedsReapproval } = buildState(enriched, postReceipt, kp);
    const { integrationManager, callTool } = buildIntegrationManager();

    const result = await createGatedToolHandler(TOOL, integrationManager, state)({});

    expect(result.isError).toBeFalsy();
    expect(postReceipt).toHaveBeenCalledTimes(2);
    expect(postReceipt.mock.calls[1][0].authorizationId).toBe(SETUP.authorizationId);
    // Flagged for the UI/brief to surface — but NOT dropped from the cache:
    // its record is still live, only its blob's wire version is obsolete.
    expect(markNeedsReapproval).toHaveBeenCalledWith(WORK.authorizationId);
    expect(invalidate).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('with no alternative mandate, refuses naming re-approval as the action — and still flags it', async () => {
    const enriched = [{ ...WORK, gateContent: null } as EnrichedAuthorization];
    const postReceipt = vi.fn().mockRejectedValue(versionUnsupportedError());
    const { state, invalidate, markNeedsReapproval } = buildState(enriched, postReceipt, testReceiptKeypair());
    const { integrationManager, callTool } = buildIntegrationManager();

    const result = await createGatedToolHandler(TOOL, integrationManager, state)({});

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('needs re-approval');
    expect(text).toContain('Ask the decision owner to re-approve it');
    expect(markNeedsReapproval).toHaveBeenCalledWith(WORK.authorizationId);
    expect(invalidate).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });
});
