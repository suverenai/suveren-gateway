/**
 * The hash preimage never reaches the Authority Server.
 *
 * `computeContentBinding` returns three things: `contentHash`, `contentBinding`
 * (how to reproduce it) and `boundContent` — EXACTLY the plaintext that was
 * hashed, kept so the local archive holds a copy the receipt can be checked
 * against. Both receipt call sites spread that object into the request body
 * (`...(binding ?? {})`), which shipped an email's to/cc/subject/body to the AS
 * on every gated send. The whole point of a content binding is that the AS
 * signs a fingerprint and never sees the content, so the leak did not weaken
 * the proof — it destroyed the privacy property the proof exists to provide.
 *
 * These tests capture what each path actually hands to `postReceipt` and assert
 * the hash goes and the content does not. Both paths are covered because they
 * are separate call sites with separate code: the automatic path
 * (tool-proxy.ts) and the review path (commitments.ts). The archive is asserted
 * too — the content must still be kept locally, or the fix would trade a
 * privacy bug for a lost-evidence bug.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerProfile, clearProfiles } from '@hap/core';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import { executeCommitted } from '../src/tools/commitments';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { CachedAuthorization } from '../src/lib/attestation-cache';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import type { SPProposal } from '../src/lib/sp-client';

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/email-privacy-test@0.5';
const SHORT = 'email-privacy-test';

/** The message. Every one of these strings is a leak if it reaches the AS. */
const ARGS = {
  to: ['investor@example.com'],
  cc: ['board@example.com'],
  subject: 'Series A term sheet',
  body: 'Confidential: we are raising at a 40M valuation.',
};
const SECRETS = [
  'investor@example.com',
  'board@example.com',
  'Series A term sheet',
  '40M valuation',
];

const profilesDir =
  process.env.SUVEREN_PROFILES_DIR ??
  join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');

/** The shipped email binding — to/cc/subject/body, required to+body. */
const shippedBinding = (
  JSON.parse(readFileSync(join(profilesDir, 'email', '0.5.profile.json'), 'utf-8')) as {
    content_binding: Record<string, unknown>;
  }
).content_binding;

beforeAll(() => {
  registerProfile(PROFILE_ID, {
    id: PROFILE_ID,
    version: '0.5',
    description: 'test',
    executionContextSchema: { fields: {} },
    requiredGates: [],
    ttl: { default: 1, max: 1 },
    retention_minimum: 1,
    content_binding: shippedBinding as never,
  } as never);
});

afterAll(() => {
  clearProfiles();
});

const TOOL: DiscoveredTool = {
  originalName: 'send_message',
  namespacedName: 'gmail__send_message',
  integrationId: 'gmail',
  description: '',
  inputSchema: { type: 'object', properties: { to: {}, cc: {}, subject: {}, body: { type: 'string' } } },
  gating: {
    profile: SHORT,
    executionMapping: {},
    staticExecution: { action_type: 'send' },
  } as unknown as DiscoveredTool['gating'],
};

const AUTH: CachedAuthorization = {
  authorizationId: 'authz_00000000-0000-4000-8000-00000000beef',
  profileId: PROFILE_ID,
  path: 'email-routine',
  frame: { profile: PROFILE_ID, path: 'email-routine' },
  attestations: [],
  requiredDomains: [],
  attestedDomains: [],
  complete: true,
} as unknown as CachedAuthorization;

function buildState() {
  const postReceipt = vi.fn().mockResolvedValue({ receipt: { id: 'rcpt-1' } });
  const archiveReceipt = vi.fn().mockResolvedValue(undefined);
  const enriched: EnrichedAuthorization[] = [{ ...AUTH, gateContent: null } as EnrichedAuthorization];
  const state = {
    getEnrichedAuthorizations: () => enriched,
    spClient: { postReceipt, isUnlocked: () => true },
    cache: { getAllAuthorizations: () => [AUTH] },
    gatekeeper: {
      verifyExecution: vi.fn().mockResolvedValue({
        result: { approved: true, errors: [] },
        authorization: AUTH,
      }),
    },
    executionLog: { record: vi.fn() },
    archiveReceipt,
  } as unknown as SharedState;
  return { state, postReceipt, archiveReceipt };
}

function buildIntegrationManager() {
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'sent' }] });
  return {
    integrationManager: { getAllTools: () => [TOOL], callTool } as unknown as IntegrationManager,
    callTool,
  };
}

