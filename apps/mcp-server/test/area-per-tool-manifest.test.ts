/**
 * Area per tool, manifest-load-time validation: an override's own `profile`
 * (integration-manager.ts's `resolveToolGating`, tool-gating-types.ts's
 * `ProfileToolGatingEntry.profile`) must resolve to a known profile — same
 * resolution `manifest.profile` itself gets — and the D6 read-gate coverage
 * check (manifest-loader.ts's `invalidManifestReadGateReason`) must run per
 * DISTINCT profile a manifest uses, each time against only that profile's
 * own overrides. A manifest spanning two profiles must not be able to pass
 * D6 by accident (one profile's overrides happening to satisfy the OTHER
 * profile's switch), and a mandate for one area must not unlock the other
 * area's tools.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProfile, clearProfiles, type AgentProfile } from '@hap/core';
import {
  loadManifests,
  getManifest,
  invalidManifestOverrideProfilesReason,
  invalidManifestReadGateReason,
} from '../src/lib/manifest-loader';
import { createGatedToolHandler, profileMatches } from '../src/lib/tool-proxy';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { CachedAuthorization } from '../src/lib/attestation-cache';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import { testReceiptKeypair, makeSignedReceipt } from './helpers/real-receipt';

// ─── Two tiny real profiles: one WITH a read-side switch, one without ─────

const AREA_A: AgentProfile = {
  id: 'area-a-test',
  version: '1',
  description: 'area A — no read-side switch',
  boundsSchema: {
    keyOrder: ['profile', 'value_max'],
    actionTypes: ['write_a'],
    fields: {
      profile: { type: 'string', required: true },
      value_max: { type: 'number', required: true, boundType: { kind: 'per_transaction', of: 'value', requiredFor: ['write_a'] } },
    },
  },
  executionContextSchema: { fields: { value: { source: 'declared', required: true, constraint: { type: 'number', enforceable: ['max'] } } } },
  requiredGates: [],
  ttl: { default: 1, max: 1 },
  retention_minimum: 1,
};

const AREA_B: AgentProfile = {
  id: 'area-b-test',
  version: '1',
  description: 'area B — declares a read_access switch, like invoicing',
  boundsSchema: {
    keyOrder: ['profile', 'read_access', 'value_max'],
    actionTypes: ['write_b'],
    fields: {
      profile: { type: 'string', required: true },
      read_access: { type: 'string', required: true, boundType: { kind: 'enum', values: ['unlimited', 'none'] } },
      value_max: { type: 'number', required: true, boundType: { kind: 'per_transaction', of: 'value', requiredFor: ['write_b'] } },
    },
  },
  executionContextSchema: { fields: { value: { source: 'declared', required: true, constraint: { type: 'number', enforceable: ['max'] } } } },
  requiredGates: [],
  ttl: { default: 1, max: 1 },
  retention_minimum: 1,
};

beforeAll(() => {
  registerProfile('area-a-test', AREA_A);
  registerProfile('area-b-test', AREA_B);
});
afterAll(() => clearProfiles());

describe('invalidManifestOverrideProfilesReason', () => {
  it('null when no override declares its own profile', () => {
    expect(invalidManifestOverrideProfilesReason({ profile: 'area-a-test', toolGating: { default: { executionMapping: {} } } })).toBeNull();
  });

  it('null when an override\'s own profile resolves (short name)', () => {
    expect(invalidManifestOverrideProfilesReason({
      profile: 'area-a-test',
      toolGating: { default: { executionMapping: {} }, overrides: { do_b: { profile: 'area-b-test', executionMapping: {} } } },
    })).toBeNull();
  });

  it('refuses when an override names a profile that does not resolve', () => {
    const reason = invalidManifestOverrideProfilesReason({
      profile: 'area-a-test',
      toolGating: { default: { executionMapping: {} }, overrides: { do_x: { profile: 'no-such-area', executionMapping: {} } } },
    });
    expect(reason).toMatch(/"do_x".profile "no-such-area" does not resolve/);
  });
});

describe('invalidManifestReadGateReason — per DISTINCT profile, not the manifest\'s alone', () => {
  it('area A\'s overrides cannot satisfy area B\'s switch by accident — a read under B with no boundField is still caught', () => {
    const reason = invalidManifestReadGateReason({
      profile: 'area-a-test',
      toolGating: {
        default: { executionMapping: {} },
        overrides: {
          // Area A has no switch at all — this is fine standing alone.
          read_a: { category: 'read' },
          // Area B DOES declare read_access — this read is under B but
          // references nothing. Must be caught even though area A (the
          // manifest's OWN profile) has no switch to violate.
          read_b: { profile: 'area-b-test', category: 'read' },
        },
      },
    });
    expect(reason).toMatch(/does not reference one via boundField/);
  });

  it('clean when each profile\'s own overrides cover ONLY that profile\'s switches', () => {
    const reason = invalidManifestReadGateReason({
      profile: 'area-a-test',
      toolGating: {
        default: { executionMapping: {} },
        overrides: {
          read_a: { category: 'read' },
          read_b: { profile: 'area-b-test', category: 'read', boundField: 'read_access', requiredValue: 'unlimited' },
        },
      },
    });
    expect(reason).toBeNull();
  });
});

describe('loadManifests end to end — a manifest spanning two profiles', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hap-two-area-manifest-'));
    mkdirSync(join(dir, 'twoarea'));
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ integrations: { twoarea: 'twoarea/manifest.json' } }));
    writeFileSync(
      join(dir, 'twoarea/manifest.json'),
      JSON.stringify({
        id: 'twoarea', name: 'Two Area', version: '1', profile: 'area-a-test',
        mcp: { command: 'node', args: [] },
        credentials: { fields: [], envMapping: {} },
        oauth: null,
        toolGating: {
          default: { executionMapping: {} },
          overrides: {
            do_a: { executionMapping: { value: 'value' }, staticExecution: { action_type: 'write_a' } },
            do_b: { profile: 'area-b-test', executionMapping: { value: 'value' }, staticExecution: { action_type: 'write_b' } },
            read_b: { profile: 'area-b-test', category: 'read', boundField: 'read_access', requiredValue: 'unlimited' },
          },
        },
      }),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('loads — both profiles resolve, D6 is satisfied for each', () => {
    const loaded = loadManifests(dir);
    expect(loaded).toBe(1);
    expect(getManifest('twoarea')).toBeDefined();
  });
});

// ─── A mandate for one area does not unlock the other area's tools ────────

function toolFor(profile: string, toolName: string, actionType: string): DiscoveredTool {
  return {
    originalName: toolName,
    namespacedName: `twoarea__${toolName}`,
    integrationId: 'twoarea',
    description: '',
    inputSchema: { type: 'object', properties: { value: {} } },
    gating: {
      profile,
      executionMapping: { value: 'value' },
      staticExecution: { action_type: actionType },
    },
  } as unknown as DiscoveredTool;
}

function authFor(profile: string, bounds: Record<string, string | number>): CachedAuthorization {
  const fullBounds = { profile, ...bounds };
  return {
    authorizationId: `authz_00000000-0000-4000-8000-0000000000${profile === 'area-a-test' ? 'a1' : 'b1'}`,
    profileId: profile,
    path: `${profile}-routine`,
    frame: fullBounds,
    bounds: fullBounds,
    attestations: [],
    requiredDomains: [],
    attestedDomains: [],
    deferredCommitmentDomains: [],
    complete: true,
  } as unknown as CachedAuthorization;
}

function buildState(auth: CachedAuthorization) {
  const kp = testReceiptKeypair();
  const postReceipt = async (req: { action: string; executionContext?: Record<string, unknown>; authorizationId?: string; profileId?: string; idempotencyKey?: string }) => ({
    receipt: makeSignedReceipt(kp, {
      id: 'rcpt-area-1',
      action: req.action,
      executionContext: req.executionContext ?? {},
      authorizationId: req.authorizationId,
      profileId: req.profileId,
      idempotencyKey: req.idempotencyKey,
    }),
  });
  const enriched: EnrichedAuthorization[] = [{ ...auth, gateContent: null } as EnrichedAuthorization];
  const state = {
    getEnrichedAuthorizations: () => enriched,
    spClient: { postReceipt, isUnlocked: () => true },
    cache: { getAllAuthorizations: () => [auth], getPublicKey: async () => kp.publicKeyHex, getTrustedIssuer: async () => kp.issuer },
    gatekeeper: { verifyExecution: async () => ({ result: { approved: true, errors: [] } }) },
    executionLog: { record: () => {} },
    executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
    archiveReceipt: async () => {},
  } as unknown as SharedState;
  return state;
}

function managerFor(tool: DiscoveredTool) {
  return {
    getAllTools: () => [tool],
    callTool: async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }),
  } as unknown as IntegrationManager;
}

describe('area isolation — a mandate for area A does not unlock area B\'s tool', () => {
  it('area B\'s tool is refused under an area-A-only authorization (profileMatches itself already says no)', () => {
    expect(profileMatches('area-a-test', 'area-b-test')).toBe(false);
  });

  it('calling the area-B tool with only an area-A mandate is refused, no ticket requested', async () => {
    const toolB = toolFor('area-b-test', 'do_b', 'write_b');
    const state = buildState(authFor('area-a-test', { value_max: 1000 }));
    const manager = managerFor(toolB);

    const result = await createGatedToolHandler(toolB, manager, state)({ value: 10 });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/no mandate covers|ungoverned|not_authorized|Refused/i);
  });

  it('calling the area-A tool WITH the area-A mandate proceeds normally', async () => {
    const toolA = toolFor('area-a-test', 'do_a', 'write_a');
    const state = buildState(authFor('area-a-test', { value_max: 1000 }));
    const manager = managerFor(toolA);

    const result = await createGatedToolHandler(toolA, manager, state)({ value: 10 });

    expect(result.isError).toBeFalsy();
  });
});
