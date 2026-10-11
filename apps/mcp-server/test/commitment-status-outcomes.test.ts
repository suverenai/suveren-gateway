/**
 * check-pending-commitments — RJ3's three outcome texts under
 * `status: 'rejected'` (2026-10-11 "Reject or ask for a change" brief,
 * decisions 1-2). commitment-status.test.ts already pins the per-STATUS
 * distinction (pending/executed/rejected/expired/unknown); this file pins
 * the per-OUTCOME distinction inside 'rejected' — exact wording, the
 * `<who>` display-name lookup, and the legacy on-disk default.
 */
import { describe, it, expect, vi } from 'vitest';
import { checkPendingCommitmentsHandler } from '../src/tools/commitments';
import type { SharedState } from '../src/lib/shared-state';
import type { SPProposal } from '../src/lib/sp-client';
import { buildScenario } from './report/fixtures/scenario';

const BASE: SPProposal = {
  id: 'p1',
  authorizationId: 'authz_1',
  profileId: 'email@0.5',
  path: 'email@0.5',
  pendingDomains: [],
  committedBy: {},
  rejectedBy: null,
  tool: 'gmail__send_message',
  toolArgs: {},
  executionContext: {},
  status: 'rejected',
  executionResult: null,
  createdAt: 0,
  expiresAt: 0,
};

function handlerFor(proposal: SPProposal, archive?: unknown) {
  const state = {
    spClient: {
      isUnlocked: () => true,
      getProposalById: vi.fn().mockResolvedValue(proposal),
      getCommittedProposals: vi.fn().mockResolvedValue([]),
    },
    ...(archive ? { receiptArchive: archive } : {}),
  } as unknown as SharedState;
  return checkPendingCommitmentsHandler(state);
}

const textOf = async (proposal: SPProposal, archive?: unknown) => {
  const res = await handlerFor(proposal, archive)({ proposal_id: proposal.id });
  return (res.content[0] as { text: string }).text;
};

describe('rejected — domain-owner path', () => {
  it('no outcome on the row at all (legacy, pre-RJ1) reads as a plain REJECTED', async () => {
    const text = await textOf({ ...BASE, rejectedBy: { domain: 'owner', userId: 'andreas', at: 0 } });
    expect(text).toMatch(/^Proposal p1 was REJECTED by andreas\. The action did not run and must not be retried\. Ask the person before proposing anything similar\.$/);
  });

  it('outcome: rejected, no note — exact wording', async () => {
    const text = await textOf({ ...BASE, rejectedBy: { domain: 'owner', userId: 'andreas', at: 0, outcome: 'rejected' } });
    expect(text).toBe(
      'Proposal p1 was REJECTED by andreas. The action did not run and must not be retried. ' +
      'Ask the person before proposing anything similar.',
    );
  });

  it('outcome: change_needed — exact wording, note quoted', async () => {
    const text = await textOf({
      ...BASE,
      rejectedBy: { domain: 'owner', userId: 'andreas', at: 0, outcome: 'change_needed', note: 'Lower the discount' },
    });
    expect(text).toBe(
      'Proposal p1 was SENT BACK FOR A CHANGE by andreas: "Lower the discount". The action did not run. ' +
      'You may adjust it and propose again — a new proposal the person approves again. Do not resend the same values.',
    );
  });

  it('outcome: replaced — exact wording, never names who', async () => {
    const text = await textOf({
      ...BASE,
      rejectedBy: { domain: 'owner', userId: 'andreas', at: 0, outcome: 'replaced' },
    });
    expect(text).toBe(
      "Proposal p1 was REPLACED: the person signed their own version of this mandate on the mandate screen. " +
      'Nothing was created from this proposal. Use the person\'s mandate — check list-authorizations.',
    );
    expect(text).not.toContain('andreas');
  });
});

describe('rejected — above-cap approver path', () => {
  it('a legacy reason (no outcome, no note) still shows as REJECTED with the reason quoted', async () => {
    const text = await textOf({
      ...BASE,
      approverRejectedBy: { userId: 'andreas', reason: 'wrong recipient', at: 0 },
    });
    expect(text).toBe(
      'Proposal p1 was REJECTED by andreas: "wrong recipient". The action did not run and must not be retried. ' +
      'Ask the person before proposing anything similar.',
    );
  });

  it('outcome: change_needed from an approver — same wording as the domain-owner path', async () => {
    const text = await textOf({
      ...BASE,
      approverRejectedBy: { userId: 'andreas', at: 0, outcome: 'change_needed', note: 'Different wording' },
    });
    expect(text).toContain('SENT BACK FOR A CHANGE by andreas: "Different wording"');
  });

  it('outcome: replaced from "Edit before signing" (RJ5) — no reason, no note needed', async () => {
    const text = await textOf({
      ...BASE,
      approverRejectedBy: { userId: 'andreas', at: 0, outcome: 'replaced' },
    });
    expect(text).toContain('REPLACED: the person signed their own version of this mandate');
  });
});

describe('<who> — display name if known locally, else the user id', () => {
  it('falls back to the user id with no receipt archive at all (today\'s behaviour)', async () => {
    const text = await textOf({ ...BASE, rejectedBy: { domain: 'owner', userId: 'andreas', at: 0 } });
    expect(text).toContain('by andreas.');
  });

  it('falls back to the user id when the archive has no verified name for this domain', async () => {
    const { archive } = buildScenario();
    const text = await textOf(
      { ...BASE, rejectedBy: { domain: 'owner', userId: 'andreas', at: 0 } },
      archive,
    );
    expect(text).toContain('by andreas.');
  });

  it('uses the disclosed name when a verified archived mandate links this domain to it', async () => {
    const { archive, addTicket } = buildScenario();
    const OWNER = 'did:key:z6MkRJ3Owner';
    addTicket({
      id: 't1',
      action: 'email__send_message',
      authorizationId: 'authz_1',
      authorization: {
        authorizationId: 'authz_1',
        profileId: 'email@0.5',
        owners: [OWNER],
        domain: 'owner',
        subjects: [{ did: OWNER, assurance: 'high', method: 'as_vouched', trust_root: 'as', verifier: 'did:web:as.example', disclose: { name: 'Lena Gruber' } }],
      },
    });
    const text = await textOf(
      { ...BASE, rejectedBy: { domain: 'owner', userId: 'andreas', at: 0 } },
      archive,
    );
    expect(text).toContain('by Lena Gruber.');
    expect(text).not.toContain('andreas');
  });
});