const PROPOSAL: SPProposal = {
  id: 'prop-1',
  authorizationId: AUTH.authorizationId,
  profileId: PROFILE_ID,
  path: 'email-routine',
  pendingDomains: [],
  committedBy: { owner: { userId: 'andreas', at: 0 } },
  rejectedBy: null,
  tool: 'gmail__send_message',
  toolArgs: { ...ARGS },
  executionContext: { action_type: 'send' },
  status: 'committed',
  executionResult: null,
  createdAt: 0,
  expiresAt: 0,
} as unknown as SPProposal;

/** What the client would put on the wire for this call. */
function wireBody(postReceipt: ReturnType<typeof vi.fn>): string {
  return JSON.stringify(postReceipt.mock.calls[0][0]);
}

describe('automatic path (tool-proxy) — the receipt request carries the hash, not the content', () => {
  it('sends contentHash + contentBinding and NO boundContent', async () => {
    const { state, postReceipt } = buildState();
    const { integrationManager } = buildIntegrationManager();

    await createGatedToolHandler(TOOL, integrationManager, state)({ ...ARGS });

    expect(postReceipt).toHaveBeenCalledOnce();
    const sent = postReceipt.mock.calls[0][0] as Record<string, unknown>;
    // The binding must actually be present — a test that only checks absence
    // would pass on a call that computed no binding at all.
    expect(typeof sent.contentHash).toBe('string');
    expect(sent.contentBinding).toEqual({
      version: '2',
      kind: 'jcs',
      fields: ['to', 'cc', 'subject', 'body'],
    });
    expect(sent).not.toHaveProperty('boundContent');
  });

  it('puts none of the message on the wire — not the recipients, subject or body', async () => {
    // Asserted on the serialized body, so a leak under any other key (or
    // nested anywhere) fails here too.
    const { state, postReceipt } = buildState();
    const { integrationManager } = buildIntegrationManager();

    await createGatedToolHandler(TOOL, integrationManager, state)({ ...ARGS });

    const body = wireBody(postReceipt);
    for (const secret of SECRETS) expect(body).not.toContain(secret);
  });

  it('still archives the bound content locally — the copy stays, it just stays here', async () => {
    const { state, archiveReceipt } = buildState();
    const { integrationManager } = buildIntegrationManager();

    await createGatedToolHandler(TOOL, integrationManager, state)({ ...ARGS });

    const opts = archiveReceipt.mock.calls[0][1] as { boundContent?: Record<string, unknown> };
    expect(opts.boundContent).toEqual(ARGS);
  });
});

describe('review path (commitments) — the receipt request carries the hash, not the content', () => {
  it('sends contentHash + contentBinding and NO boundContent', async () => {
    const { state, postReceipt } = buildState();
    const { integrationManager } = buildIntegrationManager();

    await executeCommitted(PROPOSAL, state, integrationManager);

    expect(postReceipt).toHaveBeenCalledOnce();
    const sent = postReceipt.mock.calls[0][0] as Record<string, unknown>;
    expect(typeof sent.contentHash).toBe('string');
    expect(sent.contentBinding).toEqual({
      version: '2',
      kind: 'jcs',
      fields: ['to', 'cc', 'subject', 'body'],
    });
    expect(sent).not.toHaveProperty('boundContent');
  });

  it('leaks no content under the binding keys, even though the proposal itself travels', async () => {
    // The review path deliberately echoes `toolArgs` — the AS already stored
    // them at submitProposal time (it rendered the approval card from them) and
    // re-checks them for PROPOSAL_MISMATCH. So the "nothing plaintext on the
    // wire" assertion that holds for the automatic path cannot hold here. What
    // must still hold: the binding contributes NO content of its own, so the
    // only content the AS sees is the proposal it was already given.
    const { state, postReceipt } = buildState();
    const { integrationManager } = buildIntegrationManager();

    await executeCommitted(PROPOSAL, state, integrationManager);

    const sent = postReceipt.mock.calls[0][0] as Record<string, unknown>;
    const withoutProposal = { ...sent };
    delete withoutProposal.toolArgs;
    delete withoutProposal.proposalId;
    const body = JSON.stringify(withoutProposal);
    for (const secret of SECRETS) expect(body).not.toContain(secret);
  });
});
