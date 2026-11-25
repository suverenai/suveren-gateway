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
    expect(text).toMatch(/^Proposal p1 was REJECTED by the person\. The action did not run and must not be retried\. Ask the person before proposing anything similar\.$/);
  });

  it('outcome: rejected, no note — exact wording', async () => {
    const text = await textOf({ ...BASE, rejectedBy: { domain: 'owner', userId: 'andreas', at: 0, outcome: 'rejected' } });
    expect(text).toBe(
      'Proposal p1 was REJECTED by the person. The action did not run and must not be retried. ' +
      'Ask the person before proposing anything similar.',
    );
  });

  it('outcome: change_needed — exact wording, note quoted', async () => {
    const text = await textOf({
      ...BASE,
      rejectedBy: { domain: 'owner', userId: 'andreas', at: 0, outcome: 'change_needed', note: 'Lower the discount' },
    });
    expect(text).toBe(
      'Proposal p1 was SENT BACK FOR A CHANGE by the person: "Lower the discount". The action did not run. ' +
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

describe('replaced — an AI-proposed mandate or change the person GAVE (on the card or the phone)', () => {
  const asked: string[] = [];
  const withGateway = async (answer: unknown, proposal: SPProposal) => {
    const prevSecret = process.env.SUVEREN_INTERNAL_SECRET;
    process.env.SUVEREN_INTERNAL_SECRET = 'sekret';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { asked.push(String(url)); return new Response(JSON.stringify(answer), { status: 200 }); }));
    try { return await textOf(proposal); } finally { vi.unstubAllGlobals(); if (prevSecret === undefined) delete process.env.SUVEREN_INTERNAL_SECRET; else process.env.SUVEREN_INTERNAL_SECRET = prevSecret; }
  };
  const change = { ...BASE, tool: 'setup__change_mandate', rejectedBy: { domain: 'owner', userId: 'andreas', at: 0, outcome: 'replaced' } } as SPProposal;

  it('given: the AI hears that ITS change is in force, with the new mandate id (dev lane 2026-11-23 said "their own version")', async () => {
    const text = await withGateway({ given: { authorizationId: 'authz_new', op: 'change' } }, change);
    expect(text).toBe('Proposal p1 was GIVEN: the person gave the change you proposed with their touch, exactly as proposed. It is in force now as authz_new. Check list-authorizations before you use it.');
    expect(asked.at(-1)).toContain('/internal/mandate/given/p1');
    expect(text).not.toContain('own version');
  });

  it('given on the phone, not yet in force: it comes in a moment', async () => {
    const text = await withGateway({ waiting: true }, { ...change, tool: 'setup__create_mandate' } as SPProposal);
    expect(text).toContain("was GIVEN on the person's phone: the mandate you proposed comes into force in a moment");
  });

  it('the gateway knows nothing of a give (Edit before signing, or a restart): the replaced line as before', async () => {
    const text = await withGateway({}, change);
    expect(text).toContain('REPLACED: the person signed their own version of this mandate');
  });
});

describe('rejected — above-cap approver path', () => {
  it('a legacy reason (no outcome, no note) still shows as REJECTED with the reason quoted', async () => {
    const text = await textOf({
      ...BASE,
      approverRejectedBy: { userId: 'andreas', reason: 'wrong recipient', at: 0 },
    });
    expect(text).toBe(
      'Proposal p1 was REJECTED by the person: "wrong recipient". The action did not run and must not be retried. ' +
      'Ask the person before proposing anything similar.',
    );
  });

  it('outcome: change_needed from an approver — same wording as the domain-owner path', async () => {
    const text = await textOf({
      ...BASE,
      approverRejectedBy: { userId: 'andreas', at: 0, outcome: 'change_needed', note: 'Different wording' },
    });
    expect(text).toContain('SENT BACK FOR A CHANGE by the person: "Different wording"');
  });

  it('outcome: replaced from "Edit before signing" (RJ5) — no reason, no note needed', async () => {
    const text = await textOf({
      ...BASE,
      approverRejectedBy: { userId: 'andreas', at: 0, outcome: 'replaced' },
    });
    expect(text).toContain('REPLACED: the person signed their own version of this mandate');
  });
});

describe('<who> — display name if known locally, else "the person" — never the internal user id', () => {
  it('falls back to the user id with no receipt archive at all (today\'s behaviour)', async () => {
    const text = await textOf({ ...BASE, rejectedBy: { domain: 'owner', userId: 'andreas', at: 0 } });
    expect(text).toContain('by the person.');
  });

  it('falls back to the user id when the archive has no verified name for this domain', async () => {
    const { archive } = buildScenario();
    const text = await textOf(
      { ...BASE, rejectedBy: { domain: 'owner', userId: 'andreas', at: 0 } },
      archive,
    );
    expect(text).toContain('by the person.');
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
