import { describe, it, expect } from 'vitest';
import { buildMyQueue, pruneDecided } from './approval-queue';
import type { Proposal } from './sp-client';

function p(id: string, over: Partial<Proposal> = {}): Proposal {
  return { id, status: 'pending', createdAt: 1000, profileId: 'x@1', tool: 'a__b', ...over } as Proposal;
}
const none = new Set<string>();

describe('buildMyQueue ("For me")', () => {
  it('holds pending review-mode proposals and approver proposals, oldest first', () => {
    const q = buildMyQueue([p('r2', { createdAt: 3 }), p('r1', { createdAt: 1 })], [p('a1', { createdAt: 2, pendingApprovers: ['me'] })], none, 'me');
    expect(q.map((e) => [e.id, e.route])).toEqual([['r1', 'queue'], ['a1', 'approver'], ['r2', 'queue']]);
  });
  it('leaves out proposals that are not pending', () => {
    expect(buildMyQueue([p('done', { status: 'approved' } as never)], [], none, 'me')).toEqual([]);
  });
  it('leaves out a workspace proposal that waits on named approvers (those are others\' to decide)', () => {
    expect(buildMyQueue([p('x', { pendingApprovers: ['someone'] })], [], none, 'me')).toEqual([]);
  });
  it('never offers my own above-limit proposal for approval', () => {
    const own = p('own', { pendingApprovers: ['me'], createdBy: 'me' });
    expect(buildMyQueue([], [own], none, 'me')).toEqual([]);
    expect(buildMyQueue([], [own], none, 'someone-else').map((e) => e.id)).toEqual(['own']);
  });
  it('lists a proposal once when both sources carry it', () => {
    const q = buildMyQueue([p('same')], [p('same', { pendingApprovers: ['me'] })], none, 'me');
    expect(q.map((e) => [e.id, e.route])).toEqual([['same', 'queue']]);
  });
  it('drops ids the gateway has already answered', () => {
    expect(buildMyQueue([p('a'), p('b', { createdAt: 2 })], [], new Set(['a']), 'me').map((e) => e.id)).toEqual(['b']);
  });
});

describe('pruneDecided', () => {
  it('keeps only ids the backend still lists', () => {
    const kept = pruneDecided(new Set(['a', 'gone']), [p('a')], []);
    expect([...kept]).toEqual(['a']);
  });
});
