import { describe, it, expect } from 'vitest';
import { aggregateThread } from './thread-aggregator';
import type { Proposal, ExecutionReceipt } from './sp-client';

function proposal(overrides: Partial<Proposal>): Proposal {
  return {
    id: 'p-' + Math.random().toString(36).slice(2, 8),
    authorizationId: 'f1',
    profileId: 'publish@0.4',
    path: 'owner',
    pendingDomains: ['owner'],
    committedBy: {},
    rejectedBy: null,
    tool: 'linkedin__create_post',
    toolArgs: {},
    executionContext: {},
    status: 'pending',
    executionResult: null,
    createdAt: 1000,
    expiresAt: 2000,
    ...overrides,
  };
}

function receipt(overrides: Partial<ExecutionReceipt> & { proposalId?: string }): ExecutionReceipt {
  const base: ExecutionReceipt = {
    id: 'r-' + Math.random().toString(36).slice(2, 8),
    groupId: 'g1',
    userId: 'u1',
    attestationHash: 'f1',
    profileId: 'publish@0.4',
    path: 'owner',
    action: 'linkedin__create_post',
    executionContext: {},
    cumulativeState: { daily: { amount: 0, count: 0 }, monthly: { amount: 0, count: 0 } },
    timestamp: 1000,
    signature: 'sig',
  };
  return { ...base, ...overrides };
}

describe('aggregateThread', () => {
  it('defaults to pending-only and excludes receipts entirely', () => {
    const out = aggregateThread(
      [
        proposal({ id: 'a', status: 'pending', createdAt: 10 }),
        proposal({ id: 'b', status: 'executed', createdAt: 20 }),
        proposal({ id: 'c', status: 'rejected', createdAt: 30 }),
      ],
      [receipt({ id: 'r1', timestamp: 40, proposalId: 'b' })],
    );
    expect(out.map((i) => i.id)).toEqual(['a']);
  });

  it('returns merged + sorted desc when status=all', () => {
    const out = aggregateThread(
      [
        proposal({ id: 'a', status: 'pending', createdAt: 10 }),
        proposal({ id: 'b', status: 'executed', createdAt: 30 }),
      ],
      [receipt({ id: 'r1', timestamp: 20, proposalId: 'b' })],
      { status: 'all' },
    );
    expect(out.map((i) => i.id)).toEqual(['b', 'r1', 'a']);
  });

  it('excludes autonomous receipts by default when status=all', () => {
    const out = aggregateThread(
      [],
      [
        receipt({ id: 'review-r', timestamp: 10, proposalId: 'p1' }),
        receipt({ id: 'auto-r', timestamp: 20 }), // no proposalId → automatic
      ],
      { status: 'all' },
    );
    expect(out.map((i) => i.id)).toEqual(['review-r']);
  });

  it('includes autonomous receipts when includeAutonomous=true', () => {
    const out = aggregateThread(
      [],
      [
        receipt({ id: 'review-r', timestamp: 10, proposalId: 'p1' }),
        receipt({ id: 'auto-r', timestamp: 20 }),
      ],
      { status: 'all', includeAutonomous: true },
    );
    expect(out.map((i) => i.id)).toEqual(['auto-r', 'review-r']);
  });

  it('annotates commitmentMode correctly on receipts', () => {
    const out = aggregateThread(
      [],
      [
        receipt({ id: 'a', timestamp: 10, proposalId: 'p' }),
        receipt({ id: 'b', timestamp: 20 }),
      ],
      { status: 'all', includeAutonomous: true },
    );
    const byId = Object.fromEntries(out.map((i) => [i.id, i.commitmentMode]));
    expect(byId.a).toBe('review');
    expect(byId.b).toBe('automatic');
  });

  it('filters by profile', () => {
    const out = aggregateThread(
      [
        proposal({ id: 'a', profileId: 'publish@0.4', status: 'pending', createdAt: 10 }),
        proposal({ id: 'b', profileId: 'charge@0.4', status: 'pending', createdAt: 20 }),
      ],
      [],
      { profile: 'charge@0.4' },
    );
    expect(out.map((i) => i.id)).toEqual(['b']);
  });

  it('applies limit after sort', () => {
    const out = aggregateThread(
      [
        proposal({ id: 'a', status: 'pending', createdAt: 10 }),
        proposal({ id: 'b', status: 'pending', createdAt: 20 }),
        proposal({ id: 'c', status: 'pending', createdAt: 30 }),
      ],
      [],
      { limit: 2 },
    );
    expect(out.map((i) => i.id)).toEqual(['c', 'b']);
  });

  it('profile filter applies to receipts under status=all', () => {
    const out = aggregateThread(
      [],
      [
        receipt({ id: 'r1', profileId: 'publish@0.4', proposalId: 'p', timestamp: 10 }),
        receipt({ id: 'r2', profileId: 'charge@0.4', proposalId: 'p', timestamp: 20 }),
      ],
      { status: 'all', profile: 'charge@0.4' },
    );
    expect(out.map((i) => i.id)).toEqual(['r2']);
  });

  it('returns empty when inputs are empty', () => {
    expect(aggregateThread([], [])).toEqual([]);
  });
});
