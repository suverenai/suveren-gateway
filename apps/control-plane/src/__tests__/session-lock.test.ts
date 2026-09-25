/**
 * The gateway must lock — exactly like logout — the moment the AS session
 * ends, and it must say so exactly once, no matter how many concurrent
 * signals arrive (several 401s from the MCP server, one from the CP's own
 * AS proxy, the expiry timer — any combination).
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../lib/vault';
import { createSessionLock, SESSION_LOCKED_MESSAGE } from '../lib/session-lock';

const tmp = () => mkdtempSync(join(tmpdir(), 'session-lock-'));

async function unlockedVault(): Promise<Vault> {
  const vault = new Vault(tmp());
  await vault.deriveAndSetKey('api-key');
  vault.setSessionExpiresAt(1_800_000_000);
  return vault;
}

function harness(vault: Vault) {
  const notifyFn = vi.fn();
  const unconfigureSessionFn = vi.fn().mockResolvedValue(undefined);
  const emit = vi.fn();
  const lock = createSessionLock({ vault, port: 3402, notifyFn, unconfigureSessionFn, emit });
  return { lock, notifyFn, unconfigureSessionFn, emit };
}

describe('createSessionLock', () => {
  it('locks the vault exactly like logout (isUnlocked() false afterwards)', async () => {
    const vault = await unlockedVault();
    const { lock } = harness(vault);
    lock();
    expect(vault.isUnlocked()).toBe(false);
  });

  it('records WHY, distinct from a plain logout', async () => {
    const vault = await unlockedVault();
    const { lock } = harness(vault);
    lock();
    expect(vault.getLockedReason()).toBe('expired');
  });

  it('pushes the cleared state to the MCP server', async () => {
    const vault = await unlockedVault();
    const { lock, unconfigureSessionFn } = harness(vault);
    lock();
    expect(unconfigureSessionFn).toHaveBeenCalledOnce();
  });

  it('emits session-locked with a one-line reason, once', async () => {
    const vault = await unlockedVault();
    const { lock, emit } = harness(vault);
    lock();
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith('session-locked', { reason: 'expired', message: SESSION_LOCKED_MESSAGE });
  });

  it('notifies the desktop exactly once — with the locked-session copy', async () => {
    const vault = await unlockedVault();
    const { lock, notifyFn } = harness(vault);
    lock();
    expect(notifyFn).toHaveBeenCalledOnce();
    const [title, message] = notifyFn.mock.calls[0];
    expect(title).toBe('Suveren Gateway locked');
    expect(message).toBe('Your sign-in has ended. Sign in again so your agents can act.');
  });

  it('is single-flight: several calls in a row (concurrent 401s) notify exactly once', async () => {
    const vault = await unlockedVault();
    const { lock, notifyFn, emit, unconfigureSessionFn } = harness(vault);

    // Models several concurrent tool calls each hitting the dead session and
    // each calling this synchronously, plus the expiry timer racing them.
    lock();
    lock();
    lock();

    expect(notifyFn).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledOnce();
    expect(unconfigureSessionFn).toHaveBeenCalledOnce();
  });

  it('is a no-op when the vault is already locked for any other reason (boot-locked)', () => {
    const vault = new Vault(tmp()); // never unlocked
    const { lock, notifyFn, emit, unconfigureSessionFn } = harness(vault);

    lock();

    expect(notifyFn).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(unconfigureSessionFn).not.toHaveBeenCalled();
    // Must not overwrite "never signed in" with "expired" — they read differently.
    expect(vault.getLockedReason()).toBeNull();
  });

  it('never throws when the MCP push fails — the lock itself must still hold', async () => {
    const vault = await unlockedVault();
    const notifyFn = vi.fn();
    const unconfigureSessionFn = vi.fn().mockRejectedValue(new Error('MCP unreachable'));
    const emit = vi.fn();
    const lock = createSessionLock({ vault, port: 3402, notifyFn, unconfigureSessionFn, emit });

    expect(() => lock()).not.toThrow();
    expect(vault.isUnlocked()).toBe(false);
    // Let the rejected promise's .catch() run before the test ends.
    await new Promise(r => setTimeout(r, 0));
  });
});
