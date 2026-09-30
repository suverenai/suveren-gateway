/**
 * check-pending-commitments' LIST view (no proposal_id) must make a
 * committed-but-not-ours proposal visible, with a reason — not just silently
 * omit the fact that nothing will happen to it. See executeCommitted's skip
 * path (commitments.ts) and buildSkippedProposalNote.
 */
import { describe, it, expect, vi } from 'vitest';
import { checkPendingCommitmentsHandler, buildSkippedProposalNote } from '../src/tools/commitments';
import type { SharedState } from '../src/lib/shared-state';
import type { SPProposal } from '../src/lib/sp-client';

function proposal(id: string): SPProposal {
  return {
    id,
    authorizationId: 'authz_1',
    profileId: 'records@0.4',
    path: 'records@0.4',
    pendingDomains: [],
    committedBy: { owner: { userId: 'andreas', at: 0 } },
    rejectedBy: null,
    tool: 'records__create_record',
    toolArgs: {},
    executionContext: {},
    status: 'committed',
    executionResult: null,
    createdAt: 0,
    expiresAt: 0,
  };
}

function handlerFor(committed: SPProposal[], hasLocalRecord: (id: string) => boolean) {
  const state = {
    spClient: {
      isUnlocked: () => true,
      getCommittedProposals: vi.fn().mockResolvedValue(committed),
    },
    proposalSubmissions: {
      get: (id: string) => (hasLocalRecord(id) ? { proposalId: id } : undefined),
    },
  } as unknown as SharedState;
  return checkPendingCommitmentsHandler(state);
}

describe('check-pending-commitments — list view visibility for skipped proposals', () => {
  it('flags a committed proposal with no local submission record', async () => {
    const res = await handlerFor([proposal('prop-not-mine')], () => false)({});
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('prop-not-mine');
    expect(text).toContain('SKIPPED HERE');
    expect(text).toContain(buildSkippedProposalNote('prop-not-mine'));
  });

  it('does NOT flag a committed proposal this gateway did submit', async () => {
    const res = await handlerFor([proposal('prop-mine')], () => true)({});
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('prop-mine');
    expect(text).not.toContain('SKIPPED HERE');
  });

  it('lists a mix correctly, one flagged and one not', async () => {
    const res = await handlerFor(
      [proposal('prop-mine'), proposal('prop-not-mine')],
      (id) => id === 'prop-mine',
    )({});
    const text = (res.content[0] as { text: string }).text;
    expect(text.split('\n').find((l) => l.startsWith('prop-mine'))).not.toContain('SKIPPED HERE');
    expect(text.split('\n').find((l) => l.startsWith('prop-not-mine'))).toContain('SKIPPED HERE');
  });
});
