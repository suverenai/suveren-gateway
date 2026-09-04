/**
 * The local execution log is DISPLAY-ONLY — it never gates a call.
 *
 * protocol.md → "Executor Gating, Context vs Bounds, Display-Only Logs":
 *
 *   Cumulative bounds (cumulative_sum, cumulative_count) are enforced solely
 *   by the AS because the Gatekeeper has no receipt history. […] A Gatekeeper
 *   MAY maintain a local record of executions for UI rendering. It MUST NOT
 *   use that record as a second-pass cumulative enforcement layer. […] v0.4
 *   reference implementations that re-checked cumulative bounds locally before
 *   calling the AS MUST drop the local check.
 *
 * The gateway handed its 31-day encrypted log to hap-core's `verify()`, so a
 * call over a cumulative bound was refused locally with
 * CUMULATIVE_LIMIT_EXCEEDED and the AS was never asked. Two copies of one
 * running total, and the local one is wrong in both directions: it is pruned
 * and per-machine (under-counts, so it permits nothing extra but also proves
 * nothing), and it counts local executions the AS may never have counted
 * (over-counts, so it blocks work the grant actually allows). Worse, it decides
 * BEFORE the only party that can refuse authoritatively has spoken.
 *
 * What must remain true, and is asserted here:
 *   1. a call over a cumulative bound is NOT blocked locally, and the receipt
 *      request still reaches the AS — which is what refuses it;
 *   2. per-transaction bounds are still enforced locally (the local gate is
 *      dropped for cumulative bounds only, not gutted);
 *   3. the log is still recorded and still drives the consumption display.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProfile, clearProfiles, verify, canonicalize, computeBoundsHash } from '@hap/core';
import { MCPGatekeeper } from '../src/lib/gatekeeper';
import { ExecutionLog } from '../src/lib/execution-log';
import { getConsumptionState } from '../src/lib/consumption';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import type { AttestationCache, CachedAuthorization } from '../src/lib/attestation-cache';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/charge-log-test@0.5';
const SHORT = 'charge-log-test';
const PATH = 'charge-routine';

/** Bounds: 100 per charge, 200 per day, 3 charges per day. */
const BOUNDS = {
  profile: PROFILE_ID,
  amount_max: 100,
  amount_daily_max: 200,
  transaction_count_daily_max: 3,
};

const PROFILE = {
  id: PROFILE_ID,
  version: '0.5',
  description: 'test',
  boundsSchema: {
    keyOrder: ['profile', 'amount_max', 'amount_daily_max', 'transaction_count_daily_max'],
    actionTypes: ['charge'],
    fields: {
      profile: { type: 'string', required: true },
      amount_max: {
        type: 'number', required: true, displayName: 'Per-charge limit',
        boundType: { kind: 'per_transaction', of: 'amount' },
      },
      amount_daily_max: {
        type: 'number', required: true, displayName: 'Daily charge limit',
        boundType: { kind: 'cumulative_sum', of: 'amount', window: 'daily' },
      },
      transaction_count_daily_max: {
        type: 'number', required: true, displayName: 'Daily charge count',
        boundType: { kind: 'cumulative_count', window: 'daily' },
      },
    },
  },
  executionContextSchema: { fields: {} },
  requiredGates: [],
  ttl: { default: 1, max: 1 },
  retention_minimum: 1,
};

const NOW = Math.floor(Date.now() / 1000);

/**
 * A genuinely signed attestation, because `verify()` fails closed on an empty
 * attestation list (hap-core 0.10.0) — as it must: a call with nothing to
 * verify is not a call that was authorised. An earlier version of this file
 * passed `attestations: []` and reached the bounds logic anyway, which was the
 * fail-open bug rather than a shortcut. Signing here costs ten lines and makes
 * every assertion below run against a mandate that actually verifies.
 */
const { privateKey: AS_PRIVATE, publicKey: AS_PUBLIC } = generateKeyPairSync('ed25519');
const AS_PUBLIC_HEX = AS_PUBLIC.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

