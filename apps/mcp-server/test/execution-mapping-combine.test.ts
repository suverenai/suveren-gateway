/**
 * Several arguments that map to ONE execution field combine: a count is the
 * sum, a list is the union. Before this, the last argument in the mapping
 * overwrote the field — so a second recipient argument (an email's `cc`)
 * could carry any address past the recipient scope and the per-email count.
 *
 * Driven through the real `createGatedToolHandler` with a MADE-UP profile and
 * manifest (a parcel service with `deliver_to` and `copy_to` stops), so
 * nothing here depends on Email. The Gatekeeper is a recording double: these
 * tests are about WHAT tool-proxy hands the Gatekeeper and the Authority
 * Server; hap-core's subset/max comparison is tested in hap-core.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerProfile, clearProfiles, type AgentProfile } from '@hap/core';
import { createGatedToolHandler, mapExecutionArgs } from '../src/lib/tool-proxy';
import {
  invalidExecutionMappingReason,
  invalidManifestExecutionMappingReason,
  invalidMessageRecipientsReason,
} from '../src/lib/manifest-loader';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { CachedAuthorization } from '../src/lib/attestation-cache';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import { testReceiptKeypair, makeSignedReceipt, echoTicketRequest } from './helpers/real-receipt';

const PROFILE_ID = 'parcel-combine-test@1';

const PROFILE = {
  id: PROFILE_ID,
  name: 'Parcel',
  version: '1',
  description: 'made-up profile: several stop arguments, one count bound, two scope lists',
  boundsSchema: {
    keyOrder: ['profile', 'stops_max'],
    actionTypes: ['ship'],
    fields: {
      profile: { type: 'string', required: true },
      stops_max: { type: 'number', required: false, boundType: { kind: 'per_transaction', of: 'stop_count' } },
    },
  },
  scopeSchema: {
    keyOrder: ['allowed_stops', 'allowed_regions'],
    fields: {
      allowed_stops: { type: 'string', required: false, constraint: { type: 'string', enforceable: ['subset'] } },
      allowed_regions: { type: 'string', required: false, constraint: { type: 'string', enforceable: ['subset'] } },
    },
  },
  executionContextSchema: {
    fields: {
      stop_count: { source: 'declared', description: '', required: true, constraint: { type: 'number', enforceable: ['max'] } },
      allowed_stops: { source: 'declared', description: '', required: false, constraint: { type: 'string', enforceable: ['subset'] } },
      allowed_regions: { source: 'declared', description: '', required: false, constraint: { type: 'string', enforceable: ['subset'] } },
    },
  },
  requiredGates: [],
  ttl: { default: 3600, max: 3600 },
  retention_minimum: 1,
} as unknown as AgentProfile;

/** Every stop argument maps to the same three fields. */
const STOP_MAPPING = [
  { field: 'stop_count', transform: 'length' },
  { field: 'allowed_stops', transform: 'join' },
  { field: 'allowed_regions', transform: 'join_domains' },
] as const;

const SHIP: DiscoveredTool = {
  originalName: 'ship',
  namespacedName: 'parcel__ship',
  integrationId: 'parcel',
  description: '',
  inputSchema: { type: 'object', properties: { deliver_to: {}, copy_to: {}, label: {} } },
  gating: {
    profile: PROFILE_ID,
    executionMapping: { deliver_to: [...STOP_MAPPING], copy_to: [...STOP_MAPPING] },
    staticExecution: { action_type: 'ship' },
  },
} as unknown as DiscoveredTool;

const AUTH = {
  authorizationId: 'authz_00000000-0000-4000-8000-0000000parc1',
  profileId: PROFILE_ID,
  path: 'parcel-routine',
  frame: { profile: PROFILE_ID, stops_max: 5 },
  bounds: { profile: PROFILE_ID, stops_max: 5 },
  context: { allowed_regions: 'north.example' },
  attestations: [],
  requiredDomains: [],
  attestedDomains: [],
  deferredCommitmentDomains: [],
  complete: true,
  gateContent: null,
} as unknown as EnrichedAuthorization;

