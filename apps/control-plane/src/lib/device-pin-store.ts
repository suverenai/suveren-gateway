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

interface PinFile { v: 1; pins: Record<string, ChainHeadRef & { at?: number }> }

const LEDGER_SLOT = 'deviceLedger';
/** Executed proposals and consumed decision nonces kept; the oldest go first. */
const MAX_LEDGER = 2000;
interface LedgerFile { v: 1; proposals: Array<{ id: string; nonces: string[] }>; nonces: string[] }

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const isHash = (h: unknown): h is string => typeof h === 'string' && /^sha256:[0-9a-f]{64}$/.test(h);
const isDid = (d: unknown): d is string => typeof d === 'string' && d.startsWith('did:key:') && d.length <= 128;

export class PinRefusedError extends Error {
  constructor(readonly reason: 'rollback' | 'fork' | 'bad_request' | 'full' | 'own_chain' | 'proposal_id_reused' | 'nonce_reused') {
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
    const p = this.read().pins[did];
    return p ? { seq: p.seq, hash: p.hash } : null;
  }

  /**
   * Move the pin forward after the whole chain was verified. Same head: nothing. Lower: rollback. Same number,
   * other hash: fork. This computer's OWN chain head is never moved here: only sign-in, which verifies the chain
   * against the Authority Server's session, moves it ('own_chain').
   * When the table is full the oldest pin goes, but never one of `keep` (the signed identities of the mandates
   * currently cached); with nothing left to drop it is 'full'.
   */
  advance(did: string, head: ChainHeadRef, keep: readonly string[] = []): ChainHeadRef {
    if (!isDid(did) || !isInt(head?.seq) || !isHash(head?.hash)) throw new PinRefusedError('bad_request');
    const mine = this.own.read();
    if (mine && mine.rootDid === did) throw new PinRefusedError('own_chain');
    const file = this.read();
    const cur = file.pins[did];
    if (cur) {
      if (head.seq < cur.seq) throw new PinRefusedError('rollback');
      if (head.seq === cur.seq) {
        if (head.hash !== cur.hash) throw new PinRefusedError('fork');
        return { seq: cur.seq, hash: cur.hash };
      }
    } else if (Object.keys(file.pins).length >= MAX_PINS) {
      const protectedDids = new Set(keep.filter(isDid));
      const victim = Object.entries(file.pins)
        .filter(([d]) => !protectedDids.has(d))
        .sort((x, y) => (x[1].at ?? 0) - (y[1].at ?? 0))[0];
      if (!victim) throw new PinRefusedError('full');
      delete file.pins[victim[0]];
    }
    file.pins[did] = { seq: head.seq, hash: head.hash, at: Math.floor(Date.now() / 1000) };
    this.vault.setSecretSlot(SLOT, file);
    return { seq: head.seq, hash: head.hash };
  }

  /**
   * Record that this proposal is about to run on these decisions (their nonces), sealed and bounded.
   * The same proposal with the same decisions again is fine (a retry; the execution journal decides what runs).
   * The same proposal id with OTHER decisions, or a nonce already used for another proposal, is refused.
   */
  consume(proposalId: string, nonces: readonly string[]): void {
    if (typeof proposalId !== 'string' || !proposalId || proposalId.length > 128
      || nonces.length === 0 || nonces.length > 32 || !nonces.every(n => typeof n === 'string' && n.length > 0 && n.length <= 64)) {
      throw new PinRefusedError('bad_request');
    }
    const raw = this.vault.getSecretSlot<unknown>(LEDGER_SLOT);
    let f: LedgerFile = { v: 1, proposals: [], nonces: [] };
    if (raw !== null) {
      const r = raw as Partial<LedgerFile>;
      if (r?.v !== 1 || !Array.isArray(r.proposals) || !Array.isArray(r.nonces)) throw new Error('The stored ledger cannot be read');
      f = r as LedgerFile;
    }
    const mine = [...new Set(nonces)].sort();
    const prior = f.proposals.find(p => p.id === proposalId);
    if (prior) {
      if (JSON.stringify([...prior.nonces].sort()) === JSON.stringify(mine)) return;
      throw new PinRefusedError('proposal_id_reused');
    }
    const seen = new Set(f.nonces);
    if (mine.some(n => seen.has(n))) throw new PinRefusedError('nonce_reused');
    f.proposals.push({ id: proposalId, nonces: mine });
    f.nonces.push(...mine);
    if (f.proposals.length > MAX_LEDGER) f.proposals = f.proposals.slice(-MAX_LEDGER);
    if (f.nonces.length > MAX_LEDGER * 8) f.nonces = f.nonces.slice(-MAX_LEDGER * 8);
    this.vault.setSecretSlot(LEDGER_SLOT, f);
  }
}
