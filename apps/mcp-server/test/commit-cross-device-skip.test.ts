/**
 * A committed proposal this gateway did not itself submit must be SKIPPED,
 * not treated as an attack.
 *
 * A genuine Authority Server legitimately lists every committed proposal for
 * the operator, no matter which of their gateways submitted it — the same
 * person's laptop and desktop both poll the same list. Refusing-and-locking
 * on "no local record" would fire on that completely ordinary case every
 * time: a false alarm that locks the SECOND gateway on every poll tick.
 *
 * Modeled here with two REAL, separate ProposalSubmissionStore instances
 * (one per data dir) standing in for gateway A (the submitter) and gateway B
 * (which only polls) — not a mock of the store itself.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCommitted } from '../src/tools/commitments';
import { ProposalSubmissionStore } from '../src/lib/proposal-submission-store';
import type { SharedState } from '../src/lib/shared-state';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import type { SPProposal } from '../src/lib/sp-client';
import { testReceiptKeypair, makeSignedReceipt } from './helpers/real-receipt';

vi.mock('../src/lib/cp-notify', () => ({ notifyControlPlane: vi.fn() }));
import { notifyControlPlane } from '../src/lib/cp-notify';

const PROPOSAL: SPProposal = {
  id: 'prop-cross-device-1',
  authorizationId: 'authz_1',
  profileId: 'test-records@1',
  path: 'records@0.4',
  pendingDomains: [],
  committedBy: { owner: { userId: 'andreas', at: 0 } },
  rejectedBy: null,
  tool: 'records__create_record',
  toolArgs: { type: 'note', title: 'from gateway A', content: 'x' },
  executionContext: { action_type: 'write' },
  status: 'committed',
  executionResult: null,
  createdAt: 0,
  expiresAt: 0,
};

const TOOL: DiscoveredTool = {
  originalName: 'create_record',
  namespacedName: 'records__create_record',
  integrationId: 'records',
  description: '',
  inputSchema: { type: 'object', properties: {} },
  gating: { profile: 'records', executionMapping: {}, staticExecution: {} } as unknown as DiscoveredTool['gating'],
};

const dirs: string[] = [];
function tmpDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'hap-cross-device-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('executeCommitted — a proposal submitted by a DIFFERENT gateway (same operator)', () => {
  it('is skipped, not executed and not locked — normal multi-device operation, not an attack', async () => {
    // Gateway A submitted this proposal — its OWN data dir has the record.
    const storeA = new ProposalSubmissionStore(tmpDataDir());
    storeA.record({
      proposalId: PROPOSAL.id,
      tool: PROPOSAL.tool,
      toolArgs: PROPOSAL.toolArgs,
      executionContext: PROPOSAL.executionContext,
      authorizationId: PROPOSAL.authorizationId,
      profileId: PROPOSAL.profileId,
    });
    expect(storeA.get(PROPOSAL.id)).toBeDefined();

    // Gateway B (a different device, SEPARATE data dir) polls the same AS
    // and sees the SAME committed proposal — but never submitted it itself.
    const storeB = new ProposalSubmissionStore(tmpDataDir());
    expect(storeB.get(PROPOSAL.id), 'test setup: B must have no record of A\'s proposal').toBeUndefined();

    const kp = testReceiptKeypair();
    const postReceipt = vi.fn().mockImplementation(async (req: { action: string; executionContext?: Record<string, unknown> }) => ({
      receipt: makeSignedReceipt(kp, { id: 'rcpt-x', action: req.action, executionContext: req.executionContext ?? {} }),
    }));
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ran' }] });
    const im = { getAllTools: () => [TOOL], callTool } as unknown as IntegrationManager;

    const state = {
      spClient: { postReceipt },
      cache: { getAllAuthorizations: () => [], getPublicKey: async () => kp.publicKeyHex },
      proposalSubmissions: storeB, // gateway B's own store — the real class, not a stub
      executionLog: { record: vi.fn() },
      executionJournal: { begin: vi.fn(() => ({ ok: true })), complete: vi.fn() },
      archiveReceipt: vi.fn().mockResolvedValue(undefined),
    } as unknown as SharedState;

    const result = await executeCommitted(PROPOSAL, state, im);

    // Skipped: no error, no execution, no receipt requested (nothing marked
    // executed OR failed on the AS), and — the correction this test pins —
    // NOT locked. A different device of the same operator polling the same
    // list must never trip the AS-key-mismatch lock.
    expect(result.isError).toBeFalsy();
    expect(callTool).not.toHaveBeenCalled();
    expect(postReceipt, 'requested a ticket for a proposal this gateway never submitted').not.toHaveBeenCalled();
    expect(notifyControlPlane, 'locked the gateway over another device\'s legitimate proposal').not.toHaveBeenCalled();
    expect((state.executionJournal.begin as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('an impostor-injected proposal (no record on ANY real gateway) is skipped the same way, not executed', async () => {
    // No gateway anywhere submitted this — same as B's case above, just named
    // for what it stands in for (see hap-e2e's as-impostor-relay suite for
    // the full end-to-end version with a real AS + a real relay).
    const injected: SPProposal = { ...PROPOSAL, id: 'prop-injected-by-impostor', toolArgs: { type: 'note', title: 'injected', content: 'x' } };
    const store = new ProposalSubmissionStore(tmpDataDir());
    const kp = testReceiptKeypair();
    const postReceipt = vi.fn();
    const callTool = vi.fn();
    const im = { getAllTools: () => [TOOL], callTool } as unknown as IntegrationManager;
    const state = {
      spClient: { postReceipt },
      cache: { getAllAuthorizations: () => [], getPublicKey: async () => kp.publicKeyHex },
      proposalSubmissions: store,
      executionLog: { record: vi.fn() },
      executionJournal: { begin: vi.fn(() => ({ ok: true })), complete: vi.fn() },
      archiveReceipt: vi.fn().mockResolvedValue(undefined),
    } as unknown as SharedState;

    const result = await executeCommitted(injected, state, im);

    expect(result.isError).toBeFalsy();
    expect(callTool, 'the injected proposal ran').not.toHaveBeenCalled();
    expect(postReceipt, 'requested a ticket for an injected proposal').not.toHaveBeenCalled();
  });
});