async function ship(args: Record<string, unknown>) {
  const kp = testReceiptKeypair();
  const postReceipt = vi.fn().mockImplementation(async (req: { action: string; executionContext?: Record<string, unknown>; authorizationId?: string; profileId?: string; idempotencyKey?: string }) => ({
    receipt: makeSignedReceipt(kp, {
      id: 'rcpt-parcel-1', action: req.action, ...echoTicketRequest(req), executionContext: req.executionContext ?? {},
      authorizationId: req.authorizationId, profileId: req.profileId, idempotencyKey: req.idempotencyKey,
    }),
  }));
  const verifyExecution = vi.fn().mockResolvedValue({ result: { approved: true, errors: [] }, authorization: AUTH });
  const state = {
    getEnrichedAuthorizations: () => [AUTH],
    spClient: { postReceipt, submitProposal: vi.fn(), isUnlocked: () => true },
    cache: { getAllAuthorizations: () => [AUTH as unknown as CachedAuthorization], getPublicKey: async () => kp.publicKeyHex, getTrustedIssuer: async () => kp.issuer },
    gatekeeper: { verifyExecution },
    executionLog: { record: vi.fn() },
    executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
    archiveReceipt: vi.fn().mockResolvedValue(undefined),
    denialLog: { record: vi.fn() },
  } as unknown as SharedState;
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
  const im = { getAllTools: () => [SHIP], callTool } as unknown as IntegrationManager;
  const result = await createGatedToolHandler(SHIP, im, state)(args);
  return { result, verifyExecution, postReceipt, callTool };
}

beforeEach(() => registerProfile(PROFILE_ID, PROFILE));
afterEach(() => clearProfiles());

describe('several arguments mapped to one execution field combine', () => {
  it('the Gatekeeper sees every stop: the count is the sum, the lists are the union', async () => {
    const r = await ship({
      deliver_to: ['a@north.example'],
      copy_to: ['b@south.example', 'c@north.example'],
      label: 'x',
    });
    expect(r.verifyExecution).toHaveBeenCalledOnce();
    const execution = r.verifyExecution.mock.calls[0][1] as Record<string, unknown>;
    expect(execution.stop_count).toBe(3);
    expect(execution.allowed_stops).toBe('a@north.example,b@south.example,c@north.example');
    // The outside region reaches the scope check — before, `copy_to` overwrote
    // `deliver_to` (or the other way round) and a region could hide.
    expect(execution.allowed_regions).toBe('north.example,south.example');
  });

  it('the count the Authority Server checks is the sum too', async () => {
    const r = await ship({ deliver_to: ['a@north.example', 'b@north.example'], copy_to: ['c@north.example'] });
    expect(r.postReceipt).toHaveBeenCalledOnce();
    const sent = r.postReceipt.mock.calls[0][0] as { executionContext: Record<string, unknown> };
    expect(sent.executionContext.stop_count).toBe(3);
  });

  it('an absent or empty second argument changes nothing', async () => {
    const a = await ship({ deliver_to: ['a@north.example'] });
    const e1 = a.verifyExecution.mock.calls[0][1] as Record<string, unknown>;
    expect(e1).toMatchObject({ stop_count: 1, allowed_stops: 'a@north.example', allowed_regions: 'north.example' });
    const b = await ship({ deliver_to: ['a@north.example'], copy_to: [] });
    const e2 = b.verifyExecution.mock.calls[0][1] as Record<string, unknown>;
    expect(e2).toMatchObject({ stop_count: 1, allowed_stops: 'a@north.example', allowed_regions: 'north.example' });
  });

  it('only the second argument set: it alone fills the fields', async () => {
    const r = await ship({ copy_to: ['z@west.example'] });
    const e = r.verifyExecution.mock.calls[0][1] as Record<string, unknown>;
    expect(e).toMatchObject({ stop_count: 1, allowed_stops: 'z@west.example', allowed_regions: 'west.example' });
  });
});

describe('mapExecutionArgs (pure)', () => {
  it('order of the arguments does not change the result', () => {
    const m = { deliver_to: [...STOP_MAPPING], copy_to: [...STOP_MAPPING] };
    const swapped = { copy_to: [...STOP_MAPPING], deliver_to: [...STOP_MAPPING] };
    const args = { deliver_to: ['a@b.example'], copy_to: ['c@d.example'] };
    expect(mapExecutionArgs(m, args)).toEqual({ stop_count: 2, allowed_stops: 'a@b.example,c@d.example', allowed_regions: 'b.example,d.example' });
    expect(mapExecutionArgs(swapped, args)).toMatchObject({ stop_count: 2, allowed_regions: 'b.example,d.example' });
  });

  it('each argument reads its own declared `item`', () => {
    const m = {
      hosts: { field: 'guests', transform: 'join', item: 'email' },
      extra: { field: 'guests', transform: 'join' },
    } as const;
    expect(mapExecutionArgs(m, { hosts: [{ email: 'h@x.example' }], extra: ['e@y.example'] })).toEqual({ guests: 'h@x.example,e@y.example' });
  });

  it('single-argument mappings are unchanged (direct, divisor, transform)', () => {
    const m = { amount: 'amount', cents: { field: 'eur', divisor: 100 }, to: [{ field: 'n', transform: 'length' }] } as const;
    expect(mapExecutionArgs(m, { amount: '0.10', cents: 250, to: ['a', 'b'] })).toEqual({ amount: '0.10', eur: 2.5, n: 2 });
  });
});

