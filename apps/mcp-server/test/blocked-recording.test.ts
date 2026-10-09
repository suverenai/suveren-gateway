/**
 * AU2 (work-plan.md "Added 2026-10-09") — every refusal of a gated tool call
 * is recorded in the DenialLog, not only reads. One test per refusal kind:
 * local Gatekeeper bound/scope/action-type refusals, a simulation-mode
 * block, "no matching mandate", and an Authority Server ticket refusal by
 * its canonical code. Every record is asserted to carry no content — only
 * identifiers, field names, and numbers.
 */
import { describe, it, expect, beforeAll, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProfile } from '@hap/core';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import { SPReceiptError } from '../src/lib/sp-client';
import { DenialLog } from '../src/lib/denial-log';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { CachedAuthorization } from '../src/lib/attestation-cache';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';

const profilesDir =
  process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');
const EMAIL = JSON.parse(readFileSync(join(profilesDir, 'email', '0.8.profile.json'), 'utf8'));

beforeAll(() => {
  registerProfile(EMAIL.id, EMAIL);
});

afterEach(() => {
  delete process.env.SUVEREN_SIMULATION;
});

const EMAIL_BOUNDS = {
  read_access: 'unlimited',
  recipient_max: 3,
  send_daily_max: 6,
};
const EMAIL_SCOPE = { allowed_recipients: '', allowed_domains: 'alpenwerk.example' };

function makeAuth(id: string): CachedAuthorization {
  return {
    authorizationId: id,
    profileId: EMAIL.id,
    path: 'email-routine',
    frame: EMAIL_BOUNDS,
    bounds: EMAIL_BOUNDS,
    context: EMAIL_SCOPE,
    attestations: [],
    requiredDomains: [],
    attestedDomains: [],
    deferredCommitmentDomains: [],
    complete: true,
  } as unknown as CachedAuthorization;
}

const AUTH = makeAuth('authz_e0000000-0000-4000-8000-00000000e001');

const SEND_TOOL: DiscoveredTool = {
  originalName: 'send_message',
  namespacedName: 'gmail__send_message',
  integrationId: 'gmail',
  description: '',
  inputSchema: { type: 'object', properties: {} },
  gating: {
    profile: 'email',
    executionMapping: {},
    staticExecution: { action_type: 'send' },
  } as unknown as DiscoveredTool['gating'],
};

let dataDir: string;
let denialLog: DenialLog;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'blocked-recording-'));
  denialLog = new DenialLog(dataDir);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function buildState(overrides: Partial<SharedState> = {}): SharedState {
  return {
    getEnrichedAuthorizations: () => [],
    spClient: { isUnlocked: () => true, postReceipt: async () => { throw new Error('unused'); } },
    denialLog,
    gatekeeper: { verifyExecution: async () => ({ result: { approved: true, errors: [] } }) },
    cache: { invalidate: () => {}, markNeedsReapproval: () => {} },
    executionLog: { record: () => {} },
    executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
    archiveReceipt: async () => {},
    ...overrides,
  } as unknown as SharedState;
}

function buildIntegrationManager(): IntegrationManager {
  return {
    getAllTools: () => [SEND_TOOL],
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    isSimulationSafe: () => false,
  } as unknown as IntegrationManager;
}

/** No record may carry anything beyond identifiers, field names and numbers —
 * never an address, a subject, or a body. */
function assertNoContent(record: unknown, forbidden: string[]): void {
  const json = JSON.stringify(record);
  for (const needle of forbidden) expect(json).not.toContain(needle);
}

