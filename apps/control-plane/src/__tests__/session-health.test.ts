/**
 * The `/health` session contract: `vaultUnlocked` must go false the instant
 * the gateway locks (boot-locked OR because the AS session ended), and
 * `session.lockedReason` must say WHICH — "looks signed in, nothing works"
 * is exactly the state this project decided must never happen.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../lib/vault';
import { buildSessionHealth } from '../lib/session-health';

const tmp = () => mkdtempSync(join(tmpdir(), 'session-health-'));

describe('buildSessionHealth', () => {
  it('boot-locked: active=false, no reason, expiresAt null', () => {
    const vault = new Vault(tmp());
    expect(buildSessionHealth(vault)).toEqual({ state: 'locked', expiresAt: null });
  });

  it('active session: reports state + expiresAt, no lockedReason', async () => {
    const vault = new Vault(tmp());
    await vault.deriveAndSetKey('api-key');
    vault.setSessionExpiresAt(1_800_000_000);
    expect(buildSessionHealth(vault)).toEqual({ state: 'active', expiresAt: 1_800_000_000 });
  });

  it('locked because the session ended: state locked, reason "expired", no stale expiresAt', async () => {
    const vault = new Vault(tmp());
    await vault.deriveAndSetKey('api-key');
    vault.setSessionExpiresAt(1_800_000_000);
    vault.lockExpired();
    expect(buildSessionHealth(vault)).toEqual({ state: 'locked', expiresAt: null, lockedReason: 'expired' });
  });

  it('a fresh login after an expiry clears the stale reason', async () => {
    const vault = new Vault(tmp());
    await vault.deriveAndSetKey('api-key');
    vault.lockExpired();
    await vault.deriveAndSetKey('api-key');
    vault.setSessionExpiresAt(1_900_000_000);
    expect(buildSessionHealth(vault)).toEqual({ state: 'active', expiresAt: 1_900_000_000 });
  });

  it('a deliberate logout (clearKey) carries no lockedReason — distinct from an expiry', async () => {
    const vault = new Vault(tmp());
    await vault.deriveAndSetKey('api-key');
    vault.setSessionExpiresAt(1_800_000_000);
    vault.clearKey();
    expect(buildSessionHealth(vault)).toEqual({ state: 'locked', expiresAt: null });
  });
});