function signedAttestationBlob(): string {
  const payload = {
    attestation_id: '00000000-0000-4000-8000-0000000000cc',
    version: '0.5' as const,
    profile_id: PROFILE_ID,
    bounds_hash: computeBoundsHash(BOUNDS, PROFILE as never),
    context_hash: 'sha256:' + 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    execution_context_hash: 'sha256:' + '00'.repeat(32),
    resolved_owners: ['did:key:test-owner'],
    gate_content_hashes: { intent: 'sha256:' + '11'.repeat(32) },
    commitment_mode: 'automatic' as const,
    issued_at: NOW - 60,
    expires_at: NOW + 3600,
  };
  const signature = edSign(null, Buffer.from(canonicalize(payload), 'utf8'), AS_PRIVATE)
    .toString('base64url');
  return Buffer.from(
    JSON.stringify({ header: { typ: 'HAP-attestation', alg: 'EdDSA' }, payload, signature }),
    'utf8',
  ).toString('base64');
}

const AUTH: CachedAuthorization = {
  authorizationId: 'authz_00000000-0000-4000-8000-0000000000cc',
  profileId: PROFILE_ID,
  path: PATH,
  frame: { ...BOUNDS },
  bounds: { ...BOUNDS },
  attestations: [{ domain: 'finance', blob: signedAttestationBlob(), expiresAt: NOW + 3600 }],
  requiredDomains: [],
  attestedDomains: [],
  complete: true,
} as unknown as CachedAuthorization;

/**
 * Cache stub. Returns the grant by its per-ceremony id, exactly as the real
 * cache keys it, and the public key that verifies the blob above.
 */
const cache = {
  getAuthorization: (id: string) => (id === AUTH.authorizationId ? AUTH : null),
  getPublicKey: async () => AS_PUBLIC_HEX,
} as unknown as AttestationCache;

let logDir: string;
let log: ExecutionLog;

beforeAll(() => registerProfile(PROFILE_ID, PROFILE as never));
afterAll(() => clearProfiles());

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), 'suveren-display-only-'));
  log = new ExecutionLog(logDir);
  // Already at BOTH cumulative ceilings: 3 charges of 80 = 240 > 200, count 3 ≥ 3.
  for (let i = 0; i < 3; i++) {
    log.record({
      profileId: PROFILE_ID,
      path: PATH,
      timestamp: NOW - 60 * (i + 1),
      execution: { amount: 80, action_type: 'charge' },
    });
  }
});

