/**
 * The person's own device chain, as this gateway knows it (device-keys plan
 * section 7, step 6): the root DID, this computer's key id, the head of the
 * chain it last verified, and which Authority Server it belongs to.
 *
 * It lives in a sealed slot of the vault, so the AI cannot rewrite it while the
 * gateway is locked, and nothing that lists or edits credentials can reach it.
 * It holds NO private key: the root key is made from the recovery code, which is
 * never stored (lib/device-setup.ts), and this computer's signing key has its
 * own slot (lib/e2e-key-manager.ts).
 *
 * The head only moves forward. A head that is lower, or the same number with
 * another hash, is a rollback or a fork, never an update.
 *
 * SEAM (step 8): the plan also keeps "pinned DIDs and heads of other people"
 * here. Nothing reads or writes them yet.
 */

import type { Vault } from './vault';

const SLOT = 'deviceChain';

export interface ChainHeadRef {
  seq: number;
  hash: string;
}

export interface StoredDeviceChain {
  v: 1;
  rootDid: string;
  /** This computer's key id (`base64url(sha256(sign_pub))`). */
  keyId: string;
  head: ChainHeadRef;
  /** The Authority Server this chain was made on. A chain is bound to one. */
  asUrl: string;
  label: string;
  /** Epoch seconds. */
  setUpAt: number;
}

/** The slot is there but is not what this code wrote. Treated as "set up": never as "not set up". */
export class DeviceChainCorruptError extends Error {
  constructor() {
    super('The stored device chain cannot be read');
    this.name = 'DeviceChainCorruptError';
  }
}

export class ChainHeadRefusedError extends Error {
  constructor(readonly reason: 'rollback' | 'fork', message: string) {
    super(message);
    this.name = 'ChainHeadRefusedError';
  }
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const isHash = (h: unknown): h is string => typeof h === 'string' && /^sha256:[0-9a-f]{64}$/.test(h);

function valid(v: unknown): v is StoredDeviceChain {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const head = o.head as Record<string, unknown> | undefined;
  return o.v === 1
    && typeof o.rootDid === 'string' && o.rootDid.startsWith('did:key:')
    && typeof o.keyId === 'string' && o.keyId.length === 43
    && !!head && isInt(head.seq) && isHash(head.hash)
    && typeof o.asUrl === 'string' && o.asUrl.length > 0
    && typeof o.label === 'string' && isInt(o.setUpAt);
}

export class DeviceChainStore {
  constructor(private readonly vault: Vault) {}

  /** The stored chain, or null when this gateway never set up. Throws while locked and on a slot it cannot read. */
  read(): StoredDeviceChain | null {
    const v = this.vault.getSecretSlot<unknown>(SLOT);
    if (v === null) return null;
    if (!valid(v)) throw new DeviceChainCorruptError();
    return v;
  }

  /**
   * Is a chain stored? Fails CLOSED: a slot that cannot be opened or read counts
   * as "yes", so nothing falls back to the account key on a read error.
   */
  exists(): boolean {
    try {
      return this.read() !== null;
    } catch {
      return true;
    }
  }

  /**
   * What the account-key login needs to know. 'unreadable': the vault file cannot be
   * read, or an unlocked vault holds a slot that cannot be opened. A LOCKED vault
   * with the slot is 'present' (it was set up); the slot is not opened.
   */
  state(): 'none' | 'present' | 'unreadable' {
    let has: boolean;
    try {
      has = this.vault.hasSecretSlot(SLOT);
    } catch {
      return 'unreadable';
    }
    if (!has) return 'none';
    if (!this.vault.isUnlocked()) return 'present';
    try {
      return this.read() === null ? 'none' : 'present';
    } catch {
      return 'unreadable';
    }
  }

  /** Store the first (genesis) record. Refuses to replace one: a chain is made once. */
  create(chain: StoredDeviceChain): void {
    if (!valid(chain)) throw new Error('not a device chain record');
    if (this.vault.getSecretSlot<unknown>(SLOT) !== null) throw new Error('A device chain is already stored');
    this.vault.setSecretSlot(SLOT, chain);
  }

  /**
   * Move the head forward after the whole chain was verified with hap-core.
   * Same head: nothing changes. Lower: rollback. Same number, other hash: fork.
   */
  advance(head: ChainHeadRef): StoredDeviceChain {
    const cur = this.read();
    if (!cur) throw new Error('No device chain is stored');
    if (!isInt(head.seq) || !isHash(head.hash)) throw new Error('not a chain head');
    if (head.seq < cur.head.seq) throw new ChainHeadRefusedError('rollback', 'the chain is shorter than the one already verified');
    if (head.seq === cur.head.seq) {
      if (head.hash !== cur.head.hash) throw new ChainHeadRefusedError('fork', 'the chain differs at the verified head');
      return cur;
    }
    const next: StoredDeviceChain = { ...cur, head: { seq: head.seq, hash: head.hash } };
    this.vault.setSecretSlot(SLOT, next);
    return next;
  }
}
