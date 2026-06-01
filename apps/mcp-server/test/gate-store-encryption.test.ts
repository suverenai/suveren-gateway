/**
 * Gate Store Encryption Tests
 *
 * Verifies that gate content is encrypted when a vault key is set,
 * and that the encrypted file cannot be read without the correct key.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { GateStore, type GateEntry } from '../src/lib/gate-store';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeVaultKey(): Buffer {
  return randomBytes(32); // AES-256-GCM requires 32-byte key
}

function makeEntry(overrides: Partial<GateEntry> = {}): GateEntry {
  return {
    frameHash: 'sha256:abc123',
    boundsHash: 'sha256:bounds123',
    contextHash: 'sha256:ctx123',
    path: 'charge-routine',
    profileId: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
    gateContent: {
      problem: 'Test purchasing authority.',
      objective: 'Enable automated payment processing.',
      tradeoffs: 'Accepts risk up to configured limits.',
    },
    context: {
      currency: 'USD',
      action_type: 'charge',
    },
    storedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Fixture management ────────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'suveren-gate-test-'));
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GateStore — plaintext mode (no vault key)', () => {
  it('stores entry as plaintext JSON', () => {
    const store = new GateStore(testDir);
    store.set('charge-routine', makeEntry());

    const plaintextPath = join(testDir, 'gates.json');
    expect(existsSync(plaintextPath)).toBe(true);

    const raw = readFileSync(plaintextPath, 'utf-8');
    const data = JSON.parse(raw) as { version: number; entries: Record<string, unknown> };
    expect(data.version).toBe(1);
    expect(data.entries['charge-routine']).toBeTruthy();
  });

  it('plaintext file contains readable gate content', () => {
    const store = new GateStore(testDir);
    store.set('charge-routine', makeEntry());

    const raw = readFileSync(join(testDir, 'gates.json'), 'utf-8');
    // Problem, objective, tradeoffs are all readable in plaintext
    expect(raw).toContain('Test purchasing authority');
    expect(raw).toContain('Enable automated payment processing');
    expect(raw).toContain('Accepts risk up to configured limits');
  });

  it('can get stored entry back', () => {
    const store = new GateStore(testDir);
    const entry = makeEntry();
    store.set('charge-routine', entry);

    const retrieved = store.get('charge-routine');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.gateContent.problem).toBe(entry.gateContent.problem);
    expect(retrieved!.context?.currency).toBe('USD');
  });

  it('no encrypted file created without vault key', () => {
    const store = new GateStore(testDir);
    store.set('charge-routine', makeEntry());

    expect(existsSync(join(testDir, 'gates.enc.json'))).toBe(false);
  });
});

describe('GateStore — encrypted mode (with vault key)', () => {
  it('stores entry as encrypted blob', () => {
    const store = new GateStore(testDir);
    store.setVaultKey(makeVaultKey());
    store.set('charge-routine', makeEntry());

    const encPath = join(testDir, 'gates.enc.json');
    expect(existsSync(encPath)).toBe(true);

    const raw = readFileSync(encPath, 'utf-8');
    const data = JSON.parse(raw) as {
      version: number;
      entries: Record<string, { iv: string; ciphertext: string; tag: string }>;
    };
    expect(data.version).toBe(1);
    const blob = data.entries['charge-routine'];
    expect(blob).toBeTruthy();
    // Blob has iv, ciphertext, tag — not plaintext fields
    expect(blob.iv).toBeTruthy();
    expect(blob.ciphertext).toBeTruthy();
    expect(blob.tag).toBeTruthy();
  });

  it('encrypted file does not contain readable gate content', () => {
    const store = new GateStore(testDir);
    store.setVaultKey(makeVaultKey());
    store.set('charge-routine', makeEntry());

    const raw = readFileSync(join(testDir, 'gates.enc.json'), 'utf-8');
    // Gate content must NOT appear in plaintext in the encrypted file
    expect(raw).not.toContain('Test purchasing authority');
    expect(raw).not.toContain('Enable automated payment processing');
    expect(raw).not.toContain('Accepts risk up to configured limits');
  });

  it('encrypted file does not contain plaintext context values', () => {
    const store = new GateStore(testDir);
    store.setVaultKey(makeVaultKey());
    store.set('charge-routine', makeEntry());

    const raw = readFileSync(join(testDir, 'gates.enc.json'), 'utf-8');
    // Context content must NOT appear in plaintext
    expect(raw).not.toContain('"currency"');
    expect(raw).not.toContain('USD');
    expect(raw).not.toContain('"action_type"');
    expect(raw).not.toContain('"charge"');
  });

  it('can decrypt and retrieve entry with correct vault key', () => {
    const vaultKey = makeVaultKey();
    const store = new GateStore(testDir);
    store.setVaultKey(vaultKey);
    const entry = makeEntry();
    store.set('charge-routine', entry);

    // Create a new store with the same key and same directory
    const store2 = new GateStore(testDir);
    store2.setVaultKey(vaultKey);

    const retrieved = store2.get('charge-routine');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.gateContent.problem).toBe(entry.gateContent.problem);
    expect(retrieved!.gateContent.objective).toBe(entry.gateContent.objective);
    expect(retrieved!.gateContent.tradeoffs).toBe(entry.gateContent.tradeoffs);
    expect(retrieved!.context?.currency).toBe('USD');
    expect(retrieved!.context?.action_type).toBe('charge');
  });

  it('wrong vault key fails to decrypt (does not return garbage)', () => {
    const correctKey = makeVaultKey();
    const wrongKey = makeVaultKey();

    const store = new GateStore(testDir);
    store.setVaultKey(correctKey);
    store.set('charge-routine', makeEntry());

    // Create a new store with the WRONG key
    const store2 = new GateStore(testDir);
    store2.setVaultKey(wrongKey);

    // The store should fail gracefully and return null (not garbage data)
    // loadEncrypted catches the AES-GCM auth tag error and resets entries to empty
    const retrieved = store2.get('charge-routine');
    expect(retrieved).toBeNull();
  });

  it('context field is included in encrypted storage', () => {
    const vaultKey = makeVaultKey();
    const store = new GateStore(testDir);
    store.setVaultKey(vaultKey);

    const entry = makeEntry({
      context: { currency: 'EUR', action_type: 'refund' },
    });
    store.set('charge-routine', entry);

    // Reload with same key and verify context round-trips
    const store2 = new GateStore(testDir);
    store2.setVaultKey(vaultKey);

    const retrieved = store2.get('charge-routine');
    expect(retrieved!.context).toEqual({ currency: 'EUR', action_type: 'refund' });
  });
});

describe('GateStore — migration: plaintext to encrypted', () => {
  it('after setVaultKey, plaintext file is removed and encrypted file exists', () => {
    // 1. Write plaintext entries without vault key
    const store = new GateStore(testDir);
    store.set('charge-routine', makeEntry());

    const plaintextPath = join(testDir, 'gates.json');
    const encPath = join(testDir, 'gates.enc.json');

    expect(existsSync(plaintextPath)).toBe(true);
    expect(existsSync(encPath)).toBe(false);

    // 2. Now set the vault key — triggers migration
    store.setVaultKey(makeVaultKey());

    expect(existsSync(plaintextPath)).toBe(false);
    expect(existsSync(encPath)).toBe(true);
  });

  it('migrated entries are readable with the vault key', () => {
    // 1. Write plaintext entries
    const store = new GateStore(testDir);
    const entry = makeEntry();
    store.set('charge-routine', entry);

    // 2. Migrate to encrypted
    const vaultKey = makeVaultKey();
    store.setVaultKey(vaultKey);

    // 3. Verify the migrated entry is still accessible
    const retrieved = store.get('charge-routine');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.gateContent.problem).toBe(entry.gateContent.problem);
  });

  it('migrated encrypted file does not contain plaintext problem text', () => {
    const store = new GateStore(testDir);
    store.set('charge-routine', makeEntry());

    store.setVaultKey(makeVaultKey());

    const raw = readFileSync(join(testDir, 'gates.enc.json'), 'utf-8');
    expect(raw).not.toContain('Test purchasing authority');
  });
});
