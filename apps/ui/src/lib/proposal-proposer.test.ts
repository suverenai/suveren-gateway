import { describe, it, expect } from 'vitest';
import { isProposer, visibleApprovers } from './proposal-proposer';
import type { Proposal } from './sp-client';

// Real-gateway e2e (2026-10-15) shapes — a hap-e2e test harness provisions
// accounts as `<name>-<uuid>@test.local`; this is the REAL id format the
// AS and gateway exchange, not a hand-built "tom"/"lisa" ideal record.
const TOM = 'tom-fecb81a6-9e2d-4a11-8f3c-2b9b1a7c4e10@test.local';
const LISA = 'lisa-7a3f2c91-1b4d-4e9a-9c0e-5f6a8d2b3c71@test.local';
const ANDREAS = 'andreas-0c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f@test.local';

describe('isProposer', () => {
  it('true when createdBy matches the current user — real email-shaped ids', () => {
    const proposal = { createdBy: TOM } as Pick<Proposal, 'createdBy'>;
    expect(isProposer(proposal, TOM)).toBe(true);
  });

  it('false when createdBy is a different user', () => {
    const proposal = { createdBy: TOM } as Pick<Proposal, 'createdBy'>;
    expect(isProposer(proposal, LISA)).toBe(false);
  });

  it('false when createdBy is absent (an older proposal, or one without the field) — never guess "you"', () => {
    const proposal = { createdBy: undefined } as Pick<Proposal, 'createdBy'>;
    expect(isProposer(proposal, TOM)).toBe(false);
  });

  it('false when currentUserId is not yet known', () => {
    const proposal = { createdBy: TOM } as Pick<Proposal, 'createdBy'>;
    expect(isProposer(proposal, undefined)).toBe(false);
  });
});

describe('visibleApprovers', () => {
  it('the real reported bug: pendingApprovers lists the proposer (Tom) alongside Lisa and ' +
    'Andreas — the card must never render him in the roster', () => {
    const proposal = {
      createdBy: TOM,
      pendingApprovers: [TOM, LISA, ANDREAS],
    } as Pick<Proposal, 'pendingApprovers' | 'createdBy'>;
    expect(visibleApprovers(proposal)).toEqual([LISA, ANDREAS]);
  });

  it('a roster that already excludes the proposer (a fixed gateway) is unchanged', () => {
    const proposal = {
      createdBy: TOM,
      pendingApprovers: [LISA, ANDREAS],
    } as Pick<Proposal, 'pendingApprovers' | 'createdBy'>;
    expect(visibleApprovers(proposal)).toEqual([LISA, ANDREAS]);
  });

  it('no pendingApprovers at all: empty, not a crash', () => {
    const proposal = { createdBy: TOM, pendingApprovers: undefined } as Pick<Proposal, 'pendingApprovers' | 'createdBy'>;
    expect(visibleApprovers(proposal)).toEqual([]);
  });

  it('no createdBy at all: nothing is filtered (undefined never matches a real userId)', () => {
    const proposal = { createdBy: undefined, pendingApprovers: [LISA, ANDREAS] } as Pick<Proposal, 'pendingApprovers' | 'createdBy'>;
    expect(visibleApprovers(proposal)).toEqual([LISA, ANDREAS]);
  });
});
