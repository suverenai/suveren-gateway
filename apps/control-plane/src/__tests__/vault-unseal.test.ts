/**
 * Vault unseal providers.
 *
 * The vault key exists only in memory and today comes only from the user's API
 * key, so the gateway boots LOCKED. That is correct on a laptop and a liveness
 * problem on a server: an unattended restart cannot unlock itself, and the
 * agent stops being able to act until a human logs in.
 *
 * These tests pin the seam that lets an unattended provider (KMS unwrap,
 * instance identity) be added later as a new class rather than as a change to
 * every call site — including that `deriveKey` may be ASYNC, which is the part
 * that would otherwise force a cross-cutting refactor once a real KMS is used.
 *
 * They deliberately do NOT add such a provider. Shipping one is a decision to
 * weaken the laptop guarantee and belongs to a deployment story, not to this
 * refactor.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault, ApiKeyUnsealProvider, type UnsealProvider } from '../lib/vault';

const tmp = () => mkdtempSync(join(tmpdir(), 'vault-unseal-'));

/** Stands in for a machine-presented secret (KMS unwrap, instance identity). */
class FixedKeyProvider implements UnsealProvider {
  readonly id = 'test-fixed';
  constructor(private readonly seed: string) {}
  deriveKey(salt: Buffer): Buffer {
    const key = Buffer.alloc(32);
    Buffer.from(this.seed).copy(key);
    salt.subarray(0, 8).copy(key, 24);
    return key;
  }
}

/** A provider whose derivation is asynchronous — the KMS shape. */
class AsyncProvider implements UnsealProvider {
  readonly id = 'test-async';
  async deriveKey(salt: Buffer): Promise<Buffer> {
    await new Promise((r) => setTimeout(r, 1));
    return new FixedKeyProvider('async-seed').deriveKey(salt);
  }
}

describe('Vault unseal providers', () => {
  it('starts locked — nothing on disk or in env unlocks it', () => {
    const vault = new Vault(tmp());
    expect(vault.isUnlocked()).toBe(false);
    expect(vault.unsealedByProvider()).toBeNull();
    expect(() => vault.getVaultKeyHex()).toThrow(/locked/i);
  });

  it('unseals with an arbitrary provider and reports which one', async () => {
    const vault = new Vault(tmp());
    await vault.unseal(new FixedKeyProvider('seed-a'));
    expect(vault.isUnlocked()).toBe(true);
    expect(vault.unsealedByProvider()).toBe('test-fixed');
  });

  it('supports an ASYNC provider — the reason deriveKey may return a promise', async () => {
    const vault = new Vault(tmp());
    await vault.unseal(new AsyncProvider());
    expect(vault.isUnlocked()).toBe(true);
    expect(vault.unsealedByProvider()).toBe('test-async');
  });

  it('reuses the stored salt, so the same provider reopens the same vault', async () => {
    const dir = tmp();
    const first = new Vault(dir);
    await first.unseal(new FixedKeyProvider('seed-a'));
    const keyA = first.getVaultKeyHex();

    const second = new Vault(dir);
    await second.unseal(new FixedKeyProvider('seed-a'));
    expect(second.getVaultKeyHex()).toBe(keyA);
  });

  it('a vault sealed by one authority is NOT readable by another', async () => {
    const dir = tmp();
    const a = new Vault(dir);
    await a.unseal(new FixedKeyProvider('seed-a'));

    const b = new Vault(dir);
    await b.unseal(new FixedKeyProvider('seed-b'));

    expect(b.getVaultKeyHex()).not.toBe(a.getVaultKeyHex());
  });

  it('deriveAndSetKey is exactly unseal(ApiKeyUnsealProvider) — same key, no drift', async () => {
    const dir = tmp();
    const viaHelper = new Vault(dir);
    await viaHelper.deriveAndSetKey('api-key-123');

    const viaProvider = new Vault(dir);
    await viaProvider.unseal(new ApiKeyUnsealProvider('api-key-123'));

    expect(viaProvider.getVaultKeyHex()).toBe(viaHelper.getVaultKeyHex());
    expect(viaHelper.unsealedByProvider()).toBe('api-key');
  });

  it('only the API-key path enables validateApiKey — a machine provider has no user secret to check', async () => {
    const dir = tmp();
    const viaApiKey = new Vault(dir);
    await viaApiKey.deriveAndSetKey('api-key-123');
    expect(viaApiKey.validateApiKey('api-key-123')).toBe(true);
    expect(viaApiKey.validateApiKey('wrong')).toBe(false);

    const viaMachine = new Vault(tmp());
    await viaMachine.unseal(new FixedKeyProvider('seed-a'));
    expect(viaMachine.validateApiKey('anything')).toBe(false);
  });

  it('clearKey relocks and forgets the provider', async () => {
    const vault = new Vault(tmp());
    await vault.deriveAndSetKey('api-key-123');
    vault.clearKey();
    expect(vault.isUnlocked()).toBe(false);
    expect(vault.unsealedByProvider()).toBeNull();
  });
});
