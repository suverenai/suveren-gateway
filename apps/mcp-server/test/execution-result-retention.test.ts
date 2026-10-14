/**
 * Live report 2026-10-13 (Mollie `CreatePaymentLink`, review-mode proposal):
 * a LATER check-pending-commitments(proposal_id) call said "approved and has
 * already been EXECUTED ... the gateway did not retain its output" on a
 * SUCCESSFUL execution, and the task flagged that a downstream error could
 * be recorded as success. This file pins the fix end to end, through the
 * real `executeCommitted` / `checkPendingCommitmentsHandler`:
 *
 *   1. A successful execution's result is retained and comes back on a
 *      LATER check — not "the gateway did not retain its output".
 *   2. An `isError: true` result from the downstream tool is FAILED, not
 *      counted locally, and its error text is retained and returned later.
 *   3. A THROWN call is FAILED the same way.
 *   4. Neither failure case calls executionLog.record() (no cumulative
 *      double-count — the Authority Server already reserved the budget at
 *      ticket time; see work-plan.md's AS decision on this).
 *   5. Each outcome fires `notifyControlPlane('execution-failed')` exactly
 *      once on failure, never on success.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionJournal, hashToolArgs } from '../src/lib/execution-journal';
import { ExecutionResultStore } from '../src/lib/execution-result-store';
import { executeCommitted, checkPendingCommitmentsHandler } from '../src/tools/commitments';
import type { SharedState } from '../src/lib/shared-state';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import type { SPProposal } from '../src/lib/sp-client';
import { testReceiptKeypair, makeSignedReceipt } from './helpers/real-receipt';

vi.mock('../src/lib/cp-notify', () => ({ notifyControlPlane: vi.fn().mockResolvedValue(undefined) }));
import { notifyControlPlane } from '../src/lib/cp-notify';

const PROPOSAL: SPProposal = {
  id: 'prop-mollie-1',
  authorizationId: 'authz_1',
  profileId: 'test-charge@1', // unregistered — no content binding applies
  path: 'charge@0.6',
  pendingDomains: [],
  committedBy: { owner: { userId: 'andreas', at: 0 } },
  rejectedBy: null,
  tool: 'mollie__CreatePaymentLink',
  toolArgs: { amount: '0.10', currency: 'EUR', description: 'invoice', reusable: false, testmode: true, profile_id: '' },
  executionContext: { action_type: 'charge', amount: 0.1 },
  status: 'committed',
  executionResult: null,
  createdAt: 0,
  expiresAt: 0,
};

const TOOL: DiscoveredTool = {
  originalName: 'CreatePaymentLink',
  namespacedName: 'mollie__CreatePaymentLink',
  integrationId: 'mollie',
  description: '',
  inputSchema: { type: 'object', properties: {} },
  gating: { profile: 'charge', executionMapping: {}, staticExecution: {} } as unknown as DiscoveredTool['gating'],
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

function buildState(dir: string) {
  const executionLogRecord = vi.fn();
  const postReceipt = vi.fn().mockResolvedValue({ receipt: receiptFor('rcpt-1'), idempotent: false });
  const state = {
    spClient: {
      postReceipt,
      isUnlocked: () => true,
      getProposalById: vi.fn().mockResolvedValue({ ...PROPOSAL, status: 'executed' }),
    },
    cache: { getAllAuthorizations: () => [], getPublicKey: async () => kp.publicKeyHex, getTrustedIssuer: async () => kp.issuer },
    proposalSubmissions: {
      get: () => ({
        proposalId: PROPOSAL.id,
        tool: PROPOSAL.tool,
        toolArgsHash: hashToolArgs(PROPOSAL.toolArgs),
        executionContextHash: hashToolArgs(PROPOSAL.executionContext),
        authorizationId: PROPOSAL.authorizationId,
        profileId: PROPOSAL.profileId,
        submittedAt: Math.floor(Date.now() / 1000),
      }),
      record: vi.fn(),
    },
    executionLog: { record: executionLogRecord },
    executionJournal: new ExecutionJournal(dir),
    executionResults: new ExecutionResultStore(dir),
    archiveReceipt: vi.fn().mockResolvedValue(undefined),
  } as unknown as SharedState;
  return { state, executionLogRecord, postReceipt };
}

function imWith(callTool: ReturnType<typeof vi.fn>) {
  return { getAllTools: () => [TOOL], callTool } as unknown as IntegrationManager;
}

describe('a successful execution retains its result for a LATER check', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'exec-retain-ok-')); vi.clearAllMocks(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('the first call returns the result, and counts it locally', async () => {
    const { state, executionLogRecord } = buildState(dir);
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Payment link created: https://pay.mollie.com/l/abc' }] });
    const r = await executeCommitted(PROPOSAL, state, imWith(callTool));
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('Payment link created');
    expect(executionLogRecord).toHaveBeenCalledOnce();
    expect(notifyControlPlane).not.toHaveBeenCalled();
  });

  it('a LATER check-pending-commitments call returns the SAME result, not "did not retain its output"', async () => {
    const { state } = buildState(dir);
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Payment link created: https://pay.mollie.com/l/abc' }] });
    await executeCommitted(PROPOSAL, state, imWith(callTool));

    const handler = checkPendingCommitmentsHandler(state, imWith(callTool));
    const r = await handler({ proposal_id: PROPOSAL.id });
    const text = (r.content as Array<{ text: string }>)[0].text;

    expect(r.isError).toBeUndefined();
    expect(text).not.toMatch(/did not retain its output/);
    expect(text).toContain('Payment link created: https://pay.mollie.com/l/abc');
  });

  it('retains structuredContent alongside the text, when the connector returned one', async () => {
    const { state } = buildState(dir);
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { id: 'tr_abc123', paymentLinkUrl: 'https://pay.mollie.com/l/abc' },
    });
    await executeCommitted(PROPOSAL, state, imWith(callTool));
    expect(state.executionResults.get(PROPOSAL.id)?.structuredContent).toEqual({
      id: 'tr_abc123', paymentLinkUrl: 'https://pay.mollie.com/l/abc',
    });
  });
});

describe('an isError result from the downstream tool is FAILED, not success', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'exec-retain-iserror-')); vi.clearAllMocks(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('the first call is isError, the journal is "failed", and nothing is counted', async () => {
    const { state, executionLogRecord } = buildState(dir);
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Error: invalid profileId' }],
      isError: true,
    });
    const r = await executeCommitted(PROPOSAL, state, imWith(callTool));

    expect(r.isError).toBe(true);
    expect(r.text).toContain('invalid profileId');
    expect(state.executionJournal.get('rcpt-1')?.state).toBe('failed');
    expect(executionLogRecord).not.toHaveBeenCalled();
  });

  it('raises the doorbell exactly once (execution-failed), never on success', async () => {
    const { state } = buildState(dir);
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Error: invalid profileId' }], isError: true });
    await executeCommitted(PROPOSAL, state, imWith(callTool));
    expect(notifyControlPlane).toHaveBeenCalledOnce();
    expect(notifyControlPlane).toHaveBeenCalledWith('execution-failed');
  });

  it('a LATER check-pending-commitments call never says EXECUTED, and returns the retained error text', async () => {
    const { state } = buildState(dir);
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Error: invalid profileId' }], isError: true });
    await executeCommitted(PROPOSAL, state, imWith(callTool));

    const handler = checkPendingCommitmentsHandler(state, imWith(callTool));
    const r = await handler({ proposal_id: PROPOSAL.id });
    const text = (r.content as Array<{ text: string }>)[0].text;

    expect(r.isError).toBe(true);
    expect(text).not.toMatch(/EXECUTED/);
    expect(text).toMatch(/invalid profileId/);
  });
});

describe('a THROWN call is FAILED the same way as isError', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'exec-retain-thrown-')); vi.clearAllMocks(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('the first call surfaces the failure, journal is "failed", nothing counted', async () => {
    const { state, executionLogRecord } = buildState(dir);
    const callTool = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const r = await executeCommitted(PROPOSAL, state, imWith(callTool));

    expect(r.isError).toBe(true);
    expect(state.executionJournal.get('rcpt-1')?.state).toBe('failed');
    expect(executionLogRecord).not.toHaveBeenCalled();
  });

  it('raises the doorbell exactly once', async () => {
    const { state } = buildState(dir);
    const callTool = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    await executeCommitted(PROPOSAL, state, imWith(callTool));
    expect(notifyControlPlane).toHaveBeenCalledOnce();
    expect(notifyControlPlane).toHaveBeenCalledWith('execution-failed');
  });

  it('a LATER check-pending-commitments call never says EXECUTED', async () => {
    const { state } = buildState(dir);
    const callTool = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    await executeCommitted(PROPOSAL, state, imWith(callTool));

    const handler = checkPendingCommitmentsHandler(state, imWith(callTool));
    const r = await handler({ proposal_id: PROPOSAL.id });
    const text = (r.content as Array<{ text: string }>)[0].text;

    expect(r.isError).toBe(true);
    expect(text).not.toMatch(/EXECUTED/);
  });
});

describe('gateway.log — one line per execution outcome, no content', () => {
  let dir: string;
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exec-log-line-'));
    vi.clearAllMocks();
    spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); spy.mockRestore(); });

  it('logs "execution outcome=ok" on success, with no result content', async () => {
    const { state } = buildState(dir);
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'SECRET-RESULT-TEXT' }] });
    await executeCommitted(PROPOSAL, state, imWith(callTool));
    const lines = spy.mock.calls.map(c => String(c[0]));
    const line = lines.find(l => l.includes('execution outcome='));
    expect(line).toContain('execution outcome=ok');
    expect(line).not.toContain('SECRET-RESULT-TEXT');
  });

  it('logs "execution outcome=error (...)" on failure, with no connector error text', async () => {
    const { state } = buildState(dir);
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'SECRET-ERROR-DETAIL' }], isError: true });
    await executeCommitted(PROPOSAL, state, imWith(callTool));
    const lines = spy.mock.calls.map(c => String(c[0]));
    const line = lines.find(l => l.includes('execution outcome='));
    expect(line).toContain('execution outcome=error');
    expect(line).not.toContain('SECRET-ERROR-DETAIL');
  });
});
