/**
 * The `/health` session shape — "if the gateway shows the user as signed in,
 * gated actions work; if it cannot, the gateway is visibly locked and says
 * why" starts with `/health` telling the truth. Pulled out of index.ts (which
 * starts a server on import and so is never imported by tests — see
 * `__tests__/install-method.test.ts`) so this contract has a real unit test.
 */
import type { Vault } from './vault';

export interface SessionHealth {
  state: 'active' | 'locked';
  expiresAt: number | null;
  lockedReason?: 'expired';
}

export function buildSessionHealth(vault: Vault): SessionHealth {
  const unlocked = vault.isUnlocked();
  const lockedReason = vault.getLockedReason();
  return {
    state: unlocked ? 'active' : 'locked',
    expiresAt: unlocked ? vault.getSessionExpiresAt() : null,
    ...(lockedReason ? { lockedReason } : {}),
  };
}