describe('the manifest validator', () => {
  it('accepts several arguments on one field when all use the same list transform', () => {
    expect(invalidExecutionMappingReason('ship', { executionMapping: { deliver_to: [...STOP_MAPPING], copy_to: [...STOP_MAPPING] } })).toBeNull();
  });

  it('refuses two arguments copied directly into one field (one would overwrite the other)', () => {
    expect(invalidExecutionMappingReason('ship', { executionMapping: { a: 'x', b: 'x' } }))
      .toBe('override "ship".executionMapping maps "a" and "b" to "x"; several arguments can share a field only through the same list transform (length, join or join_domains)');
  });

  it('refuses a divisor shared by two arguments', () => {
    expect(invalidExecutionMappingReason('ship', { executionMapping: { a: { field: 'x', divisor: 100 }, b: { field: 'x', divisor: 100 } } })).toMatch(/several arguments can share a field only/);
  });

  it('refuses two different transforms on one field', () => {
    expect(invalidExecutionMappingReason('ship', { executionMapping: { a: [{ field: 'x', transform: 'length' }], b: [{ field: 'x', transform: 'join' }] } })).toMatch(/several arguments can share a field only/);
  });

  it('refuses one argument mapped twice to the same field', () => {
    expect(invalidExecutionMappingReason('ship', { executionMapping: { a: [{ field: 'x', transform: 'join' }, { field: 'x', transform: 'join' }] } }))
      .toBe('override "ship".executionMapping maps "a" to "x" twice');
  });

  it('walks the default entry and every override of a manifest', () => {
    expect(invalidManifestExecutionMappingReason({ toolGating: { default: { executionMapping: { a: 'x', b: 'x' }, staticExecution: {} }, overrides: {} } } as never))
      .toMatch(/^default\.executionMapping maps "a" and "b"/);
    expect(invalidManifestExecutionMappingReason({ toolGating: { default: { executionMapping: {}, staticExecution: {} }, overrides: { ship: { executionMapping: { a: 'x', b: 'x' } } } } } as never))
      .toMatch(/^override "ship"/);
  });
});

describe('a declared message recipient argument maps to every field the main recipient maps to', () => {
  const message = { text: 'body', to: 'deliver_to', cc: 'copy_to', verb: 'Sent' };

  it('refuses a `cc` argument that is not mapped where `to` is (it would bypass count and scope)', () => {
    expect(invalidMessageRecipientsReason('ship', { message, executionMapping: { deliver_to: [...STOP_MAPPING] } }))
      .toBe('override "ship": the message cc argument "copy_to" must map to every field the to argument "deliver_to" maps to (missing: stop_count, allowed_stops, allowed_regions)');
  });

  it('refuses a partial mapping', () => {
    expect(invalidMessageRecipientsReason('ship', { message, executionMapping: { deliver_to: [...STOP_MAPPING], copy_to: [STOP_MAPPING[0]] } }))
      .toMatch(/missing: allowed_stops, allowed_regions\)$/);
  });

  it('accepts the same mapping on both', () => {
    expect(invalidMessageRecipientsReason('ship', { message, executionMapping: { deliver_to: [...STOP_MAPPING], copy_to: [...STOP_MAPPING] } })).toBeNull();
  });

  it('nothing to check when `to` is not mapped or no `cc` is declared', () => {
    expect(invalidMessageRecipientsReason('ship', { message, executionMapping: {} })).toBeNull();
    expect(invalidMessageRecipientsReason('ship', { message: { text: 'body', to: 'deliver_to', verb: 'Sent' }, executionMapping: { deliver_to: [...STOP_MAPPING] } })).toBeNull();
  });
});

describe('the shipped manifests', () => {
  const dir = join(import.meta.dirname, '..', '..', '..', 'content', 'integrations');
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf-8')) as { integrations: Record<string, string> };

  it('every shipped manifest passes both executionMapping rules (a cc never escapes count and scope)', () => {
    const reasons: string[] = [];
    for (const [id, file] of Object.entries(index.integrations)) {
      const reason = invalidManifestExecutionMappingReason(JSON.parse(readFileSync(join(dir, file), 'utf-8')));
      if (reason) reasons.push(`${id}: ${reason}`);
    }
    expect(reasons).toEqual([]);
  });
});
