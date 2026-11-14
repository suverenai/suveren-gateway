/**
 * An omitted write argument must not leave a scoped field unchecked.
 *
 * hap-core skips a scope check when the call carries no value for the field,
 * and a connector then acts on a default of its own (LinkedIn posts PUBLIC,
 * Google Calendar acts on "primary"). Two rules, both generic and driven by the
 * manifest's executionMapping:
 *
 *  1. Fail closed: when a mapped argument is omitted, nothing else fills its
 *     field, and the mandate's scope constrains that field, the call is
 *     refused before any proposal or ticket, naming the argument.
 *  2. `argDefaults`: the manifest may declare the connector's own default. The
 *     gateway fills it in on arrival, checks it like any value, shows it in the
 *     proposal and sends it explicitly.
 *
 * Plus `sealedOnlyArgs`: a mapping never lifts the unsealed-argument refusal.
 *
 * Driven through the real `createGatedToolHandler` with a MADE-UP "venue"
 * profile and manifest — nothing here depends on LinkedIn, Calendar or Email.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerProfile, clearProfiles, type AgentProfile } from '@hap/core';
import { createGatedToolHandler, fieldsLeftByAbsentArgs, withArgDefaults } from '../src/lib/tool-proxy';
import { classifySealedArgs, unclassifiedArgs } from '../src/lib/sealed-args';
import { invalidArgDeclarationsReason } from '../src/lib/manifest-loader';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { CachedAuthorization } from '../src/lib/attestation-cache';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import { testReceiptKeypair, makeSignedReceipt, echoTicketRequest } from './helpers/real-receipt';

const PROFILE_ID = 'venue-omitted-test@1';
const PROFILE = {
  id: PROFILE_ID,
  name: 'Venue',
  version: '1',
  description: 'made-up profile: a room scope and a guest scope',
  boundsSchema: {
    keyOrder: ['profile', 'book_daily_max'],
    actionTypes: ['book'],
    fields: {
      profile: { type: 'string', required: true },
      book_daily_max: { type: 'number', required: false, boundType: { kind: 'cumulative_count', window: 'daily' }, appliesTo: ['book'] },
    },
  },
  scopeSchema: {
    keyOrder: ['rooms', 'guests'],
    fields: {
      rooms: { type: 'string', required: false, displayName: 'Bookable rooms', constraint: { type: 'string', enforceable: ['subset'] } },
      guests: { type: 'string', required: false, displayName: 'Guests', constraint: { type: 'string', enforceable: ['subset'] } },
    },
  },
  executionContextSchema: { fields: {} },
  requiredGates: [],
  ttl: { default: 3600, max: 3600 },
  retention_minimum: 1,
} as unknown as AgentProfile;

function tool(extra: Record<string, unknown> = {}): DiscoveredTool {
  return {
    originalName: 'book_room',
    namespacedName: 'venue__book_room',
    integrationId: 'venue',
    description: '',
    inputSchema: { type: 'object', properties: { room: {}, host: {}, extra_guests: {}, note: {} } },
    gating: {
      profile: PROFILE_ID,
      executionMapping: {
        room: 'rooms',
        host: [{ field: 'guests', transform: 'join', format: 'email' }],
        extra_guests: [{ field: 'guests', transform: 'join', format: 'email' }],
      },
      staticExecution: { action_type: 'book' },
      ...extra,
    },
  } as unknown as DiscoveredTool;
}

function auth(context: Record<string, string>, review = false): EnrichedAuthorization {
  const bounds = { profile: PROFILE_ID, book_daily_max: 5 };
  return {
    authorizationId: 'authz_00000000-0000-4000-8000-0000000venu1',
    profileId: PROFILE_ID,
    path: 'venue-routine',
    frame: bounds,
    bounds,
    context,
    attestations: [],
    requiredDomains: [],
    attestedDomains: [],
    deferredCommitmentDomains: review ? ['owner'] : [],
    complete: true,
    gateContent: null,
  } as unknown as EnrichedAuthorization;
}

async function call(t: DiscoveredTool, a: EnrichedAuthorization, args: Record<string, unknown>) {
  const kp = testReceiptKeypair();
  const postReceipt = vi.fn().mockImplementation(async (req: { action: string; executionContext?: Record<string, unknown>; authorizationId?: string; profileId?: string; idempotencyKey?: string }) => ({
    receipt: makeSignedReceipt(kp, {
      id: 'rcpt-venue-omit', action: req.action, ...echoTicketRequest(req), executionContext: req.executionContext ?? {},
      authorizationId: req.authorizationId, profileId: req.profileId, idempotencyKey: req.idempotencyKey,
    }),
  }));
  const submitProposal = vi.fn().mockResolvedValue({ proposal: { id: 'prop-venue-1' }, unreadableFor: [] });
  const recorded: Array<Record<string, unknown>> = [];
  const verifyExecution = vi.fn().mockResolvedValue({ result: { approved: true, errors: [] }, authorization: a });
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
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
  const im = { getAllTools: () => [t], callTool } as unknown as IntegrationManager;
  const result = await createGatedToolHandler(t, im, state)(args);
  return { result, text: (result.content[0] as { text: string }).text, verifyExecution, postReceipt, submitProposal, callTool, recorded };
}

beforeEach(() => registerProfile(PROFILE_ID, PROFILE));
afterEach(() => clearProfiles());

const REFUSAL = 'Refused: venue__book_room was called without "room", but the mandate limits "Bookable rooms" (rooms). ' +
  'Without it the connector would pick a value of its own that nobody checked. ' +
  'Call it again and state "room" explicitly. Nothing ran and no ticket was requested.';

describe('rule 1 — an omitted argument under a scope that constrains its field', () => {
  it('is refused, naming the argument: nothing checked, no ticket, no proposal, nothing ran, recorded under Blocked', async () => {
    const r = await call(tool(), auth({ rooms: 'r1' }), { host: 'h@x.example' });
    expect(r.result.isError).toBe(true);
    expect(r.text).toBe(REFUSAL);
    expect(r.verifyExecution).not.toHaveBeenCalled();
    expect(r.postReceipt).not.toHaveBeenCalled();
    expect(r.submitProposal).not.toHaveBeenCalled();
    expect(r.callTool).not.toHaveBeenCalled();
    expect(r.recorded).toEqual([expect.objectContaining({ kind: 'scope', code: 'SCOPE_INVALID_VALUE', field: 'rooms', who: 'gateway' })]);
  });

  it('a null argument counts as omitted', async () => {
    const r = await call(tool(), auth({ rooms: 'r1' }), { room: null, host: 'h@x.example' });
    expect(r.text).toBe(REFUSAL);
    expect(r.callTool).not.toHaveBeenCalled();
  });

  it('runs unchanged when the scope does not constrain the field', async () => {
    const r = await call(tool(), auth({ rooms: '' }), { host: 'h@x.example' });
    expect(r.result.isError).toBeFalsy();
    expect(r.callTool).toHaveBeenCalledOnce();
  });

  it('runs when another argument fills the shared field (an email without cc)', async () => {
    const r = await call(tool(), auth({ guests: 'h@x.example' }), { room: 'r1', host: 'h@x.example' });
    expect(r.result.isError).toBeFalsy();
    expect(r.callTool).toHaveBeenCalledOnce();
  });

  it('names every omitted argument of a field nothing filled', async () => {
    const r = await call(tool(), auth({ guests: 'h@x.example' }), { room: 'r1' });
    expect(r.result.isError).toBe(true);
    expect(r.text).toContain('was called without "host" or "extra_guests"');
    expect(r.callTool).not.toHaveBeenCalled();
  });

  it('a stated empty list is a value: nothing outside the scope, so it runs', async () => {
    const r = await call(tool(), auth({ guests: 'h@x.example' }), { room: 'r1', host: [] });
    expect(r.result.isError).toBeFalsy();
    expect(r.callTool).toHaveBeenCalledOnce();
  });
});

describe('rule 2 — argDefaults: the connector default, filled in, checked, shown and sent', () => {
  const withDefault = tool({ argDefaults: { room: 'lobby' } });

  it('the Gatekeeper checks the default and the connector receives it explicitly', async () => {
    const r = await call(withDefault, auth({ rooms: 'lobby' }), { host: 'h@x.example' });
    expect(r.result.isError).toBeFalsy();
    expect((r.verifyExecution.mock.calls[0][1] as Record<string, unknown>).rooms).toBe('lobby');
    expect((r.callTool.mock.calls[0][2] as Record<string, unknown>).room).toBe('lobby');
  });

  it('the default reaches the scope check, so a mandate that does not allow it is checked against it, not skipped', async () => {
    const r = await call(withDefault, auth({ rooms: 'r1' }), { host: 'h@x.example' });
    expect((r.verifyExecution.mock.calls[0]?.[1] as Record<string, unknown> | undefined)?.rooms).toBe('lobby');
  });

  it('under a review mandate the proposal the person approves carries the default as a value', async () => {
    const r = await call(withDefault, auth({ rooms: 'lobby' }, true), { host: 'h@x.example' });
    expect(r.submitProposal).toHaveBeenCalledOnce();
    expect((r.submitProposal.mock.calls[0][0] as { toolArgs: Record<string, unknown> }).toolArgs.room).toBe('lobby');
    expect(r.callTool).not.toHaveBeenCalled();
  });

  it('a stated value wins over the default', async () => {
    const r = await call(withDefault, auth({ rooms: 'r1' }), { room: 'r1', host: 'h@x.example' });
    expect((r.callTool.mock.calls[0][2] as Record<string, unknown>).room).toBe('r1');
  });

  it('withArgDefaults fills only absent or null arguments and copies lists', () => {
    const list: string[] = [];
    const out = withArgDefaults({ a: 'x', b: list, c: 1 }, { a: 'given', c: null });
    expect(out).toEqual({ a: 'given', b: [], c: 1 });
    expect(out.b).not.toBe(list);
    const args = { a: 'given' };
    expect(withArgDefaults(undefined, args)).toBe(args);
  });

  it('fieldsLeftByAbsentArgs ignores fields staticExecution or another argument filled', () => {
    const left = fieldsLeftByAbsentArgs({ a: 'f1', b: 'f2', c: 'f3' }, { b: 'x' }, { f3: 'static' });
    expect([...left.entries()]).toEqual([['f1', ['a']]]);
  });
});

describe('a blank string is not a stated value', () => {
  it('fieldsLeftByAbsentArgs: "" and whitespace count as omitted; an empty list does not', () => {
    const m = { a: 'f1', b: 'f2', c: [{ field: 'f3', transform: 'join' }] } as const;
    expect([...fieldsLeftByAbsentArgs(m, { a: '', b: ' \t ', c: [] }, {}).entries()]).toEqual([['f1', ['a']], ['f2', ['b']]]);
    // A blank argument does not hide that another, stated one filled the field.
    expect([...fieldsLeftByAbsentArgs({ x: 'f', y: 'f' }, { x: '', y: 'v' }, {}).entries()]).toEqual([]);
  });

  it('withArgDefaults: "" and whitespace are replaced by the default; an empty list is kept', () => {
    expect(withArgDefaults({ v: 'PUBLIC', l: ['d'] }, { v: '', l: [] })).toEqual({ v: 'PUBLIC', l: [] });
    expect(withArgDefaults({ v: 'PUBLIC' }, { v: '   ' })).toEqual({ v: 'PUBLIC' });
  });

  it('through the write path: room "" under a rooms scope is refused before any ticket', async () => {
    const r = await call(tool(), auth({ rooms: 'r1' }), { room: '', host: 'h@x.example' });
    expect(r.text).toBe(REFUSAL);
    expect(r.verifyExecution).not.toHaveBeenCalled();
    expect(r.postReceipt).not.toHaveBeenCalled();
    expect(r.callTool).not.toHaveBeenCalled();
  });

  it('through the write path: room "" with a declared default gets the default, checked and sent', async () => {
    const r = await call(tool({ argDefaults: { room: 'lobby' } }), auth({ rooms: 'lobby' }), { room: '', host: 'h@x.example' });
    expect((r.verifyExecution.mock.calls[0][1] as Record<string, unknown>).rooms).toBe('lobby');
    expect((r.callTool.mock.calls[0][2] as Record<string, unknown>).room).toBe('lobby');
  });
});

describe('sealedOnlyArgs — a mapping adds checks, it never lifts the unsealed-argument refusal', () => {
  const gating = {
    staticExecution: { action_type: 'book' },
    executionMapping: { host: 'guests', extra_guests: 'guests' },
    message: { text: 'note', verb: 'Sent' },
  };
  const textBinding = { version: '1', kind: 'text' } as never;
  const fieldBinding = { version: '2', kind: 'jcs', fields: ['host', 'extra_guests', 'note'], appliesTo: ['book'] } as never;
  const args = { host: 'h@x.example', extra_guests: ['g@x.example'], note: 'hi' };

  it('without the declaration, mapping an argument makes it a reference (allowed under a version that seals only the text)', () => {
    expect(unclassifiedArgs(gating, textBinding, args)).toEqual([]);
  });

  it('declared sealed-only: refused under a version that does not bind it', () => {
    expect(unclassifiedArgs({ ...gating, sealedOnlyArgs: ['extra_guests'] }, textBinding, args)).toEqual(['extra_guests']);
  });

  it('declared sealed-only: allowed under a version that binds it', () => {
    expect(unclassifiedArgs({ ...gating, sealedOnlyArgs: ['extra_guests'] }, fieldBinding, args)).toEqual([]);
    expect(classifySealedArgs({ ...gating, sealedOnlyArgs: ['extra_guests'] }, fieldBinding).classes.get('extra_guests')).toBe('bound');
  });
});

describe('the manifest validator: sealedOnlyArgs and argDefaults', () => {
  it('accepts well-formed declarations', () => {
    expect(invalidArgDeclarationsReason('t', { sealedOnlyArgs: ['cc'], argDefaults: { v: 'PUBLIC', a: [], n: 1, b: false } })).toBeNull();
  });
  it('refuses a malformed or misplaced sealedOnlyArgs', () => {
    expect(invalidArgDeclarationsReason('t', { sealedOnlyArgs: [] })).toBe('override "t".sealedOnlyArgs must be a non-empty list of argument names');
    expect(invalidArgDeclarationsReason('t', { category: 'read', sealedOnlyArgs: ['cc'] })).toBe('override "t".sealedOnlyArgs is allowed on write tools only');
    expect(invalidArgDeclarationsReason('t', { sealedOnlyArgs: ['cc'], nonContentArgs: ['cc'] })).toMatch(/declared not content/);
    expect(invalidArgDeclarationsReason('t', { sealedOnlyArgs: ['cc'], blockedArgs: ['cc'] })).toMatch(/is blocked/);
  });
  it('refuses a malformed or misplaced argDefaults', () => {
    expect(invalidArgDeclarationsReason('t', { argDefaults: {} })).toMatch(/non-empty object/);
    expect(invalidArgDeclarationsReason('t', { category: 'read', argDefaults: { v: 'x' } })).toBe('override "t".argDefaults is allowed on write tools only');
    expect(invalidArgDeclarationsReason('t', { argDefaults: { ticket_id: 'x' } })).toMatch(/owned by the gateway/);
    expect(invalidArgDeclarationsReason('t', { argDefaults: { raw: 'x' }, blockedArgs: ['raw'] })).toMatch(/is blocked/);
    expect(invalidArgDeclarationsReason('t', { argDefaults: { v: { nested: 1 } } })).toBe('override "t".argDefaults."v" must be a string, number, boolean or a list of them');
  });
});
