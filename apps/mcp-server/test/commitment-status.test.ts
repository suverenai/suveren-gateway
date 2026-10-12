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
    // No locally known name → "the person", never the internal user id.
    expect(text).toContain('by the person');
    expect(text).not.toContain('andreas');
    expect(text).toContain('wrong recipient');
    expect(text).toMatch(/must not be retried/i);
  });

  it('EXPIRED says it never ran, and re-submitting is allowed', async () => {
    const text = await textOf({ ...BASE, status: 'expired' });
    expect(text).toMatch(/EXPIRED/);
    expect(text).toMatch(/never ran/i);
    expect(text).toMatch(/re-submit/i);
  });

  // 2026-10-12 fix — live bug (demo gateway log): "Auto-exec proposal
  // 4a0de6460d47: SP rejected receipt — Cumulative daily count (3) exceeds
  // setup_daily_max=2", then this same tool told the agent the proposal
  // "was approved and has already been EXECUTED ... the gateway did not
  // retain its output" — though nothing ran. The Authority Server now marks
  // such a proposal `refused` (never `executed`) and carries why in
  // `refusal`; this reads that straight off the AS, no local lookup.
  it('REFUSED says the Authority Server refused the ticket, with its own reason, and never says EXECUTED', async () => {
    const text = await textOf({
      ...BASE,
      status: 'refused',
      refusal: { code: 'CUMULATIVE_LIMIT_EXCEEDED', message: 'Cumulative daily count (3) exceeds setup_daily_max=2', at: 0 },
    });
    expect(text).toMatch(/Authority Server refused/i);
    expect(text).toContain('Cumulative daily count (3) exceeds setup_daily_max=2');
    expect(text).toMatch(/nothing ran/i);
    expect(text).toMatch(/do not retry/i);
    expect(text).not.toMatch(/EXECUTED/);
  });

  it('REFUSED with no refusal field recorded still says refused, not EXECUTED', async () => {
    const text = await textOf({ ...BASE, status: 'refused' });
    expect(text).toMatch(/Authority Server refused/i);
    expect(text).not.toMatch(/EXECUTED/);
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
      textOf({ ...BASE, status: 'refused' }),
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
      { ...BASE, status: 'refused' as const },
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

/**
 * The AS marks a proposal "executed" when it issues the ticket — before the
 * action runs. Found on the real stack (CRM revisions, 2026-10-10): the CRM
 * refused the approved action, yet asking about the proposal answered
 * "approved and has already been EXECUTED". The gateway's own execution
 * journal knows what really happened; this answer must follow it.
 */
describe('EXECUTED on the AS but refused by the connector here', () => {
  function handlerWithJournal(entry: { state: 'intent' | 'done' | 'failed'; outcome?: 'refused'; tool?: string } | undefined) {
    const state = {
      spClient: {
        isUnlocked: () => true,
        getProposalById: vi.fn().mockResolvedValue({ ...BASE, status: 'executed', executionResult: null, tool: 'erp__send_quote' }),
        getCommittedProposals: vi.fn().mockResolvedValue([]),
      },
      executionJournal: {
        findByProposal: vi.fn().mockReturnValue(entry && { ticketId: 't-1', proposalId: BASE.id, tool: entry.tool ?? 'erp__send_quote', argsHash: 'h', state: entry.state, outcome: entry.outcome, startedAt: 0, pid: 1 }),
      },
    } as unknown as SharedState;
    return checkPendingCommitmentsHandler(state);
  }

  it('a refused run is reported as refused — nothing was done — never EXECUTED', async () => {
    const res = await handlerWithJournal({ state: 'failed', outcome: 'refused' })({ proposal_id: BASE.id });
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toMatch(/EXECUTED/);
    expect(text).toMatch(/refused/i);
    expect(text).toMatch(/nothing was done/i);
    expect(res.isError).toBe(true);
  });

  it('a run that failed is reported as failed, never EXECUTED', async () => {
    const res = await handlerWithJournal({ state: 'failed' })({ proposal_id: BASE.id });
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toMatch(/EXECUTED/);
    expect(text).toMatch(/failed/i);
  });

  it('a run still in progress says the outcome is not known yet', async () => {
    const res = await handlerWithJournal({ state: 'intent' })({ proposal_id: BASE.id });
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toMatch(/EXECUTED/);
    expect(text).toMatch(/not known/i);
  });

  it('a completed run is still EXECUTED', async () => {
    const res = await handlerWithJournal({ state: 'done' })({ proposal_id: BASE.id });
    expect((res.content[0] as { text: string }).text).toMatch(/EXECUTED/);
  });
});

/**
 * 2026-10-12 fix, deploy-window/compat case: an Authority Server that has
 * NOT yet deployed its own fix still (incorrectly) reports `status:
 * 'executed'` after refusing a bound — same old bug, from the AS's side.
 * This gateway's own `commitments.ts` catch block journals that refusal
 * locally (keyed by proposalId — there is no ticket), under outcome
 * 'as_refused', so a LATER check-pending-commitments(proposal_id) call still
 * tells the truth instead of repeating the AS's stale "EXECUTED".
 */
describe('EXECUTED on the AS, but this gateway itself journaled an AS refusal (pre-fix AS compat)', () => {
  function handlerWithAsRefusedJournal(detail?: string) {
    const state = {
      spClient: {
        isUnlocked: () => true,
        getProposalById: vi.fn().mockResolvedValue({ ...BASE, status: 'executed', executionResult: null, tool: 'erp__send_quote' }),
        getCommittedProposals: vi.fn().mockResolvedValue([]),
      },
      executionJournal: {
        findByProposal: vi.fn().mockReturnValue({
          ticketId: `as_refused:${BASE.id}`,
          proposalId: BASE.id,
          tool: 'erp__send_quote',
          argsHash: 'h',
          state: 'failed',
          outcome: 'as_refused',
          detail,
          startedAt: 0,
          pid: 1,
        }),
      },
    } as unknown as SharedState;
    return checkPendingCommitmentsHandler(state);
  }

  it('says the Authority Server refused the ticket — never EXECUTED, never the connector-refused wording', async () => {
    const res = await handlerWithAsRefusedJournal('CUMULATIVE_LIMIT_EXCEEDED: over the cap')({ proposal_id: BASE.id });
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toMatch(/EXECUTED/);
    expect(text).toMatch(/Authority Server refused/i);
    expect(text).toMatch(/nothing ran/i);
    expect(text).not.toMatch(/erp refused to run it/i);
    expect(res.isError).toBe(true);
  });
});
