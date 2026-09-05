/**
 * Review-path / automatic-path parity for the committed-proposal executor.
 *
 * Audit finding: the review-mode receipt request omitted the `boundsHash`
 * cross-check the automatic path sends, and the post-execution footer call
 * omitted the identity subject — so an approved send footered as anonymous
 * even at high assurance. Both are pulled from the cached authorization
 * (keyed by `proposal.authorizationId`), exactly as tool-proxy.ts does for
 * the automatic path.
 */
import { describe, it, expect, vi } from 'vitest';
import { executeCommitted } from '../src/tools/commitments';
import type { SharedState } from '../src/lib/shared-state';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import type { SPProposal } from '../src/lib/sp-client';
import type { Subject } from '@hap/core';

const SUBJECT: Subject = {
  did: 'did:key:a', assurance: 'high', method: 'as_vouched', trust_root: 'as',
  verifier: 'did:web:suveren.ai', disclose: { name: 'Andreas Schadauer' },
};

const PROPOSAL: SPProposal = {
  id: 'prop-1',
  authorizationId: 'authz_1',
  profileId: 'test-email@1', // unregistered on purpose — no content binding applies
  path: 'email@0.5',
  pendingDomains: [],
  committedBy: { owner: { userId: 'andreas', at: 0 } },
  rejectedBy: null,
  tool: 'gmail__send_message',
  toolArgs: { body: 'Hi there', to: 'x@y.com' },
  executionContext: { action_type: 'send' },
  status: 'committed',
  executionResult: null,
  createdAt: 0,
  expiresAt: 0,
};

const TOOL: DiscoveredTool = {
  originalName: 'send_message',
  namespacedName: 'gmail__send_message',
  integrationId: 'gmail',
  description: '',
  inputSchema: { type: 'object', properties: { body: { type: 'string' }, to: { type: 'string' } } },
  gating: { profile: 'email', executionMapping: {}, staticExecution: {} } as unknown as DiscoveredTool['gating'],
};

function buildState(opts: { boundsHash?: string; subjects?: Subject[] }) {
  const postReceipt = vi.fn().mockResolvedValue({ receipt: { id: 'rcpt-1' } });
  const state = {
    spClient: { postReceipt },
    cache: {
      getAllAuthorizations: () => [
        {
          authorizationId: 'authz_1',
          boundsHash: opts.boundsHash,
          subjects: opts.subjects,
          profileId: 'email',
          path: 'email@0.5',
          frame: {},
          attestations: [],
          requiredDomains: [],
          attestedDomains: [],
          deferredCommitmentDomains: [],
          complete: true,
        },
      ],
    },
    executionLog: { record: vi.fn() },
    archiveReceipt: vi.fn().mockResolvedValue(undefined),
    executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
  } as unknown as SharedState;
  return { state, postReceipt };
}

function buildIntegrationManager() {
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  const integrationManager = {
    getAllTools: () => [TOOL],
    callTool,
  } as unknown as IntegrationManager;
  return { integrationManager, callTool };
}

describe('executeCommitted — review path parity with the automatic path', () => {
  it('sends the boundsHash cross-check on the review-path receipt request', async () => {
    const { state, postReceipt } = buildState({ boundsHash: 'hash-abc' });
    const { integrationManager } = buildIntegrationManager();

    await executeCommitted(PROPOSAL, state, integrationManager);

    expect(postReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ boundsHash: 'hash-abc', proposalId: PROPOSAL.id }),
    );
  });

  it('omits boundsHash (undefined) when the cached authorization is gone, but still proceeds', async () => {
    const { state, postReceipt } = buildState({});
    const { integrationManager } = buildIntegrationManager();

    await executeCommitted(PROPOSAL, state, integrationManager);

    expect(postReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ boundsHash: undefined }),
    );
  });

  it('passes the cached authorization subject to the verification footer', async () => {
    const { state } = buildState({ subjects: [SUBJECT] });
    const { integrationManager, callTool } = buildIntegrationManager();

    await executeCommitted(PROPOSAL, state, integrationManager);

    const [, , outgoingArgs] = callTool.mock.calls[0];
    expect((outgoingArgs as { body: string }).body).toContain("Andreas Schadauer's AI agent");
  });

  it('footers as anonymous (no name) when the cached authorization carries no subject', async () => {
    const { state } = buildState({});
    const { integrationManager, callTool } = buildIntegrationManager();

    await executeCommitted(PROPOSAL, state, integrationManager);

    const [, , outgoingArgs] = callTool.mock.calls[0];
    const body = (outgoingArgs as { body: string }).body;
    expect(body).toContain('Sent by an AI agent via Suveren');
    expect(body).not.toContain('AI agent of');
  });

  it('omits idempotencyKey — review-mode commits carry a proposalId instead (spec), which is what enables the retry path', async () => {
    const { state, postReceipt } = buildState({});
    const { integrationManager } = buildIntegrationManager();

    await executeCommitted(PROPOSAL, state, integrationManager);

    const call = postReceipt.mock.calls[0][0] as { idempotencyKey?: string; proposalId?: string };
    expect(call.idempotencyKey).toBeUndefined();
    expect(call.proposalId).toBe(PROPOSAL.id);
  });
});
