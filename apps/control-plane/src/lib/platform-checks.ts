/**
 * This computer's check key (device-keys plan 3.1 `device.check` of type `platform`, DEC-47, 5a): a P-256
 * key in the Secure Enclave that signs the hash of ONE object, only after a touch. The key blob sits in a
 * sealed vault slot; the public key is in the device's chain entry. The helper builds the prompt text from
 * the object, so nothing here can choose what the person reads.
 */

import { type UnlockHelperClient, platformCheckKey, platformCheckProof, sha256Hash } from '@suveren/unlock-helper';
import { deviceKeys } from './device-keys-lazy';
import { randomBytes } from 'node:crypto';
import type { Vault, PlatformGate } from './vault';
import type { DeviceChainStore } from './device-chain-store';
import { canonicalJson } from './change-confirmation';
import { CHECK_POLICY, type PlatformHelper } from './platform-helper';

const SLOT = 'deviceCheckKey';

export interface StoredCheckKey {
  v: 1;
  backend: string;
  policy: string;
  /** Opaque; useless on another computer and without a touch. */
  keyBlob: string;
  /** Uncompressed P-256 point, base64url: the `pub` of the chain's `device.check`. */
  publicKey: string;
}

const B64U = /^[A-Za-z0-9_-]{1,8192}$/;
function valid(v: unknown): v is StoredCheckKey {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o.v === 1 && typeof o.backend === 'string' && typeof o.policy === 'string'
    && typeof o.keyBlob === 'string' && B64U.test(o.keyBlob) && typeof o.publicKey === 'string' && B64U.test(o.publicKey);
}

export class CheckKeyStore {
  /**
   * `chain`: a check key counts only while this computer's device chain is stored. The key's slot is written
   * before the chain in the same step (lib/device-setup.ts); a crash between them, or a cancelled set-up, can
   * leave the slot without a chain. Such a slot is an orphan: it counts for nothing (no password lock-out for a
   * key no chain names) and is cleared the next time something writes. Where `chain` is not given the slot alone decides.
   */
  constructor(private readonly vault: Vault, private readonly chain?: DeviceChainStore) {}

  /** The stored key, or null. Throws while locked and when the slot cannot be read or is not what this code wrote. */
  read(): StoredCheckKey | null {
    const v = this.vault.getSecretSlot<unknown>(SLOT);
    if (v === null) return null;
    if (!valid(v)) throw new Error('The stored check key cannot be read');
    if (this.chain && !this.chain.exists()) return null;   // an orphan
    return v;
  }

  /**
   * Does this computer have a check key? Fails CLOSED: a slot that is there but cannot be opened or read
   * counts as "yes", so the password is not accepted as a confirmation on a read error (plan 7, DEC-47).
   */
  has(): boolean {
    try {
      if (!this.vault.hasSecretSlot(SLOT)) return false;
    } catch {
      return true;
    }
    try {
      return this.read() !== null;
    } catch {
      return true;
    }
  }

  write(key: StoredCheckKey | null): void {
    this.vault.setSecretSlot(SLOT, key);
  }
}

/** A refusal of a check, with a neutral code (and the helper's code when it came from there). */
export class CheckError extends Error {
  constructor(readonly code: string, readonly helperCode?: string) {
    super(code);
    this.name = 'CheckError';
  }
}

function failure(err: unknown): CheckError {
  if (err instanceof CheckError) return err;
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : 'internal';
  return new CheckError('helper_failed', /^[a-z_]{1,40}$/.test(code) ? code : 'internal');
}

export class PlatformChecks {
  /** The helper said `key_invalid` since the last clear: a fingerprint change, or a blob that no longer loads (routes/platform.ts check-key/reset). */
  invalidSeen = false;

  constructor(private readonly host: PlatformHelper) {}

  /** Is a check key possible here? Touch ID is needed for `biometry-current-set`. */
  async possible(): Promise<{ ok: true } | { ok: false; code: string }> {
    const s = await this.host.status();
    if (!s.available) return { ok: false, code: s.reason ?? 'helper_failed' };
    if (!s.biometry) return { ok: false, code: 'no_biometry' };
    return { ok: true };
  }

  /** Make the key in the helper. No touch. */
  async createKey(): Promise<StoredCheckKey> {
    const p = await this.possible();
    if (!p.ok) throw new CheckError(p.code);
    try {
      return await this.host.use(async (c, info) => {
        const k = await c.createCheckKey(CHECK_POLICY);
        return { v: 1 as const, backend: info.backend, policy: k.policy, keyBlob: k.keyBlob, publicKey: k.publicKey };
      });
    } catch (err) {
      throw failure(err);
    }
  }

  /**
   * ONE touch over `object`. The signature is verified here, with hap-core, against the key's public
   * half and the hash of the object, before it is used: a helper that answers with anything else (a
   * wrong key, a signature over other bytes) is a refusal, not a check.
   */
  async sign(key: StoredCheckKey, object: Uint8Array, focus?: string): Promise<{ signature: string; reason: string }> {
    const digest = sha256Hash(object);
    let signed;
    try {
      signed = await this.host.use((c: UnlockHelperClient) => c.signCheck({ keyBlob: key.keyBlob, digest, object, ...(focus !== undefined ? { focus } : {}) }));
    } catch (err) {
      const f = failure(err);
      if (f.helperCode === 'key_invalid') this.invalidSeen = true;
      throw f;
    }
    if (signed.publicKey !== key.publicKey) throw new CheckError('check_invalid');
    const dk = await deviceKeys();
    if (!await dk.verifyCheck(platformCheckKey(key.publicKey), digest, platformCheckProof(signed.signature))) throw new CheckError('check_invalid');
    return { signature: signed.signature, reason: signed.reason };
  }
}

/**
 * What turning Touch ID unlock on or off asks of the check key: one fresh check over an object that names the
 * action, so the helper's prompt says "turn on Touch ID unlock for Suveren" or "turn off …" (not a text anyone
 * supplies). The object carries a random nonce and the time; nothing verifies it later, it only makes each
 * prompt a new one. Returns the gate the vault asks (lib/vault.ts).
 */
export function platformGate(checks: PlatformChecks, store: CheckKeyStore, now: () => number = () => Date.now()): PlatformGate {
  return {
    hasCheckKey: () => store.has(),
    async check(action) {
      let key: StoredCheckKey | null;
      try { key = store.read(); } catch { throw new CheckError('check_invalid'); }   // unreadable: refuse, never skip
      if (!key) throw new CheckError('no_check_key');
      const object = { typ: 'suveren-platform-unlock', v: 1, action, nonce: randomBytes(16).toString('base64url'), issued_at: Math.floor(now() / 1000) };
      await checks.sign(key, new TextEncoder().encode(canonicalJson(object)));
    },
  };
}
