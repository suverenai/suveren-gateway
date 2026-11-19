/**
 * Who can read a proposal, taken from device chains this gateway verified itself (device-keys plan 5, DEC-73;
 * build step 8, computer part).
 *
 * For each reader DID of a proposal (the mandate owner and every signed decider):
 *   - THIS gateway's own person: every active device of the own chain, verified from the genesis on against the
 *     head this gateway stored. This computer's reading key is the one in the vault, and it must equal the
 *     `read_pub` of this computer's record in the chain; the Authority Server's word never decides it.
 *   - another person WITH a chain: every active device of that chain, verified from the genesis on against the
 *     DID the signed mandate names and the head pinned before (lib/device-pin-store.ts). The pin moves only
 *     after the whole chain verified.
 *   - another person WITHOUT a chain (the Authority Server has none for this DID): `legacy`, the caller wraps to
 *     the legacy key as today. A mandate does not mix accounts with and without a chain after switch day (DEC-52).
 *   - a person whose chain fails verification, shows a fork or a rollback, or whose reading key is unusable:
 *     `unreadable`, with a code, and a doorbell event for the page. No wrap is made for them.
 *
 * Never logged: a chain, a key, a wrap. Only the codes below.
 *
 * Downgrade guard: "no chain" is the Authority Server's word and can be a lie. A DID this gateway has EVER verified a
 * chain for (it has a pin), or that the team's verified member list names (port `teamMembers`, DEC-73), is never
 * given the legacy wrap: a 404 for it is an alarm (`chain_missing`) and the person is unreadable. The legacy wrap
 * is only for a DID that is neither pinned nor a verified member.
 *
 * KNOWN LIMITS (stated in the release notes, not closed by this code):
 *  - First sight of a person's chain is verified against their DID but pinned only from then on (trust on first use):
 *    an Authority Server that has served a person's chain to this gateway NEVER, can present a forged one made with a
 *    DID of its own choosing only if the mandate names that DID, which the owner's signed grant covers. Until the team
 *    member list (DEC-73) is wired, a colleague who was never seen has no second anchor.
 *  - The Authority Server can withhold a wrap, drop the card context, or serve a person an older state of the list:
 *    the person then sees "not yet openable" and cannot read; it can never make anyone read what they should not.
 *  - A person's chain is verified when a proposal is made and when it is re-wrapped, not continuously: a device
 *    removed a moment ago can still hold a wrap of a proposal made just before its removal (content, not authority).
 */
import type { ChainState, DeviceState } from '@hap/core/device-keys';
import type { Vault } from './vault';
import type { DeviceChainStore } from './device-chain-store';
import type { DeviceAsClient } from './device-as-client';
import { AsUnreachableError } from './device-as-client';
import { AsTlsMismatchError } from './as-tls-pin';
import { isBearerCredential } from './as-credential';
import { deviceKeys, isDeviceKeysError } from './device-keys-lazy';
import { PinRefusedError, type DevicePinStore } from './device-pin-store';

/**
 * Why a person is listed as unreadable. Codes, not sentences: the page's wording is the maintainer's (approval-card
 * `S8`, all DRAFT). `chain_invalid`, `chain_fork`, `chain_rollback` and `head_mismatch` are ALARMS: the Authority
 * Server served something that is not what this gateway verified before, or is not a chain at all. The others are
 * outages: nothing is wrong, the person cannot be reached right now.
 */
export type UnreadableCode =
  | 'chain_invalid' | 'chain_fork' | 'chain_rollback' | 'head_mismatch'
  | 'chain_missing' | 'not_a_team_member'
  | 'no_active_device' | 'device_key_invalid'
  | 'as_answer_invalid' | 'as_unreachable' | 'not_signed_in';

export const ALARM_CODES: ReadonlySet<UnreadableCode> = new Set(['chain_invalid', 'chain_fork', 'chain_rollback', 'head_mismatch', 'chain_missing', 'not_a_team_member']);

export interface ReaderDevice {
  keyId: string;
  /** Raw X25519 reading public key, 32 bytes. */
  readPub: Uint8Array;
  addedSeq: number;
}

export interface ResolvedReaders {
  /** DID → active devices, the one with the lowest `added_seq` first. */
  chain: Map<string, ReaderDevice[]>;
  /** DIDs for which the Authority Server holds no chain: the legacy wrap applies. */
  legacy: string[];
  unreadable: Array<{ did: string; code: UnreadableCode }>;
}

