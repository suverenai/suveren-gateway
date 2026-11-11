/**
 * A profile's `scopeSchema.atLeastOne` (@hap/core/scope-rules): for a listed action
 * type, the Gatekeeper refuses an execution under a mandate whose scope sets none of
 * the group's fields — nothing runs, no ticket is requested, the refusal is recorded
 * under Blocked. Scope never reaches the Authority Server, so this gateway is the only
 * place that can refuse it.
 *
 * Driven through the real `createGatedToolHandler` with a MADE-UP profile whose group
 * has other field names than any shipped profile: nothing here depends on Email.
 * The Gatekeeper approves unconditionally, so only the group can refuse.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { registerProfile, clearProfiles, getAllProfiles, boundActionTypes, type AgentProfile } from '@hap/core';
import {
  atLeastOneGroups, boundGovernsActions, unmetForMandate, unmetForAction,
  atLeastOneBuildRefusal, atLeastOneExecutionRefusal,
} from '@hap/core/scope-rules';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import { loadProfiles } from '../src/lib/profile-loader';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { CachedAuthorization } from '../src/lib/attestation-cache';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import { testReceiptKeypair, makeSignedReceipt, echoTicketRequest } from './helpers/real-receipt';

const NEW_ID = 'venue-at-least-one-test@2';
const OLD_ID = 'venue-at-least-one-test@1';

function venue(id: string, version: string, group: boolean): AgentProfile {
  return {
    id,
    name: 'Venue',
    version,
    description: 'made-up profile for scopeSchema.atLeastOne',
    boundsSchema: {
      keyOrder: ['profile', 'book_daily_max', 'cancel_daily_max'],
      actionTypes: ['book', 'cancel'],
      fields: {
        profile: { type: 'string', required: true },
        book_daily_max: { type: 'number', required: false, boundType: { kind: 'cumulative_count', window: 'daily' }, appliesTo: ['book'] },
        cancel_daily_max: { type: 'number', required: false, boundType: { kind: 'cumulative_count', window: 'daily' }, appliesTo: ['cancel'] },
      },
    },
    scopeSchema: {
      keyOrder: ['rooms', 'buildings', 'note'],
      fields: {
        rooms: { type: 'string', required: false, displayName: 'Bookable rooms', constraint: { type: 'string', enforceable: ['subset'] } },
        buildings: { type: 'string', required: false, displayName: 'Bookable buildings', constraint: { type: 'string', enforceable: ['subset'] } },
        note: { type: 'string', required: false, displayName: 'Note', constraint: { type: 'string', enforceable: ['subset'] } },
      },
      ...(group ? { atLeastOne: [{ fields: ['rooms', 'buildings'], requiredFor: ['book'] }] } : {}),
    },
    executionContextSchema: { fields: {} },
    requiredGates: [],
    ttl: { default: 3600, max: 3600 },
    retention_minimum: 1,
  } as unknown as AgentProfile;
}
const NEW = venue(NEW_ID, '2', true);
const OLD = venue(OLD_ID, '1', false);

function auth(profileId: string, context: Record<string, string>): EnrichedAuthorization {
  const bounds = { profile: profileId, book_daily_max: 5, cancel_daily_max: 5 };
  return {
    authorizationId: 'authz_00000000-0000-4000-8000-0000000venue',
    profileId,
    path: 'venue-routine',
    frame: bounds,
    bounds,
    context,
    attestations: [],
    requiredDomains: [],
    attestedDomains: [],
    deferredCommitmentDomains: [],
    complete: true,
    gateContent: null,
  } as unknown as EnrichedAuthorization;
}

function tool(profile: string, actionType: string): DiscoveredTool {
  return {
    originalName: `${actionType}_room`,
    namespacedName: `venue__${actionType}_room`,
    integrationId: 'venue',
    description: '',
    inputSchema: { type: 'object', properties: { room: {} } },
    gating: { profile, executionMapping: {}, staticExecution: { action_type: actionType } },
  } as unknown as DiscoveredTool;
}

async function run(a: EnrichedAuthorization, actionType: string) {
  const kp = testReceiptKeypair();
  const postReceipt = vi.fn().mockImplementation(async (req: { action: string; executionContext?: Record<string, unknown>; authorizationId?: string; profileId?: string; idempotencyKey?: string }) => ({
    receipt: makeSignedReceipt(kp, {
      id: 'rcpt-venue-1', action: req.action, ...echoTicketRequest(req), executionContext: req.executionContext ?? {},
      authorizationId: req.authorizationId, profileId: req.profileId, idempotencyKey: req.idempotencyKey,
    }),
  }));
  const submitProposal = vi.fn();
  const recorded: Array<Record<string, unknown>> = [];
  const verifyExecution = vi.fn().mockResolvedValue({ result: { approved: true, errors: [] } });
  const state = {
    getEnrichedAuthorizations: () => [a],
    spClient: { postReceipt, submitProposal, isUnlocked: () => true },
    cache: { getAllAuthorizations: () => [a as unknown as CachedAuthorization], getPublicKey: async () => kp.publicKeyHex, getTrustedIssuer: async () => kp.issuer },
    gatekeeper: { verifyExecution },
    executionLog: { record: vi.fn() },
    executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
    archiveReceipt: vi.fn().mockResolvedValue(undefined),
    denialLog: { record: (r: Record<string, unknown>) => recorded.push(r) },
  } as unknown as SharedState;
  const t = tool(a.profileId, actionType);
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
  const im = { getAllTools: () => [t], callTool } as unknown as IntegrationManager;
  const result = await createGatedToolHandler(t, im, state)({ room: 'r1' });
  return { result, text: (result.content[0] as { text: string }).text, postReceipt, submitProposal, callTool, recorded };
}

const SENTENCE = 'This mandate names no bookable room or building, so it cannot book. The person gives a new Venue mandate that says which bookable room or building the AI may use.';

beforeAll(() => { registerProfile(NEW_ID, NEW); registerProfile(OLD_ID, OLD); });
afterAll(() => clearProfiles());

describe('the Gatekeeper and scopeSchema.atLeastOne', () => {
  it('refuses a listed action when the scope sets none of the group: nothing runs, no ticket, recorded under Blocked', async () => {
    const r = await run(auth(NEW_ID, { rooms: '', note: 'x' }), 'book');
    expect(r.result.isError).toBe(true);
    expect(r.text).toBe(`${SENTENCE} Nothing ran.`);
    expect(r.postReceipt).not.toHaveBeenCalled();
    expect(r.submitProposal).not.toHaveBeenCalled();
    expect(r.callTool).not.toHaveBeenCalled();
    expect(r.recorded).toEqual([expect.objectContaining({ kind: 'scope', code: 'SCOPE_INVALID_VALUE', field: 'rooms', who: 'gateway', detail: SENTENCE })]);
  });

  it('a list of only commas and spaces counts as empty', async () => {
    const r = await run(auth(NEW_ID, { buildings: ' , ' }), 'book');
    expect(r.text).toBe(`${SENTENCE} Nothing ran.`);
    expect(r.callTool).not.toHaveBeenCalled();
  });

  it('runs when one field of the group is set', async () => {
    const r = await run(auth(NEW_ID, { buildings: 'north' }), 'book');
    expect(r.result.isError).toBeFalsy();
    expect(r.postReceipt).toHaveBeenCalledOnce();
    expect(r.callTool).toHaveBeenCalledOnce();
  });

  it('an action type the group does not list is not affected', async () => {
    const r = await run(auth(NEW_ID, {}), 'cancel');
    expect(r.result.isError).toBeFalsy();
    expect(r.callTool).toHaveBeenCalledOnce();
  });

  it('a mandate under a version that declares no group keeps working', async () => {
    const r = await run(auth(OLD_ID, {}), 'book');
    expect(r.result.isError).toBeFalsy();
    expect(r.callTool).toHaveBeenCalledOnce();
  });
});

describe('scope-rules: building a mandate', () => {
  it('refuses while a listed action is allowed, with the sentence built from the profile', () => {
    const unmet = unmetForMandate(NEW, {}, { book_daily_max: 3 });
    expect(unmet.map(u => u.actionType)).toEqual(['book']);
    expect(atLeastOneBuildRefusal(NEW, unmet[0])).toBe('A Venue mandate that allows booking must name at least one bookable room or building. Ask the person which bookable room or building the AI may use.');
    expect(atLeastOneExecutionRefusal(NEW, unmetForAction(NEW, {}, 'book')!)).toBe(SENTENCE);
  });

  it('needs neither field when the limits allow none of the listed actions (a count limit of 0)', () => {
    expect(unmetForMandate(NEW, {}, { book_daily_max: 0, cancel_daily_max: 4 })).toEqual([]);
    expect(unmetForMandate(NEW, {}, { book_daily_max: '0' })).toEqual([]);
  });

  it('an unset count limit allows the action, so the group applies', () => {
    expect(unmetForMandate(NEW, { note: 'x' }, {})).toHaveLength(1);
  });

  it('the profile\'s own `ask` is used when it gives one', () => {
    const withAsk = { ...NEW, scopeSchema: { ...NEW.scopeSchema, atLeastOne: [{ fields: ['rooms', 'buildings'], requiredFor: ['book'], ask: 'where the AI may book' }] } } as unknown as AgentProfile;
    const u = unmetForMandate(withAsk, {}, {})[0];
    expect(atLeastOneBuildRefusal(withAsk, u)).toBe('A Venue mandate that allows booking must name at least one bookable room or building. Ask the person where the AI may book.');
    expect(atLeastOneExecutionRefusal(withAsk, u)).toBe('This mandate names no bookable room or building, so it cannot book. The person gives a new Venue mandate that says where the AI may book.');
  });

  it('drops malformed groups', () => {
    const odd = { ...NEW, scopeSchema: { ...NEW.scopeSchema, atLeastOne: [{ fields: [] , requiredFor: ['book'] }, { fields: ['rooms'] }, 'x', null] } } as unknown as AgentProfile;
    expect(atLeastOneGroups(odd)).toEqual([]);
  });

});

describe('scope-rules reads which actions a bound governs exactly as hap-core does', () => {
  it('for every bound of every shipped profile', () => {
    clearProfiles();
    loadProfiles(process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles'));
    const all = getAllProfiles();
    expect(all.length).toBeGreaterThan(0);
    let n = 0;
    for (const p of all) {
      for (const [name, def] of Object.entries(p.boundsSchema?.fields ?? {})) {
        expect(boundGovernsActions(name, def), `${p.id} ${name}`).toEqual(boundActionTypes(name, def));
        n++;
      }
    }
    expect(n).toBeGreaterThan(0);
    clearProfiles();
    registerProfile(NEW_ID, NEW); registerProfile(OLD_ID, OLD);
  });
});
