/**
 * The gmail.json defect, end to end through tool-proxy.ts's REAL read path
 * (createGatedToolHandler, category:"read" branch) — not just the pure
 * predicates read-gate.test.ts already covers.
 *
 * Found 2026-10-14 (live gateway report): gmail__list_messages and
 * gmail__get_message SUCCEEDED while the only live email mandate held
 * `read_access: "none"`. Root cause: gmail.json's list_messages/get_message/
 * list_drafts/get_draft declared `category:"read"` and a `read` adapter
 * (age-gating only) but NO `boundField`/`requiredValue` — so the F9
 * "governed" check passed (a read adapter alone is enough) while the actual
 * access switch was never consulted (tool-proxy.ts's `if (readGate.boundField)`
 * guard only runs when one is declared).
 *
 * These tests build the gating config DIRECTLY from the shipped gmail.json
 * JSON (not a hand-typed mirror that could drift from it) and drive it
 * through the real `createGatedToolHandler`, so they fail on the pre-fix
 * file and pass on the fixed one.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerProfile, clearProfiles, type AgentProfile } from '@hap/core';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { CachedAuthorization } from '../src/lib/attestation-cache';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';

const MANIFEST = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'integrations', 'gmail.json'), 'utf8'),
) as { profile: string; toolGating: { overrides: Record<string, Record<string, unknown>> } };

const SHORT = 'email-gmail-gate-test';

/** Minimal mirror of email@0.8's shape — just what the read path consults:
 *  `read_access` (the static gate) and `read_max_age_days` (the age bound
 *  `resolveAgeBoundField` must resolve via boundType, not a field-name
 *  literal). */
const PROFILE: AgentProfile = {
  id: SHORT,
  version: '1',
  description: 'test mirror of email@0.8 for the gmail read-gate',
  boundsSchema: {
    keyOrder: ['profile', 'read_access', 'read_max_age_days'],
    fields: {
      profile: { type: 'string', required: true },
      read_access: { type: 'string', required: true, boundType: { kind: 'enum', values: ['unlimited', 'none'] } },
      read_max_age_days: { type: 'number', required: false, boundType: { kind: 'per_transaction', of: 'read_age_days' } },
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
    authorizationId: 'authz_00000000-0000-4000-8000-00000000gma1',
    profileId: SHORT,
    path: 'email-routine',
    frame: fullBounds,
    bounds: fullBounds,
    attestations: [],
    requiredDomains: [],
    attestedDomains: [],
    deferredCommitmentDomains: [],
    complete: true,
  } as unknown as CachedAuthorization;
}

function buildState(auth: CachedAuthorization): SharedState {
  const enriched: EnrichedAuthorization[] = [{ ...auth, gateContent: null } as EnrichedAuthorization];
  return {
    getEnrichedAuthorizations: () => enriched,
    spClient: { isUnlocked: () => true },
    asVersionRefusal: undefined,
  } as unknown as SharedState;
}

/** A tool as discovered at runtime, gated exactly the way integration-
 *  manager.ts's resolveToolGating resolves it — read straight from the
 *  SHIPPED manifest's own override entry, not a hand-typed mirror. */
function gmailTool(originalName: string, readAgeDaysLocal: number | null): { tool: DiscoveredTool; integrationManager: IntegrationManager; callTool: ReturnType<typeof vi.fn> } {
  const override = MANIFEST.toolGating.overrides[originalName];
  const tool = {
    originalName,
    namespacedName: `gmail__${originalName}`,
    integrationId: 'gmail',
    description: '',
    inputSchema: { type: 'object', properties: {} },
    gating: {
      profile: SHORT,
      executionMapping: {},
      category: override.category,
      boundField: override.boundField,
      requiredValue: override.requiredValue,
      read: override.read,
      readGovernance: override.readGovernance,
      readGovernanceReason: override.readGovernanceReason,
    },
  } as unknown as DiscoveredTool;
  // Covers every resultDatePath/resultValuesPath this manifest's read tools
  // declare (get_message: internalDate/labelIds top-level; get_draft:
  // message.internalDate/message.labelIds) so the "proceeds" tests exercise
  // the REAL per-item post-fetch checks (age, spam/trash) rather than
  // happening to pass by missing-path coincidence.
  const freshResult = {
    id: 'm1',
    internalDate: String(Date.now()),
    labelIds: ['INBOX'],
    payload: { headers: [] },
    message: { internalDate: String(Date.now()), labelIds: ['INBOX'] },
  };
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(freshResult) }] });
  const integrationManager = {
    getAllTools: () => [tool],
    callTool,
    getReadAgeDays: () => readAgeDaysLocal,
  } as unknown as IntegrationManager;
  return { tool, integrationManager, callTool };
}

beforeAll(() => {
  registerProfile(SHORT, PROFILE);
});
afterAll(() => clearProfiles());

describe('gmail.json read tools under read_access:"none" (the live bug report)', () => {
  for (const originalName of ['list_messages', 'get_message', 'list_drafts', 'get_draft', 'get_attachment']) {
    it(`${originalName} is REFUSED — before the fix, this call succeeded`, async () => {
      const { tool, integrationManager, callTool } = gmailTool(originalName, 30);
      const state = buildState(authWith({ read_access: 'none' }));

      const result = await createGatedToolHandler(tool, integrationManager, state)({ id: 'm1' });

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/read_access/);
      expect(callTool).not.toHaveBeenCalled();
    });
  }

  for (const originalName of ['list_messages', 'get_message', 'list_drafts', 'get_draft', 'get_attachment']) {
    it(`${originalName} PROCEEDS under read_access:"unlimited" with a window configured`, async () => {
      const { tool, integrationManager, callTool } = gmailTool(originalName, 30);
      const state = buildState(authWith({ read_access: 'unlimited', read_max_age_days: 30 }));

      const result = await createGatedToolHandler(tool, integrationManager, state)({ id: 'm1' });

      expect(result.isError).toBeFalsy();
      expect(callTool).toHaveBeenCalledOnce();
    });
  }
});

describe('gmail.json get_attachment (G2) — no longer exempt, and honestly age-gated', () => {
  it('is governed (F9) — no longer `readGovernance:"none"`', () => {
    const override = MANIFEST.toolGating.overrides.get_attachment;
    expect(override.readGovernance).toBeUndefined();
    expect(override.boundField).toBe('read_access');
    expect(override.requiredValue).toBe('unlimited');
  });

  it('refuses when NO read-age window is configured anywhere (F11) — honest: it cannot verify a ' +
    'per-item date (no resultDatePath — an attachment response carries none), so it will not silently ' +
    'treat "no window" as "no limit"', async () => {
    const { tool, integrationManager, callTool } = gmailTool('get_attachment', null); // no local window
    const state = buildState(authWith({ read_access: 'unlimited' })); // grant sets no read_max_age_days either

    const result = await createGatedToolHandler(tool, integrationManager, state)({ messageId: 'm1', id: 'a1' });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/no read-age window/);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('proceeds once a window exists, without claiming to verify the attachment\'s own age ' +
    '(no resultDatePath — it is not individually checked, only gated on a window existing)', async () => {
    const { tool, integrationManager, callTool } = gmailTool('get_attachment', 30);
    const state = buildState(authWith({ read_access: 'unlimited' }));

    const result = await createGatedToolHandler(tool, integrationManager, state)({ messageId: 'm1', id: 'a1' });

    expect(result.isError).toBeFalsy();
    expect(callTool).toHaveBeenCalledOnce();
  });
});
