import { describe, it, expect } from 'vitest';
import { queueDomains, mergeProposals, resolveDomainFor } from './my-queue';
import type { Proposal } from './sp-client';

const p = (id: string, createdAt: number, pendingDomains: string[] = []) =>
  ({ id, createdAt, pendingDomains }) as unknown as Proposal;

describe('my approval queue', () => {
  it('reads the personal workspace too while a team is active', () => {
    expect(queueDomains('u_123')).toEqual(['u_123', 'owner']);
    expect(queueDomains('owner')).toEqual(['owner']);
    expect(queueDomains(null)).toEqual(['owner']);
  });

  it('merges newest first, each proposal once', () => {
    const merged = mergeProposals([[p('a', 1), p('b', 3)], [p('b', 3), p('c', 2)]]);
    expect(merged.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it("resolves a personal proposal under 'owner' even in team context", () => {
    expect(resolveDomainFor(p('x', 1, ['owner']), 'u_123')).toBe('owner');
    expect(resolveDomainFor(p('x', 1, ['u_123', 'owner']), 'u_123')).toBe('u_123');
    expect(resolveDomainFor(p('x', 1, ['u_123']), 'u_123')).toBe('u_123');
    expect(resolveDomainFor(undefined, 'u_123')).toBe('u_123');
    expect(resolveDomainFor(p('x', 1, ['owner']), null)).toBe('owner');
  });
});
