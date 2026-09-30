/**
 * Mirrors session-lock.test.ts for the AS-key-mismatch lock: a live signing
 * key that disagrees with the one pinned at pairing must lock the gateway —
 * exactly like a session that ended — so a human notices even between tool
 * calls, not just via the per-call Gatekeeper refusal.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../lib/vault';
import { createAsKeyMismatchLock, AS_KEY_MISMATCH_MESSAGE } from '../lib/session-lock';

const tmp = () => mkdtempSync(join(tmpdir(), 'as-key-mismatch-lock-'));

async function unlockedVault(): Promise<Vault> {
  const vault = new Vault(tmp());
  await vault.deriveAndSetKey('api-key');
  return vault;
}

function harness(vault: Vault) {
  const notifyFn = vi.fn();
  const unconfigureSessionFn = vi.fn().mockResolvedValue(undefined);
  const emit = vi.fn();
  const lock = createAsKeyMismatchLock({ vault, port: 3402, notifyFn, unconfigureSessionFn, emit });
  return { lock, notifyFn, unconfigureSessionFn, emit };
}

describe('createAsKeyMismatchLock', () => {
  it('locks the vault (isUnlocked() false afterwards)', async () => {
    const vault = await unlockedVault();
    const { lock } = harness(vault);
    lock();
    expect(vault.isUnlocked()).toBe(false);
  });

  it('records the reason distinctly from an expired session', async () => {
    const vault = await unlockedVault();
    const { lock } = harness(vault);
    lock();
    expect(vault.getLockedReason()).toBe('as-key-mismatch');
  });

  it('emits session-locked with the mismatch message', async () => {
    const vault = await unlockedVault();
    const { lock, emit } = harness(vault);
    lock();
    expect(emit).toHaveBeenCalledWith('session-locked', { reason: 'as-key-mismatch', message: AS_KEY_MISMATCH_MESSAGE });
  });

  it('is a no-op when already locked (single-flight)', async () => {
    const vault = new Vault(tmp()); // never unlocked
    const { lock, notifyFn, emit } = harness(vault);
    lock();
    expect(notifyFn).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('never throws when the MCP push fails', async () => {
    const vault = await unlockedVault();
    const notifyFn = vi.fn();
    const unconfigureSessionFn = vi.fn().mockRejectedValue(new Error('MCP unreachable'));
    const emit = vi.fn();
    const lock = createAsKeyMismatchLock({ vault, port: 3402, notifyFn, unconfigureSessionFn, emit });

    expect(() => lock()).not.toThrow();
    expect(vault.isUnlocked()).toBe(false);
    await new Promise(r => setTimeout(r, 0));
  });
});
