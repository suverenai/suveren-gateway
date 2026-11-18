/**
 * The chain heads this gateway has verified, per person (device-keys plan section 7,
 * "pinned DIDs and heads of other people"; step 12 computer part).
 *
 * The MCP server verifies an approver's chain itself (hap-core) before it lets a
 * committed proposal run. What it needs from here is memory: the head it accepted
 * last time, so a chain that is shorter (rollback) or differs at the same number
 * (fork) is refused instead of believed. The memory lives in a sealed slot of the
 * vault, so the AI cannot rewrite it while the gateway is locked; it holds no key
 * and nothing secret.
 *
 * This computer's own chain is not stored twice: its pin is the head of the chain
 * record (lib/device-chain-store.ts), which sign-in already moves forward.
 *
 * A pin is only ever for a DID the caller names; which DIDs may be asked about (the
 * signed identities of a mandate) is the caller's rule, not this store's.
 */

import type { Vault } from './vault';
import { type ChainHeadRef, type DeviceChainStore, ChainHeadRefusedError } from './device-chain-store';

const SLOT = 'devicePins';
/** More than this many people is not a mandate; the store refuses to grow without bound. */
const MAX_PINS = 256;

interface PinFile { v: 1; pins: Record<string, ChainHeadRef> }

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const isHash = (h: unknown): h is string => typeof h === 'string' && /^sha256:[0-9a-f]{64}$/.test(h);
const isDid = (d: unknown): d is string => typeof d === 'string' && d.startsWith('did:key:') && d.length <= 128;

export class PinRefusedError extends Error {
  constructor(readonly reason: 'rollback' | 'fork' | 'bad_request' | 'full') {
    super(reason);
    this.name = 'PinRefusedError';
  }
}

export class DevicePinStore {
  constructor(private readonly vault: Vault, private readonly own: DeviceChainStore) {}

  private read(): PinFile {
    const v = this.vault.getSecretSlot<unknown>(SLOT);
    if (v === null) return { v: 1, pins: {} };
    const f = v as Partial<PinFile>;
    if (f?.v !== 1 || !f.pins || typeof f.pins !== 'object') throw new Error('The stored chain pins cannot be read');
    for (const [did, h] of Object.entries(f.pins)) {
      if (!isDid(did) || !isInt(h?.seq) || !isHash(h?.hash)) throw new Error('The stored chain pins cannot be read');
    }
    return f as PinFile;
  }

  /** The head accepted for `did`, or null when none was. Throws while locked or on a slot it cannot read. */
  get(did: string): ChainHeadRef | null {
    if (!isDid(did)) throw new PinRefusedError('bad_request');
    const mine = this.own.read();
    if (mine && mine.rootDid === did) return { ...mine.head };
    return this.read().pins[did] ?? null;
  }

  /** Move the pin forward after the whole chain was verified. Same head: nothing. Lower: rollback. Same number, other hash: fork. */
  advance(did: string, head: ChainHeadRef): ChainHeadRef {
    if (!isDid(did) || !isInt(head?.seq) || !isHash(head?.hash)) throw new PinRefusedError('bad_request');
    const mine = this.own.read();
    try {
      if (mine && mine.rootDid === did) return this.own.advance(head).head;
    } catch (e) {
      if (e instanceof ChainHeadRefusedError) throw new PinRefusedError(e.reason);
      throw e;
    }
    const file = this.read();
    const cur = file.pins[did];
    if (cur) {
      if (head.seq < cur.seq) throw new PinRefusedError('rollback');
      if (head.seq === cur.seq) {
        if (head.hash !== cur.hash) throw new PinRefusedError('fork');
        return cur;
      }
    } else if (Object.keys(file.pins).length >= MAX_PINS) {
      throw new PinRefusedError('full');
    }
    file.pins[did] = { seq: head.seq, hash: head.hash };
    this.vault.setSecretSlot(SLOT, file);
    return file.pins[did];
  }
}