/** The gateway's own chain cannot be used: no proposal is encrypted (a proposal its own submitter cannot read must not exist). */
export class OwnChainError extends Error {
  constructor(readonly code: 'locked' | 'not_set_up' | 'not_signed_in' | 'chain_unreadable' | 'chain_invalid' | 'chain_fork' | 'chain_rollback' | 'device_removed' | 'key_mismatch' | 'as_unreachable' | 'as_answer_invalid') {
    super(code);
    this.name = 'OwnChainError';
  }
}

export interface DeviceReadersDeps {
  vault: Vault;
  store: DeviceChainStore;
  client: DeviceAsClient;
  pins: DevicePinStore;
  /** A person's chain failed verification: the page's doorbell. Never fails the encryption. */
  onAlarm?: (did: string, code: UnreadableCode) => void;
  /**
   * DEC-73 port: the DIDs of the team's VERIFIED member list (admin-signed, checked against the member's anchor), or null when
   * there is no verified list (no team, or the team-trust code is not merged). Until it is wired it answers null. When it
   * answers a set: every decider must be in it (else `not_a_team_member`), and a member with no chain is never given the
   * legacy wrap (`chain_missing`).
   */
  teamMembers?: () => Promise<ReadonlySet<string> | null>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

type Fetched = { kind: 'ok'; state: ChainState } | { kind: 'none' } | { kind: 'bad'; code: UnreadableCode };

export class DeviceReaders {
  constructor(private readonly d: DeviceReadersDeps) {}

  /** Does this gateway have a device chain (and so encrypt to devices)? Fails closed on an unreadable slot. */
  active(): boolean {
    return this.d.store.exists();
  }

  /** A person's chain, verified from the genesis on against `did` and `pin`. */
  private async fetchChain(did: string, credential: string, pin: { seq: number; hash: string } | null): Promise<Fetched> {
    const dk = await deviceKeys();
    let got;
    try {
      got = await this.d.client.call('GET', `/api/devices/chain?did=${encodeURIComponent(did)}`, { bearer: credential });
    } catch (e) {
      if (e instanceof AsTlsMismatchError) throw e;
      if (e instanceof AsUnreachableError) return { kind: 'bad', code: 'as_unreachable' };
      throw e;
    }
    if (got.status === 404) return { kind: 'none' };
    if (got.status !== 200 || !isObj(got.body) || !Array.isArray(got.body.entries)) return { kind: 'bad', code: 'as_answer_invalid' };
    let state: ChainState;
    try {
      state = await dk.verifyChain({ expectedRootDid: did, entries: got.body.entries, storedHead: pin });
    } catch (e) {
      if (isDeviceKeysError(e)) return { kind: 'bad', code: e.code === 'ROLLBACK' ? 'chain_rollback' : e.code === 'FORK' ? 'chain_fork' : 'chain_invalid' };
      throw e;
    }
    const named = isObj(got.body.head) ? got.body.head : null;
    if (!named || named.seq !== state.head.seq || named.hash !== state.head.hash) return { kind: 'bad', code: 'head_mismatch' };
    return { kind: 'ok', state };
  }

  private async devicesOf(state: ChainState): Promise<ReaderDevice[] | null> {
    const dk = await deviceKeys();
    const out: ReaderDevice[] = [];
    for (const dev of dk.activeDevices(state) as DeviceState[]) {
      let pub: Uint8Array;
      try { pub = dk.b64uBytes(dev.read_pub, 32, 'read_pub'); } catch { return null; }
      out.push({ keyId: dev.key_id, readPub: pub, addedSeq: dev.added_seq });
    }
    out.sort((a, b) => a.addedSeq - b.addedSeq);
    return out;
  }

  /** The signed-in credential, or a refusal that stops the whole encryption. */
  private credential(): string {
    if (!this.d.vault.isUnlocked()) throw new OwnChainError('locked');
    const c = this.d.vault.getSpCookie();
    if (!isBearerCredential(c)) throw new OwnChainError('not_signed_in');
    return c;
  }

