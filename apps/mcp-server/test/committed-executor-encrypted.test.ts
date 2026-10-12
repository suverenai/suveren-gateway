/**
 * executeCommitted × encrypted proposal content (PE1).
 *
 * Same executor, same journal, same submission-record cross-check as
 * committed-executor.test.ts — this file only varies the proposal's shape:
 * `content` (sealed) instead of `toolArgs` (plain). Decryption itself is
 * mocked (it round-trips through the control plane); what is under test is
 * that the executor decrypts BEFORE the submission-record mismatch check,
 * the content binding, the tool call, and the journal's argsHash all agree
 * on the SAME resolved toolArgs — and that a ticket request for a review-
 * mode proposal carries `proposalContentHash`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from '@hap/core';
import { ExecutionJournal, hashToolArgs } from '../src/lib/execution-journal';
import { executeCommitted } from '../src/tools/commitments';
import { computeProposalContentHash } from '../src/lib/proposal-content';
import type { SharedState } from '../src/lib/shared-state';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import type { SPProposal } from '../src/lib/sp-client';
import { testReceiptKeypair, makeSignedReceipt } from './helpers/real-receipt';

const cpDecryptContentMock = vi.fn();
vi.mock('../src/lib/cp-content-client', () => ({
  cpDecryptContent: (...args: unknown[]) => cpDecryptContentMock(...args),
}));

const TOOL_ARGS = { repo: 'o/r', commit: 'abc' };
const CONTENT_HASH = computeProposalContentHash(TOOL_ARGS);

const PROPOSAL: SPProposal = {
  id: 'prop-enc-1',
  authorizationId: 'authz_1',
  profileId: 'test-deploy@1', // unregistered on purpose — no content binding applies
  path: 'deploy@0.9',
  pendingDomains: [],
  committedBy: { owner: { userId: 'andreas', at: 0 } },
  rejectedBy: null,
  tool: 'deploy-github__release',
  content: { v: 1, alg: 'HPKE-X25519-HKDF-SHA256-AES256GCM', ciphertext: 'ct', keys: { andreas: { ct: 'a', enc: 'b' } }, hash: CONTENT_HASH },
  contentHash: CONTENT_HASH,
  executionContext: { action_type: 'release' },
  status: 'committed',
  executionResult: null,
  createdAt: 0,
  expiresAt: 0,
};

const TOOL: DiscoveredTool = {
  originalName: 'release',
  namespacedName: 'deploy-github__release',
  integrationId: 'deploy-github',
  description: '',
  inputSchema: { type: 'object', properties: {} },
  gating: { profile: 'deploy', executionMapping: {}, staticExecution: {} } as unknown as DiscoveredTool['gating'],
};

const kp = testReceiptKeypair();
function receiptFor(id: string): Record<string, unknown> {
  return makeSignedReceipt(kp, {
    id,
    action: PROPOSAL.tool,
    executionContext: PROPOSAL.executionContext,
    authorizationId: PROPOSAL.authorizationId,
    profileId: PROPOSAL.profileId,
    proposalId: PROPOSAL.id,
  });
}

function buildState(dir: string, postReceipt: ReturnType<typeof vi.fn>) {
  const record = vi.fn();
  const state = {
    spClient: { postReceipt },
    cache: { getAllAuthorizations: () => [], getPublicKey: async () => kp.publicKeyHex, getTrustedIssuer: async () => kp.issuer },
    // The local submission record holds the hash of the toolArgs this
    // gateway itself submitted BEFORE encryption — exactly the decrypted
    // value the executor must resolve back to.
    proposalSubmissions: {
      get: () => ({
        proposalId: PROPOSAL.id,
        tool: PROPOSAL.tool,
        toolArgsHash: hashToolArgs(TOOL_ARGS),
        executionContextHash: hashToolArgs(PROPOSAL.executionContext),
        authorizationId: PROPOSAL.authorizationId,
        profileId: PROPOSAL.profileId,
        submittedAt: Math.floor(Date.now() / 1000),
      }),
      record: vi.fn(),
    },
    executionLog: { record },
    executionJournal: new ExecutionJournal(dir),
    archiveReceipt: vi.fn().mockResolvedValue(undefined),
  } as unknown as SharedState;
  return { state, record };
}

function buildIntegrationManager() {
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'dispatched' }] });
  const im = { getAllTools: () => [TOOL], callTool } as unknown as IntegrationManager;
  return { im, callTool };
}

describe('executeCommitted — encrypted proposal content', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hap-exec-enc-'));
    cpDecryptContentMock.mockReset();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('decrypts, matches the local submission record, executes with the decrypted args, and sends proposal_content_hash', async () => {
    cpDecryptContentMock.mockResolvedValue(canonicalize(TOOL_ARGS));
    const postReceipt = vi.fn().mockResolvedValue({ receipt: receiptFor('rcpt-enc-1'), idempotent: false });
    const { state, record } = buildState(dir, postReceipt);
    const { im, callTool } = buildIntegrationManager();

    const result = await executeCommitted(PROPOSAL, state, im);

    expect(result.isError).toBeUndefined();
    expect(cpDecryptContentMock).toHaveBeenCalledWith(PROPOSAL.content);
    expect(callTool).toHaveBeenCalledWith('deploy-github', 'release', expect.objectContaining(TOOL_ARGS));
    expect(record).toHaveBeenCalledOnce();

    const sentToPostReceipt = postReceipt.mock.calls[0][0];
    expect(sentToPostReceipt.proposalContentHash).toBe(CONTENT_HASH);
    expect(sentToPostReceipt.toolArgs).toEqual(TOOL_ARGS);
  });

  it('refuses, and never calls the tool, when this device cannot decrypt the content', async () => {
    cpDecryptContentMock.mockRejectedValue(new Error('No key wrap for this account in this content.'));
    const postReceipt = vi.fn();
    const { state } = buildState(dir, postReceipt);
    const { im, callTool } = buildIntegrationManager();

    const result = await executeCommitted(PROPOSAL, state, im);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/could not (be )?decrypt/i);
    expect(postReceipt).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('refuses when the decrypted content does not match the proposal\'s own fingerprint', async () => {
    // A compromised/buggy AS swapped the ciphertext for different content.
    cpDecryptContentMock.mockResolvedValue(canonicalize({ repo: 'tampered/repo', commit: 'xyz' }));
    const postReceipt = vi.fn();
    const { state } = buildState(dir, postReceipt);
    const { im, callTool } = buildIntegrationManager();

    const result = await executeCommitted(PROPOSAL, state, im);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/fingerprint/i);
    expect(postReceipt).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });
});