afterEach(() => {
  try { rmSync(logDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('the log fixture is real (guards against a vacuous test)', () => {
  it('holds enough history to exceed both cumulative bounds', () => {
    expect(log.sumByWindow(PROFILE_ID, PATH, 'amount', 'daily', NOW)).toBe(240);
    expect(log.sumByWindow(PROFILE_ID, PATH, '_count', 'daily', NOW)).toBe(3);
    expect(240).toBeGreaterThan(BOUNDS.amount_daily_max);
    expect(3).toBeGreaterThanOrEqual(BOUNDS.transaction_count_daily_max);
  });
});

describe('MCPGatekeeper — cumulative bounds are NOT enforced locally', () => {
  it('approves a call that a local cumulative check would have refused', async () => {
    const { result } = await new MCPGatekeeper(cache).verifyExecution(
      AUTH.authorizationId,
      { amount: 50, action_type: 'charge' },
      { bounds: { ...BOUNDS } },
    );

    // An approved result carries no `errors` array at all.
    expect((result.errors ?? []).map(e => e.code)).not.toContain('CUMULATIVE_LIMIT_EXCEEDED');
    expect(result.approved).toBe(true);
  });

  it('would be refused if the log were passed — so the approval above is a choice, not an accident', async () => {
    // Non-vacuity guard. Same bounds, same execution, same log: handed to
    // hap-core's `verify()` as a fourth argument (what the gateway used to do)
    // this call is refused CUMULATIVE_LIMIT_EXCEEDED. The Gatekeeper approves
    // it because it deliberately withholds the log — if someone reintroduces
    // the argument, the test above starts failing and this one explains why.
    const result = await verify(
      {
        frame: { ...BOUNDS },
        attestations: [signedAttestationBlob()],
        execution: { amount: 50, action_type: 'charge' },
        path: PATH,
      },
      AS_PUBLIC_HEX,
      NOW,
      log,
    );

    expect(result.approved).toBe(false);
    expect((result.errors ?? []).map(e => e.code)).toContain('CUMULATIVE_LIMIT_EXCEEDED');
  });

  it('still refuses a call over the PER-TRANSACTION bound', async () => {
    // The local gate is dropped for cumulative bounds only. Per-transaction
    // bounds need no history, so the Gatekeeper enforces them (and so does the
    // AS) — if this passed, the change would have removed local enforcement
    // altogether rather than the duplicated half.
    const { result } = await new MCPGatekeeper(cache).verifyExecution(
      AUTH.authorizationId,
      { amount: 500, action_type: 'charge' },
      { bounds: { ...BOUNDS } },
    );

    expect(result.approved).toBe(false);
    expect((result.errors ?? []).map(e => e.code)).toContain('BOUND_EXCEEDED');
  });
});

describe('the gated write path — the AS gets asked', () => {
  const TOOL: DiscoveredTool = {
    originalName: 'create_charge',
    namespacedName: 'stripe__create_charge',
    integrationId: 'stripe',
    description: '',
    inputSchema: {},
    gating: {
      profile: SHORT,
      executionMapping: { amount: 'amount' },
      staticExecution: { action_type: 'charge' },
    } as unknown as DiscoveredTool['gating'],
  };

  function buildState() {
    const postReceipt = vi.fn().mockResolvedValue({ receipt: { id: 'rcpt-1' } });
    const enriched: EnrichedAuthorization[] = [{ ...AUTH, gateContent: null } as EnrichedAuthorization];
    const state = {
      getEnrichedAuthorizations: () => enriched,
      spClient: { postReceipt, isUnlocked: () => true },
      cache,
      // The REAL gatekeeper — this is the wiring under test, not a stub of it.
      gatekeeper: new MCPGatekeeper(cache),
      executionLog: log,
      archiveReceipt: vi.fn().mockResolvedValue(undefined),
    } as unknown as SharedState;
    return { state, postReceipt };
  }

  it('requests a receipt for a call that is over the local daily total', async () => {
    // The AS holds the authoritative cumulative state and is the only party
    // that can refuse before a receipt exists. Blocking here would mean it is
    // never asked — and a local log that has been pruned, or that belongs to a
    // second machine, would silently decide the grant's limits.
    const { state, postReceipt } = buildState();
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const im = { callTool, getReadAgeDays: () => null } as unknown as IntegrationManager;

    const result = await createGatedToolHandler(TOOL, im, state)({ amount: 50 });

    expect(postReceipt).toHaveBeenCalledOnce();
    expect(result.isError).toBeFalsy();
  });

  it('is refused by the AS, not by the local log, when the ceiling is real', async () => {
    // Same call, but the AS says no. The refusal the agent sees comes from the
    // authority — after the pre-flight, never instead of it.
    const { state, postReceipt } = buildState();
    const { SPReceiptError } = await import('../src/lib/sp-client');
    (state.spClient.postReceipt as ReturnType<typeof vi.fn>).mockRejectedValue(
      new SPReceiptError('Daily limit exceeded', 403, { error: 'Daily limit exceeded' }),
    );
    const callTool = vi.fn();
    const im = { callTool, getReadAgeDays: () => null } as unknown as IntegrationManager;

    const result = await createGatedToolHandler(TOOL, im, state)({ amount: 50 });

    expect(postReceipt).toHaveBeenCalledOnce();
    expect(callTool).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Daily limit exceeded');
  });
});

describe('the log keeps its real job — the consumption display', () => {
  it('reports the running totals it no longer gates on', async () => {
    const entries = getConsumptionState(
      { ...AUTH, gateContent: null } as unknown as EnrichedAuthorization,
      log,
      PROFILE as never,
    );

    const daily = entries.find(e => e.field === 'amount_daily_max');
    expect(daily).toMatchObject({ current: 240, limit: 200, kind: 'sum' });
    const count = entries.find(e => e.field === 'transaction_count_daily_max');
    expect(count).toMatchObject({ current: 3, limit: 3, kind: 'count' });
  });
});
