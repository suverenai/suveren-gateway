export function useAuth() {
  return { mode: 'team', domain: 'owner', groupId: 'g1', group: null, activeTeam: { isAdmin: false }, user: { id: 'u1' } } as never;
}
