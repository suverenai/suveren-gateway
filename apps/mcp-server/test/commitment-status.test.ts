/**
 * check-pending-commitments — every proposal state gets its OWN answer.
 *
 * The old handler searched `?status=committed` only, so pending, executed,
 * rejected, expired and a mistyped id all returned "still pending or not
 * found". That is not a wording problem: an agent reads this string and decides
 * whether to wait, retry, or stop. One answer for five states is wrong for four
 * of them, and the specific failure it caused was re-sending an action that had
 * already executed.
 *
 * These tests assert the distinction an agent has to act on, not the prose.
 */
import { describe, it, expect, vi } from 'vitest';
import { checkPendingCommitmentsHandler } from '../src/tools/commitments';
import type { SharedState } from '../src/lib/shared-state';
import type { SPProposal } from '../src/lib/sp-client';

const BASE: SPProposal = {
  id: 'b0ce75dbdcdb',
  authorizationId: 'authz_1',
  profileId: 'email@0.5',
  path: 'email@0.5',
  pendingDomains: ['owner'],
  committedBy: {},
  rejectedBy: null,
  tool: 'gmail__send_message',
  toolArgs: {},
  executionContext: {},
  status: 'pending',
  executionResult: null,
  createdAt: 0,
  expiresAt: 0,
};

function handlerFor(proposal: SPProposal | null) {
  const state = {
    spClient: {
      isUnlocked: () => true,
      getProposalById: vi.fn().mockResolvedValue(proposal),
      getCommittedProposals: vi.fn().mockResolvedValue([]),
    },
  } as unknown as SharedState;
  return checkPendingCommitmentsHandler(state);
}

const textOf = async (proposal: SPProposal | null) => {
  const res = await handlerFor(proposal)({ proposal_id: 'b0ce75dbdcdb' });
  return (res.content[0] as { text: string }).text;
};

describe('a distinct, actionable answer per state', () => {
  it('PENDING says nothing ran, and names who is outstanding', async () => {
    const text = await textOf({ ...BASE, status: 'pending' });
    expect(text).toMatch(/PENDING/);
    expect(text).toMatch(/nothing has run/i);
    expect(text).toMatch(/owner/);            // who we are waiting on
    expect(text).toMatch(/do not re-submit/i);
  });

  it('EXECUTED says it is finished and carries the result', async () => {
    const text = await textOf({
      ...BASE, status: 'executed', executionResult: { id: 'msg-1' },
    });
    expect(text).toMatch(/EXECUTED/);
    expect(text).toMatch(/do not call the tool again/i);
    expect(text).toContain('msg-1');
  });

  it('EXECUTED is still unambiguous when no result was retained', async () => {
    const text = await textOf({ ...BASE, status: 'executed', executionResult: null });
    expect(text).toMatch(/EXECUTED/);
    expect(text).not.toMatch(/pending/i);
  });

  it('REJECTED says a human declined, with the reason', async () => {
    const text = await textOf({
      ...BASE,
      status: 'rejected',
      approverRejectedBy: { userId: 'andreas', reason: 'wrong recipient', at: 0 },
    });
    expect(text).toMatch(/REJECTED/);
    expect(text).toContain('andreas');
    expect(text).toContain('wrong recipient');
    expect(text).toMatch(/must not be retried/i);
  });

  it('EXPIRED says it never ran, and re-submitting is allowed', async () => {
    const text = await textOf({ ...BASE, status: 'expired' });
    expect(text).toMatch(/EXPIRED/);
    expect(text).toMatch(/never ran/i);
    expect(text).toMatch(/re-submit/i);
  });

  it('UNKNOWN id warns against retrying, which would double-propose', async () => {
    const text = await textOf(null);
    expect(text).toMatch(/No proposal with id/i);
    expect(text).toMatch(/Do NOT retry/i);
    expect(text).toMatch(/second one/i);
  });
});

describe('the states cannot be confused with one another', () => {
  it('no two states produce the same answer', async () => {
    const texts = await Promise.all([
      textOf({ ...BASE, status: 'pending' }),
      textOf({ ...BASE, status: 'executed' }),
      textOf({ ...BASE, status: 'rejected' }),
      textOf({ ...BASE, status: 'expired' }),
      textOf(null),
    ]);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('the old catch-all wording is gone from every answer', async () => {
    for (const p of [
      { ...BASE, status: 'pending' as const },
      { ...BASE, status: 'executed' as const },
      { ...BASE, status: 'rejected' as const },
      { ...BASE, status: 'expired' as const },
    ]) {
      expect(await textOf(p)).not.toMatch(/still pending or not found/i);
    }
    expect(await textOf(null)).not.toMatch(/still pending or not found/i);
  });

  it('looks up by id — it must not depend on the committed list', async () => {
    const state = {
      spClient: {
        isUnlocked: () => true,
        getProposalById: vi.fn().mockResolvedValue({ ...BASE, status: 'executed' }),
        getCommittedProposals: vi.fn().mockResolvedValue([]),
      },
    } as unknown as SharedState;
    await checkPendingCommitmentsHandler(state)({ proposal_id: 'b0ce75dbdcdb' });
    expect(state.spClient.getProposalById).toHaveBeenCalledWith('b0ce75dbdcdb');
    expect(state.spClient.getCommittedProposals).not.toHaveBeenCalled();
  });
});
