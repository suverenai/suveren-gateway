import { describe, it, expect } from 'vitest';
import { sessionUserFromGroup } from './sp-client';

describe('the signed-in person from the personal workspace (unlock on a gateway with device keys)', () => {
  it('reads the Authority Server\'s shape: { group, members: [{ userId }] }', () => {
    const detail = { group: { id: 'grp_1', isPersonal: true, ownerUserId: 'u-1' }, members: [{ groupId: 'grp_1', userId: 'u-1', name: 'Ann', email: 'ann@test.local' }], isAdmin: true };
    expect(sessionUserFromGroup(detail)).toEqual({ id: 'u-1', name: 'Ann', email: 'ann@test.local', did: '' });
  });
  it('takes the owner when several members are listed', () => {
    const detail = { group: { ownerUserId: 'u-2' }, members: [{ userId: 'u-1', name: 'A' }, { userId: 'u-2', name: 'B' }] };
    expect(sessionUserFromGroup(detail)?.id).toBe('u-2');
  });
  it('still reads an `id` member (older shape); nobody → null', () => {
    expect(sessionUserFromGroup({ members: [{ id: 'u-3', name: 'C' }] })?.id).toBe('u-3');
    expect(sessionUserFromGroup({ members: [] })).toBeNull();
    expect(sessionUserFromGroup({ group: { ownerUserId: 'u-9' }, members: [{ userId: 'u-1' }] })).toBeNull();
  });
});
