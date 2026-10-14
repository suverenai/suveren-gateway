/**
 * A WRITE override's capability gate (enum boundType, e.g. records.json's
 * `delete_access`/`archive_access`) was silently dropped and never
 * enforced — found while investigating the gmail.json read-gate defect
 * (2026-10-14).
 *
 * Root cause: integration-manager.ts's `resolveToolGating` copied
 * `boundField`/`requiredValue` into the resolved `ToolGatingConfig` ONLY
 * inside the `category:"read"` branch; a plain write override (no
 * `category` at all — records.json's `delete_record`/`archive_record`)
 * fell through the OTHER branch, which never copied those two fields. And
 * tool-proxy.ts only ever read `tool.gating.boundField` inside the
 * `category === "read"` branch. So a mandate with `delete_access: "none"`
 * did NOT block `records__delete_record` — nothing anywhere checked it:
 * hap-core's Gatekeeper deliberately never compares an `enum` bound against
 * execution (gatekeeper.ts's 'enum' case — "the gateway tool-proxy gates
 * tool calls ... before they reach the Gatekeeper"), and the Authority
 * Server's receipt route makes the identical "capability flags are checked
 * at attest time and at tool-proxy time, not here" call (apps/as's
 * receipt/route.ts, 'enum' case).
 *
 * These tests build the gating config from the SHIPPED records.json entry
 * and drive it through the real `createGatedToolHandler`, so they fail on
 * the pre-fix code and pass on the fix (integration-manager.ts now copies
 * boundField/requiredValue on every branch; tool-proxy.ts's write-path
 * verify loop now checks it per candidate, before calling the Gatekeeper
 * and before any ticket is requested).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerProfile, clearProfiles, type AgentProfile } from '@hap/core';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { CachedAuthorization } from '../src/lib/attestation-cache';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import { testReceiptKeypair, makeSignedReceipt } from './helpers/real-receipt';

const MANIFEST = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'integrations', 'records.json'), 'utf8'),
) as { toolGating: { overrides: Record<string, Record<string, unknown>> } };

const SHORT = 'records-write-gate-test';

/** Minimal mirror of records@0.6's shape — just what delete_record engages. */
const PROFILE: AgentProfile = {
  id: SHORT,
  version: '1',
  description: 'test mirror of records@0.6 for the write-side capability gate',
  boundsSchema: {
    keyOrder: ['profile', 'delete_access'],
    actionTypes: ['delete'],
    fields: {
      profile: { type: 'string', required: true },
      delete_access: { type: 'string', required: true, boundType: { kind: 'enum', values: ['allowed', 'none'] } },
    },
  },
  executionContextSchema: { fields: {} },
  requiredGates: [],
  ttl: { default: 1, max: 1 },
  retention_minimum: 1,
};

function authWith(bounds: Record<string, string | number>): CachedAuthorization {
  const fullBounds = { profile: SHORT, ...bounds };
  return {
    authorizationId: 'authz_00000000-0000-4000-8000-00000000rec1',
    profileId: SHORT,
    path: 'records-routine',
    frame: fullBounds,
    bounds: fullBounds,
    attestations: [],
    requiredDomains: [],
    attestedDomains: [],
    deferredCommitmentDomains: [],
    complete: true,
  } as unknown as CachedAuthorization;
}

function deleteRecordTool(): DiscoveredTool {
  const override = MANIFEST.toolGating.overrides.delete_record;
  return {
    originalName: 'delete_record',
    namespacedName: 'records__delete_record',
    integrationId: 'records',
    description: '',
    inputSchema: { type: 'object', properties: { id: {} } },
    gating: {
      profile: SHORT,
      executionMapping: override.executionMapping,
      staticExecution: override.staticExecution,
      boundField: override.boundField,
      requiredValue: override.requiredValue,
    },
  } as unknown as DiscoveredTool;
}

function buildState(auth: CachedAuthorization, verifyExecution: ReturnType<typeof vi.fn>) {
  const kp = testReceiptKeypair();
  const postReceipt = vi.fn().mockImplementation(async (req: { action: string; executionContext?: Record<string, unknown>; authorizationId?: string; profileId?: string; idempotencyKey?: string }) => ({
    receipt: makeSignedReceipt(kp, {
      id: 'rcpt-del-1',
      action: req.action,
      executionContext: req.executionContext ?? {},
      authorizationId: req.authorizationId,
      profileId: req.profileId,
      idempotencyKey: req.idempotencyKey,
    }),
  }));
  const enriched: EnrichedAuthorization[] = [{ ...auth, gateContent: null } as EnrichedAuthorization];
  const state = {
    getEnrichedAuthorizations: () => enriched,
    spClient: { postReceipt, isUnlocked: () => true },
    cache: { getAllAuthorizations: () => [auth], getPublicKey: async () => kp.publicKeyHex, getTrustedIssuer: async () => kp.issuer },
    gatekeeper: { verifyExecution },
    executionLog: { record: vi.fn() },
    executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
    archiveReceipt: vi.fn().mockResolvedValue(undefined),
  } as unknown as SharedState;
  return { state, postReceipt };
}

function buildIntegrationManager(tool: DiscoveredTool) {
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
  return { integrationManager: { getAllTools: () => [tool], callTool } as unknown as IntegrationManager, callTool };
}

/** Approves unconditionally — isolates "did tool-proxy even ASK the
 *  Gatekeeper" from hap-core's own bound comparison, same as
 *  numeric-amount-bound.test.ts. */
function approvingGatekeeper() {
  return vi.fn().mockResolvedValue({ result: { approved: true, errors: [] } });
}

beforeAll(() => { registerProfile(SHORT, PROFILE); });
afterAll(() => clearProfiles());

describe('records.json delete_record under delete_access:"none"', () => {
  it('is REFUSED before the Gatekeeper is even asked, and before any ticket is requested', async () => {
    const verifyExecution = approvingGatekeeper();
    const tool = deleteRecordTool();
    const { state, postReceipt } = buildState(authWith({ delete_access: 'none' }), verifyExecution);
    const { integrationManager, callTool } = buildIntegrationManager(tool);

    const result = await createGatedToolHandler(tool, integrationManager, state)({ id: 'rec-1' });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/delete_access/);
    expect(verifyExecution).not.toHaveBeenCalled();
    expect(postReceipt).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('records.json delete_record under delete_access:"allowed"', () => {
  it('proceeds — reaches the Gatekeeper, requests a ticket, and calls the downstream tool', async () => {
    const verifyExecution = approvingGatekeeper();
    const tool = deleteRecordTool();
    const { state, postReceipt } = buildState(authWith({ delete_access: 'allowed' }), verifyExecution);
    const { integrationManager, callTool } = buildIntegrationManager(tool);

    const result = await createGatedToolHandler(tool, integrationManager, state)({ id: 'rec-1' });

    expect(result.isError).toBeFalsy();
    expect(verifyExecution).toHaveBeenCalledOnce();
    expect(postReceipt).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledOnce();
  });
});

describe('a mandate missing the bound field entirely (pre-existing grant shape)', () => {
  it('is refused — fail closed, not skipped (boundsSatisfyReadGate: missing bound ⇒ false)', async () => {
    const verifyExecution = approvingGatekeeper();
    const tool = deleteRecordTool();
    // No delete_access key at all on this authorization's bounds.
    const { state, postReceipt } = buildState(authWith({}), verifyExecution);
    const { integrationManager, callTool } = buildIntegrationManager(tool);

    const result = await createGatedToolHandler(tool, integrationManager, state)({ id: 'rec-1' });

    expect(result.isError).toBe(true);
    expect(postReceipt).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });
});