  /**
   * This person's own chain, verified from the genesis on against the stored head, with this computer's
   * record checked against the vault's reading key.
   * @param ownReadPub the reading PUBLIC key held in this gateway's vault.
   */
  async own(ownReadPub: Uint8Array): Promise<{ rootDid: string; keyId: string; devices: ReaderDevice[]; state: ChainState }> {
    let stored;
    try { stored = this.d.store.read(); } catch { throw new OwnChainError('chain_unreadable'); }
    if (!stored) throw new OwnChainError('not_set_up');
    const credential = this.credential();
    const got = await this.fetchChain(stored.rootDid, credential, stored.head);
    if (got.kind === 'none') throw new OwnChainError('chain_invalid');
    if (got.kind === 'bad') {
      throw new OwnChainError(got.code === 'chain_fork' || got.code === 'chain_rollback' || got.code === 'chain_invalid' ? got.code : got.code === 'as_unreachable' ? 'as_unreachable' : got.code === 'head_mismatch' ? 'chain_invalid' : 'as_answer_invalid');
    }
    const dk = await deviceKeys();
    if (!dk.isActive(got.state, stored.keyId)) throw new OwnChainError('device_removed');
    const devices = await this.devicesOf(got.state);
    if (!devices) throw new OwnChainError('chain_invalid');
    const me = devices.find(x => x.keyId === stored.keyId);
    if (!me || Buffer.compare(Buffer.from(me.readPub), Buffer.from(ownReadPub)) !== 0) throw new OwnChainError('key_mismatch');
    return { rootDid: stored.rootDid, keyId: stored.keyId, devices, state: got.state };
  }

  /**
   * The devices of every reader DID. The own person comes from {@link own}; anyone else from their verified chain.
   * A reader that cannot be verified is `unreadable`, never skipped silently and never trusted.
   */
  async resolve(readerDids: readonly string[], ownReadPub: Uint8Array, opts: { deciders?: readonly string[] } = {}): Promise<ResolvedReaders & { self: { rootDid: string; keyId: string } }> {
    const me = await this.own(ownReadPub);
    const credential = this.credential();
    let members: ReadonlySet<string> | null = null;
    try { members = (await this.d.teamMembers?.()) ?? null; } catch { members = null; }
    const out: ResolvedReaders = { chain: new Map(), legacy: [], unreadable: [] };
    const dids = [...new Set([me.rootDid, ...readerDids])];
    for (const did of dids) {
      if (did === me.rootDid) { out.chain.set(did, me.devices); continue; }
      // An approver who is not on the team's verified member list is no reader (the Authority Server's list is not enough).
      if (members && (opts.deciders ?? []).includes(did) && !members.has(did)) { this.mark(out, did, 'not_a_team_member'); continue; }
      let pin: { seq: number; hash: string } | null;
      try { pin = this.d.pins.get(did); } catch { out.unreadable.push({ did, code: 'chain_invalid' }); continue; }
      const got = await this.fetchChain(did, credential, pin);
      if (got.kind === 'none') {
        // "No chain" for a DID seen with one, or named by the verified member list, is a downgrade attempt, never a legacy reader.
        if (pin !== null || members?.has(did)) { this.mark(out, did, 'chain_missing'); continue; }
        out.legacy.push(did);
        continue;
      }
      if (got.kind === 'bad') { this.mark(out, did, got.code); continue; }
      try {
        this.d.pins.advance(did, got.state.head, readerDids.filter(x => x !== did));
      } catch (e) {
        const reason = e instanceof PinRefusedError ? e.reason : '';
        this.mark(out, did, reason === 'rollback' ? 'chain_rollback' : reason === 'fork' ? 'chain_fork' : 'chain_invalid');
        continue;
      }
      const devices = await this.devicesOf(got.state);
      if (!devices) { this.mark(out, did, 'device_key_invalid'); continue; }
      if (devices.length === 0) { this.mark(out, did, 'no_active_device'); continue; }
      out.chain.set(did, devices);
    }
    return { ...out, self: { rootDid: me.rootDid, keyId: me.keyId } };
  }

  private mark(out: ResolvedReaders, did: string, code: UnreadableCode): void {
    out.unreadable.push({ did, code });
    if (ALARM_CODES.has(code)) {
      try { this.d.onAlarm?.(did, code); } catch { /* an alarm that fails to show never fails an encryption */ }
    }
  }
}