describe('AU2 — every refusal is recorded', () => {
  it('simulation mode: a real connector is refused and recorded (kind "simulation")', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    const state = buildState();
    const handler = createGatedToolHandler(SEND_TOOL, buildIntegrationManager(), state);

    const result = await handler({ to: 'customer@example.com', body: 'SECRET-BODY-TEXT' });

    expect(result.isError).toBe(true);
    const recent = denialLog.getRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0].kind).toBe('simulation');
    expect(recent[0].who).toBe('gateway');
    assertNoContent(recent[0], ['customer@example.com', 'SECRET-BODY-TEXT']);
  });

  it('no matching mandate: refused and recorded (kind "not_authorized")', async () => {
    const state = buildState({ getEnrichedAuthorizations: () => [] });
    const handler = createGatedToolHandler(SEND_TOOL, buildIntegrationManager(), state);

    const result = await handler({ to: 'customer@example.com', body: 'SECRET-BODY-TEXT' });

    expect(result.isError).toBe(true);
    const recent = denialLog.getRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0].kind).toBe('not_authorized');
    expect(recent[0].who).toBe('gateway');
    expect(recent[0].code).toBe('NO_MATCHING_MANDATE');
    assertNoContent(recent[0], ['customer@example.com', 'SECRET-BODY-TEXT']);
  });

  it('local per-transaction bound exceeded: refused and recorded (kind "bound")', async () => {
    const enriched = [{ ...AUTH, gateContent: null } as EnrichedAuthorization];
    const state = buildState({
      getEnrichedAuthorizations: () => enriched,
      gatekeeper: {
        verifyExecution: async () => ({
          result: {
            approved: false,
            errors: [{
              code: 'BOUND_EXCEEDED',
              field: 'recipient_count',
              message: 'Value 5 exceeds authorized maximum of 3 for recipient_max',
              bound: 3,
              actual: 5,
            }],
          },
        }),
      },
    });
    const handler = createGatedToolHandler(SEND_TOOL, buildIntegrationManager(), state);

    const result = await handler({ to: 'customer@example.com', body: 'SECRET-BODY-TEXT' });

    expect(result.isError).toBe(true);
    const recent = denialLog.getRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0].kind).toBe('bound');
    expect(recent[0].who).toBe('gateway');
    expect(recent[0].code).toBe('BOUND_EXCEEDED');
    expect(recent[0].field).toBe('recipient_count');
    expect(recent[0].value).toBe(5);
    expect(recent[0].limit).toBe(3);
    expect(recent[0].mandateId).toBe(AUTH.authorizationId);
    assertNoContent(recent[0], ['customer@example.com', 'SECRET-BODY-TEXT']);
  });

  it('local scope constraint violated: refused and recorded (kind "scope")', async () => {
    const enriched = [{ ...AUTH, gateContent: null } as EnrichedAuthorization];
    const state = buildState({
      getEnrichedAuthorizations: () => enriched,
      gatekeeper: {
        verifyExecution: async () => ({
          result: {
            approved: false,
            errors: [{
              code: 'BOUND_EXCEEDED',
              field: 'allowed_domains',
              message: 'Values [other.example] not in authorized set [alpenwerk.example]',
              bound: 'alpenwerk.example',
              actual: 'other.example',
            }],
          },
        }),
      },
    });
    const handler = createGatedToolHandler(SEND_TOOL, buildIntegrationManager(), state);

    const result = await handler({ to: 'customer@other.example', body: 'SECRET-BODY-TEXT' });

    expect(result.isError).toBe(true);
    const recent = denialLog.getRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0].kind).toBe('scope');
    expect(recent[0].field).toBe('allowed_domains');
    assertNoContent(recent[0], ['customer@other.example', 'SECRET-BODY-TEXT']);
  });

  it('manifest action_type defect: refused and recorded (kind "bound")', async () => {
    const enriched = [{ ...AUTH, gateContent: null } as EnrichedAuthorization];
    const state = buildState({ getEnrichedAuthorizations: () => enriched });
    const badTool: DiscoveredTool = {
      ...SEND_TOOL,
      gating: { profile: 'email', executionMapping: {}, staticExecution: {} } as unknown as DiscoveredTool['gating'],
    };
    const handler = createGatedToolHandler(badTool, buildIntegrationManager(), state);

    const result = await handler({});

    expect(result.isError).toBe(true);
    const recent = denialLog.getRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0].kind).toBe('bound');
    expect(recent[0].code).toBe('MISSING_ACTION_TYPE');
    expect(recent[0].field).toBe('action_type');
  });

  it('Authority Server ticket refusal (CUMULATIVE_LIMIT_EXCEEDED): refused and recorded (kind "cumulative")', async () => {
    const enriched = [{ ...AUTH, gateContent: null } as EnrichedAuthorization];
    const postReceipt = async () => {
      throw new SPReceiptError('Cumulative daily count (7) exceeds send_daily_max=6', 403, {
        errors: [{ code: 'CUMULATIVE_LIMIT_EXCEEDED', message: 'Cumulative daily count (7) exceeds send_daily_max=6', expected: 6, actual: 7 }],
      });
    };
    const state = buildState({
      getEnrichedAuthorizations: () => enriched,
      spClient: { isUnlocked: () => true, postReceipt },
    });
    const handler = createGatedToolHandler(SEND_TOOL, buildIntegrationManager(), state);

    const result = await handler({ to: 'customer@alpenwerk.example', body: 'SECRET-BODY-TEXT' });

    expect(result.isError).toBe(true);
    const recent = denialLog.getRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0].kind).toBe('cumulative');
    expect(recent[0].who).toBe('authority-server');
    expect(recent[0].code).toBe('CUMULATIVE_LIMIT_EXCEEDED');
    expect(recent[0].value).toBe(7);
    expect(recent[0].limit).toBe(6);
    expect(recent[0].mandateId).toBe(AUTH.authorizationId);
    assertNoContent(recent[0], ['customer@alpenwerk.example', 'SECRET-BODY-TEXT']);
  });

  it('Authority Server ticket refusal (BOUND_EXCEEDED): refused and recorded (kind "bound", who "authority-server")', async () => {
    const enriched = [{ ...AUTH, gateContent: null } as EnrichedAuthorization];
    const postReceipt = async () => {
      throw new SPReceiptError('Per-transaction recipient_count (5) exceeds recipient_max=3', 403, {
        errors: [{ code: 'BOUND_EXCEEDED', field: 'recipient_count', message: 'exceeds', expected: 3, actual: 5 }],
      });
    };
    const state = buildState({
      getEnrichedAuthorizations: () => enriched,
      spClient: { isUnlocked: () => true, postReceipt },
    });
    const handler = createGatedToolHandler(SEND_TOOL, buildIntegrationManager(), state);

    const result = await handler({ to: 'customer@alpenwerk.example', body: 'SECRET-BODY-TEXT' });

    expect(result.isError).toBe(true);
    const recent = denialLog.getRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0].kind).toBe('bound');
    expect(recent[0].who).toBe('authority-server');
    expect(recent[0].code).toBe('BOUND_EXCEEDED');
    assertNoContent(recent[0], ['customer@alpenwerk.example', 'SECRET-BODY-TEXT']);
  });
});
