/**
 * TR7 (work-plan "Added 2026-10-14 — Team: permissions, above-cap approval,
 * read limits"; direction: content/0.7/review.md "A group can cap reads and
 * capability switches"): in a TEAM workspace, the gateway must never apply a
 * local read window beyond the signed mandate's own read bound (e.g.
 * `read_max_age_days`) — effective window = min(local, signed). In Personal
 * mode this is unchanged: the local setting wins (protocol.md rule 8).
 *
 * Reuses the same real read path (`createGatedToolHandler`, category:"read"
 * branch) as gmail-read-access-gate.test.ts, with a minimal mirror profile —
 * just what the age dimension consults (`read_max_age_days`, resolved via
 * `boundType`, not a field-name literal).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { registerProfile, clearProfiles, type AgentProfile } from '@hap/core';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { CachedAuthorization } from '../src/lib/attestation-cache';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';

const SHORT = 'email-tr7-ceiling-test';

const PROFILE: AgentProfile = {
  id: SHORT,
  version: '1',
  description: 'test mirror of email@0.8 for TR7 (age dimension only)',
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

function authWith(bounds: Record<string, string | number>, groupId?: string): CachedAuthorization {
  const fullBounds = { profile: SHORT, read_access: 'unlimited', ...bounds };
  return {
    authorizationId: 'authz_00000000-0000-4000-8000-00000000tr71',
    profileId: SHORT,
    path: 'email-routine',
    frame: fullBounds,
    bounds: fullBounds,
    attestations: [],
    requiredDomains: [],
    attestedDomains: [],
    deferredCommitmentDomains: [],
    complete: true,
    groupId,
  } as unknown as CachedAuthorization;
}

/** `isTeam` — undefined by default, matching the "don't know yet" state a
 *  bare test double (no `cache` at all) produces via tool-proxy.ts's
 *  `typeof state.cache?.isTeamGroup === 'function'` guard. */
function buildState(auth: CachedAuthorization, isTeam?: boolean | undefined): SharedState {
  const enriched: EnrichedAuthorization[] = [{ ...auth, gateContent: null } as EnrichedAuthorization];
  return {
    getEnrichedAuthorizations: () => enriched,
    spClient: { isUnlocked: () => true },
    asVersionRefusal: undefined,
    cache: { isTeamGroup: () => isTeam },
  } as unknown as SharedState;
}

function emailTool(originalName: string, readAgeDaysLocal: number | null): { tool: DiscoveredTool; integrationManager: IntegrationManager; callTool: ReturnType<typeof vi.fn> } {
  const tool = {
    originalName,
    namespacedName: `email__${originalName}`,
    integrationId: 'email',
    description: '',
    inputSchema: { type: 'object', properties: {} },
    gating: {
      profile: SHORT,
      executionMapping: {},
      category: 'read',
      boundField: 'read_access',
      requiredValue: 'unlimited',
      read: {
        ageField: 'read_age_days',
        resultDatePath: 'internalDate',
      },
    },
  } as unknown as DiscoveredTool;
  const freshResult = { id: 'm1', internalDate: String(Date.now()) };
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

describe('TR7 — team read ceiling: min(local, signed) in team mode only', () => {
  it('TEAM mode: a generous local window is clamped down to the signed team ceiling', async () => {
    const { tool, integrationManager, callTool } = emailTool('list_messages', 365); // local: very wide
    const state = buildState(authWith({ read_max_age_days: 30 }, 'group_team_1'), true); // signed ceiling: 30

    const result = await createGatedToolHandler(tool, integrationManager, state)({});

    // A fresh item (age 0) is within BOTH 365 and 30, so this alone doesn't
    // prove the clamp — the point is the refusal test below, which does.
    expect(result.isError).toBeFalsy();
    expect(callTool).toHaveBeenCalledOnce();
  });

  it('TEAM mode: a query asking for data older than the signed ceiling is refused even though ' +
    'the local window alone would have allowed it', async () => {
    const { tool, integrationManager } = emailTool('get_message', 365); // local: very wide
    const state = buildState(authWith({ read_max_age_days: 30 }, 'group_team_1'), true); // signed ceiling: 30

    // An item 90 days old: within the local window (365) but NOT within the
    // signed team ceiling (30) — TR7 requires min(local, signed) in team
    // mode, so this must be refused.
    const old = { id: 'm1', internalDate: String(Date.now() - 90 * 24 * 60 * 60 * 1000) };
    integrationManager.callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(old) }] });

    const result = await createGatedToolHandler(tool, integrationManager, state)({ id: 'm1' });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/read_max_age_days/);
  });

  it('TEAM mode: the local setting may still be the tighter of the two (min, not "always signed")', async () => {
    const { tool, integrationManager } = emailTool('get_message', 7); // local: tighter than the team ceiling
    const state = buildState(authWith({ read_max_age_days: 30 }, 'group_team_1'), true);

    const tenDaysOld = { id: 'm1', internalDate: String(Date.now() - 10 * 24 * 60 * 60 * 1000) };
    integrationManager.callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(tenDaysOld) }] });

    const result = await createGatedToolHandler(tool, integrationManager, state)({ id: 'm1' });

    // 10 days is within the signed ceiling (30) but NOT within the tighter
    // local setting (7) — the local setting still applies when it is the
    // stricter of the two.
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/read_max_age_days/);
  });

  it('PERSONAL mode: unchanged — the local setting wins even beyond the grant\'s own value (rule 8)', async () => {
    const { tool, integrationManager } = emailTool('get_message', 365); // local: very wide
    const state = buildState(authWith({ read_max_age_days: 30 }, 'group_personal_1'), false); // NOT a team group

    const old = { id: 'm1', internalDate: String(Date.now() - 90 * 24 * 60 * 60 * 1000) }; // 90 days old
    integrationManager.callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(old) }] });

    const result = await createGatedToolHandler(tool, integrationManager, state)({ id: 'm1' });

    // Personal mode: the local window (365) wins outright, exactly as
    // before TR7 — 90 days is within it, so this PROCEEDS.
    expect(result.isError).toBeFalsy();
  });

  it('UNKNOWN workspace status (isTeamGroup undefined — e.g. a bare test double, or still ' +
    'loading): behaves exactly like Personal mode, never like Team', async () => {
    const { tool, integrationManager } = emailTool('get_message', 365);
    const state = buildState(authWith({ read_max_age_days: 30 }, 'group_unknown_1')); // isTeam left undefined

    const old = { id: 'm1', internalDate: String(Date.now() - 90 * 24 * 60 * 60 * 1000) };
    integrationManager.callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(old) }] });

    const result = await createGatedToolHandler(tool, integrationManager, state)({ id: 'm1' });

    expect(result.isError).toBeFalsy();
  });

  it('a state double with no `cache` field at all (pre-TR7 test shape) does not throw — falls ' +
    'back to the existing "local wins" behaviour', async () => {
    const { tool, integrationManager } = emailTool('get_message', 30);
    const enriched: EnrichedAuthorization[] = [{ ...authWith({ read_max_age_days: 5 }, 'group_x'), gateContent: null } as EnrichedAuthorization];
    const bareState = {
      getEnrichedAuthorizations: () => enriched,
      spClient: { isUnlocked: () => true },
      asVersionRefusal: undefined,
      // no `cache` at all
    } as unknown as SharedState;

    const fresh = { id: 'm1', internalDate: String(Date.now()) };
    integrationManager.callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(fresh) }] });

    const result = await createGatedToolHandler(tool, integrationManager, bareState)({ id: 'm1' });

    expect(result.isError).toBeFalsy();
  });
});
