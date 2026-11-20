/**
 * E2E Key Manager — vault-backed HPKE key lifecycle.
 *
 * Vault slot: 'e2eKey'
 * Stored value (JSON): { privateKey: base64, publicKey: base64 }
 *
 * The key pair is generated once per vault (on first call to
 * loadOrGenerateKeyPair) and never leaves the control-plane process in
 * cleartext. The vault encrypts the slot with AES-256-GCM + PBKDF2.
 */

import type { Vault } from './vault';
import { generateKeyPair, type KeyPair } from './e2e-crypto';
import { randomBytes } from 'node:crypto';
import { deviceKeys } from './device-keys-lazy';

const VAULT_SLOT = 'e2eKey';

interface StoredKeyPair {
  privateKey: string; // base64
  publicKey: string;  // base64
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

/**
 * Load the existing key pair from the vault, or generate + store a new one.
 * Idempotent — concurrent calls on the same vault instance are safe
 * because Vault.getCredential / Vault.setCredential are synchronous.
 */
export async function loadOrGenerateKeyPair(vault: Vault): Promise<KeyPair> {
  const stored = vault.getCredential(VAULT_SLOT) as StoredKeyPair | null;
  if (stored?.privateKey && stored?.publicKey) {
    return {
      privateKey: fromBase64(stored.privateKey),
      publicKey: fromBase64(stored.publicKey),
    };
  }

  // Generate a fresh key pair and persist it.
  const kp = await generateKeyPair();
  const toStore: StoredKeyPair = {
    privateKey: toBase64(kp.privateKey),
    publicKey: toBase64(kp.publicKey),
  };
  vault.setCredential(VAULT_SLOT, toStore as unknown as Record<string, string>);
  return kp;
}

/**
 * Return the existing public key bytes, or null if no key pair is stored yet.
 * Does not generate a new key pair.
 */
export async function getPublicKey(vault: Vault): Promise<Uint8Array | null> {
  const stored = vault.getCredential(VAULT_SLOT) as StoredKeyPair | null;
  if (!stored?.publicKey) return null;
  return fromBase64(stored.publicKey);
}

/**
 * Generate a new key pair, overwrite the vault slot, and return the new pair.
 * Use when the user rotates their API key / wipes the vault.
 */
export async function rotateKeyPair(vault: Vault): Promise<KeyPair> {
  const kp = await generateKeyPair();
  const toStore: StoredKeyPair = {
    privateKey: toBase64(kp.privateKey),
    publicKey: toBase64(kp.publicKey),
  };
  vault.setCredential(VAULT_SLOT, toStore as unknown as Record<string, string>);
  return kp;
}

// ─── Device signing key (device-keys plan 2.2, step 6) ──────────────────────
//
// The gateway's Ed25519 signing key. It sits BESIDE the reading key above: the
// reading key (X25519, slot 'e2eKey') stays exactly as it is, so open proposals
// stay readable. The signing key lives in a secret slot of the vault
// (Vault.getSecretSlot), not among the credentials, so nothing that lists,
// pushes or edits credentials can reach it.
//
// What this does and does not promise: this process's own code never writes the
// key to a file in the clear and never sends it to the Authority Server or the
// MCP server. It is sealed with the vault key, and the vault key IS handed to the
// MCP server (/internal/configure), so another process of the gateway can open
// the sealed slot. The protection is "no code path sends it", not "no other
// process can read it".

const SIGNING_SLOT = 'deviceSigningKey';

interface StoredSigningKey {
  privateKey: string; // base64url, the 32-byte Ed25519 seed
  publicKey: string;  // base64url, 32 bytes
}

export interface DeviceSigningKey {
  /** The 32-byte Ed25519 private seed. Handle like a secret: never log, never send. */
  privateSeed: Uint8Array;
  publicKey: Uint8Array;
}

/** The signing key if the vault has one, else null. Never makes one. */
export function loadDeviceSigningKey(vault: Vault): DeviceSigningKey | null {
  const stored = vault.getSecretSlot<StoredSigningKey>(SIGNING_SLOT);
  if (!stored?.privateKey || !stored?.publicKey) return null;
  return {
    privateSeed: new Uint8Array(Buffer.from(stored.privateKey, 'base64url')),
    publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
  };
}

/**
 * The device signing key of this vault, made on first use. Concurrent calls end
 * with ONE key: the slot is read again after the (async) key derivation, and
 * nothing awaits between that read and the write.
 */
export async function loadOrGenerateDeviceSigningKey(vault: Vault): Promise<DeviceSigningKey> {
  const existing = loadDeviceSigningKey(vault);
  if (existing) return existing;
  const privateSeed = new Uint8Array(randomBytes(32));
  const publicKey = await (await deviceKeys()).ed25519PublicKey(privateSeed);
  const raced = loadDeviceSigningKey(vault);
  if (raced) return raced;
  vault.setSecretSlot(SIGNING_SLOT, {
    privateKey: Buffer.from(privateSeed).toString('base64url'),
    publicKey: Buffer.from(publicKey).toString('base64url'),
  } satisfies StoredSigningKey);
  return { privateSeed, publicKey };
}

/** A fresh device signing key, in memory only (DEC-93: made before the vault exists, stored once it does). */
export async function generateDeviceSigningKey(): Promise<DeviceSigningKey> {
  const privateSeed = new Uint8Array(randomBytes(32));
  const publicKey = await (await deviceKeys()).ed25519PublicKey(privateSeed);
  return { privateSeed, publicKey };
}

/**
 * Store a signing key made before the vault existed (DEC-93). Refuses when the vault already holds one: the key the
 * Authority Server bound the enrolment code to must be the one this computer signs with, never silently another.
 */
export function storeDeviceSigningKey(vault: Vault, key: DeviceSigningKey): void {
  if (loadDeviceSigningKey(vault)) throw new Error('A device signing key is already stored');
  vault.setSecretSlot(SIGNING_SLOT, {
    privateKey: Buffer.from(key.privateSeed).toString('base64url'),
    publicKey: Buffer.from(key.publicKey).toString('base64url'),
  } satisfies StoredSigningKey);
}

/** The signing public key, or null when none was made yet. Never generates one. */
export function getDeviceSigningPublicKey(vault: Vault): Uint8Array | null {
  return loadDeviceSigningKey(vault)?.publicKey ?? null;
}
