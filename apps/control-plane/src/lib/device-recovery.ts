/**
 * Root-signed chain entries made from this computer, and the cancel of a request for a new
 * identity (device-keys plan 10, 3.2, DEC-15, DEC-21, DEC-33, DEC-37; build step 7, gateway
 * side). Logic only; routes/device-recovery.ts is the API. The screens and their words are
 * not built (O19); every code is neutral.
 *
 *   recover      "Everything lost, code kept": the person types the recovery code on a fresh
 *                gateway. The root key is derived and signs a `reset` that makes THIS computer
 *                the only device (kind `gateway`, with its check key when the person asked for
 *                one). The Authority Server appends it only with the person's email-link
 *                session, which stays in the browser: lib/device-recovery-contract.ts.
 *   rotate-root  "Recovery code exposed or to be replaced" (DEC-37): a NEW code, signed by the
 *                old root key and by this computer as a granting device (signature AND check).
 *   set          "Turn on Touch ID for approvals": a computer set up without a check key (no Touch ID helper at
 *                set-up) gets one. The root key signs a `set` naming this computer and its NEW platform check
 *                key; the new key checks the entry (its one touch). Appended only with the email link (DEC-15).
 *   cancel       A pending request for a new identity (the alarm of lib/identity-reset-alarm.ts)
 *                is cancelled by a `suveren-identity-cancel` this computer signs, with its check
 *                where the chain gives it one.
 *
 * Secrets. The recovery code is read from the request, turned into a seed and a root key, and
 * the seed and the root private key are zeroed as soon as the entry is signed (in `finally`,
 * whatever happened). The code is NEVER stored (not in the vault, not in the pending state),
 * logged, or sent: the lookup carries a signature made with the root key, the entry carries
 * signatures, nothing carries the code. JavaScript cannot zero a string: the text of the
 * code lives in the request body until the garbage collector takes it; the routes drop their
 * reference as soon as the work is done. The check key is held by the helper; only its
 * opaque blob is stored, as in lib/device-setup.ts.
 *
 * What is NOT taken on trust from the Authority Server: the chain it serves (verified from the
 * genesis on with hap-core, and refused unless the root key in force at its head is the key
 * the typed code derives), its answer to the stage (shape-checked), the redirect (the outcome
 * is read from a redeem AND from the chain, and compared with the entry this computer built),
 * and what it says about the account (this gateway shows the labels of the verified chain).
 *
 * One flow at a time. A second start is refused (`recovery_pending`), not queued.
 */

import { timingSafeEqual, randomBytes } from 'node:crypto';
import type { ChainEntry, ChainState } from '@hap/core/device-keys';
import { platformCheckKey, platformCheckProof } from '@suveren/unlock-helper';
import { deviceKeys, isDeviceKeysError } from './device-keys-lazy';
import type { Vault } from './vault';
import { loadOrGenerateKeyPair, loadOrGenerateDeviceSigningKey, loadDeviceSigningKey } from './e2e-key-manager';
import { type DeviceChainStore, type StoredDeviceChain, ChainHeadRefusedError } from './device-chain-store';
import { DeviceAsClient, AsUnreachableError, asErrorCode, type AsReply } from './device-as-client';
import { AsTlsMismatchError } from './as-tls-pin';
import type { DeviceSignin, AsKeyCheck } from './device-signin';
import { CheckKeyStore, CheckError, type PlatformChecks, type StoredCheckKey } from './platform-checks';
import { isBearerCredential } from './as-credential';
import { SetupRefusal } from './device-setup';
import { LoopbackHandoff } from './loopback-handoff';
import type { IdentityResetAlarm } from './identity-reset-alarm';
import {
  RECOVERY_PATHS, LOOKUP_TYP, HANDOFF_TTL_SECONDS, pageUrl, confirmCodeOf,
  readLookupResponse, readRedeemResponse, readStageResponse,
  type RecoveryLookup, type RecoveryLookupRequest, type StageRequest, type RedeemRequest,
} from './device-recovery-contract';

export const RECOVERY_LABEL = 'This computer';
/** How long a new recovery code waits to be used (rotate-root). Proposed number. */
export const ROTATE_PREPARE_TTL_MS = 30 * 60_000;

/** The vault slot that keeps a started recovery across a lock or a restart. No secret is in it. */
const PENDING_SLOT = 'deviceRecoveryPending';
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

interface Flow {
  id: string;
  kind: 'reset' | 'rotate' | 'set';
  entry: ChainEntry;
  entryHash: string;
  rootDid: string;
  keyId: string;
  label: string;
  /** The check key made for a `reset` or a `set` (moved into its slot when the chain is stored / the entry is in it). */
  checkKey?: StoredCheckKey;
  /** Memory only: the verifier and the state are never kept across a lock. */
  handoff: LoopbackHandoff | null;
  confirmCode: string;
  /** Epoch ms: when the staged hand-off ends. Kept in the sealed slot. */
  expiresAt: number;
}

interface Prepared { id: string; newPub: string; expiresAt: number }

export interface DeviceRecoveryDeps {
  vault: Vault;
  store: DeviceChainStore;
  client: DeviceAsClient;
  signin: DeviceSignin;
  checkAs: () => Promise<AsKeyCheck>;
  alarm: IdentityResetAlarm;
  /** Is a first set-up (lib/device-setup.ts) started and not finished? A recovery and a set-up never run together. */
  setupPending: () => boolean;
  /** Epoch ms. */
  now?: () => number;
  checks?: PlatformChecks;
  checkStore?: CheckKeyStore;
}

interface Completed {
  rootDid: string; deviceKeyId: string; head: { seq: number; hash: string }; signedIn: boolean; signinCode?: string;
}

const b64uEq = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function isStoredCheckKey(v: unknown): v is StoredCheckKey {
  const o = v as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && o.v === 1 && typeof o.backend === 'string' && typeof o.policy === 'string'
    && typeof o.keyBlob === 'string' && typeof o.publicKey === 'string';
}

/** A failure of the check key, as a refusal with a neutral code. Never the helper's own message. */
function checkRefusal(err: unknown): SetupRefusal {
  if (err instanceof SetupRefusal) return err;
  if (err instanceof CheckError) {
    const h = err.helperCode;
    if (err.code === 'helper_failed') {
      if (h && ['unsupported_platform', 'unsupported_arch', 'helper_not_installed', 'helper_modified', 'caller_refused'].includes(h)) return new SetupRefusal(409, 'helper_unavailable', { reason: h });
      if (h === 'bad_request') return new SetupRefusal(409, 'helper_unavailable', { reason: 'helper_too_old' });
      if (h === 'user_cancelled') return new SetupRefusal(409, 'cancelled');
      if (h === 'auth_failed') return new SetupRefusal(401, 'not_recognised');
      if (h === 'biometry_locked' || h === 'no_biometry' || h === 'key_invalid' || h === 'interaction_required') return new SetupRefusal(409, h);
      return new SetupRefusal(502, 'helper_failed', h ? { helperCode: h } : {});
    }
    if (err.code === 'no_biometry') return new SetupRefusal(409, 'no_biometry');
    if (err.code === 'check_invalid') return new SetupRefusal(502, 'check_invalid');
    return new SetupRefusal(409, 'helper_unavailable', { reason: err.code });
  }
  return new SetupRefusal(502, 'helper_failed');
}

export class DeviceRecovery {
  private flow: Flow | null = null;
  private prepared: Prepared | null = null;
  /** Held from the first await of a step to its end: a second call is refused, not queued. */
  private busy = false;
  private readonly now: () => number;

  constructor(private readonly d: DeviceRecoveryDeps) {
    this.now = d.now ?? Date.now;
    // A lock forgets what is in memory: the handoff, the verifier, a prepared new code.
    d.vault.onLocked(() => { this.flow = null; this.prepared = null; });
  }

  // ─── state ──────────────────────────────────────────────────────────────

  /** What the page needs; never a code, never a key. */
  status(): { recoveryPending: boolean; kind?: 'reset' | 'rotate' | 'set'; handoff?: 'waiting' | 'authorised' | 'failed' | 'expired'; confirmCode?: string } {
    const f = this.live();
    // A step that is running counts as pending: a set-up must not start under it.
    if (!f) return { recoveryPending: this.busy };
    const h = f.handoff;
    const handoff = !h ? undefined : h.expired(this.now()) ? 'expired' : h.status;
    return { recoveryPending: true, kind: f.kind, ...(handoff ? { handoff } : {}), confirmCode: f.confirmCode };
  }

  private persist(f: Flow | null): void {
    // The signed entry is public once staged; no code, no key, no verifier, no state is in the slot.
    this.d.vault.setSecretSlot(PENDING_SLOT, f
      ? { v: 1, kind: f.kind, id: f.id, entry: f.entry, entryHash: f.entryHash, rootDid: f.rootDid, keyId: f.keyId, label: f.label, confirmCode: f.confirmCode, expiresAt: f.expiresAt, ...(f.checkKey ? { checkKey: f.checkKey } : {}) }
      : null);
  }

  /** The flow in memory, or a `reset` that survived a lock or a restart in its sealed slot. */
  private live(): Flow | null {
    if (this.flow || !this.d.vault.isUnlocked()) return this.flow;
    let raw: Record<string, unknown> | null = null;
    try { raw = this.d.vault.getSecretSlot<Record<string, unknown>>(PENDING_SLOT); } catch { return null; }
    if (!raw || raw.v !== 1) return null;
    const { id, entry, entryHash, rootDid, keyId, label, checkKey, confirmCode, kind, expiresAt } = raw;
    if (kind !== 'reset' && kind !== 'rotate' && kind !== 'set') return null;
    // A chain is stored: a `reset` slot is a leftover (a crash between storing the chain and clearing the slot).
    // A `rotate` slot belongs to a chain that is stored; it stays until finished, cancelled or dropped.
    if (kind === 'reset' && this.d.store.exists()) return null;
    if (typeof expiresAt !== 'number') return null;
    if (typeof id !== 'string' || typeof entryHash !== 'string' || typeof rootDid !== 'string' || typeof keyId !== 'string' || typeof label !== 'string' || typeof confirmCode !== 'string' || !entry || typeof entry !== 'object') return null;
    // A check key that is there but is not one this code wrote makes the whole pending recovery unusable: never "no check key".
    if (checkKey !== undefined && !isStoredCheckKey(checkKey)) return null;
    this.flow = { id, kind, entry: entry as ChainEntry, entryHash, rootDid, keyId, label, confirmCode, expiresAt, handoff: null, ...(checkKey ? { checkKey } : {}) };
    return this.flow;
  }

  private requireUnlocked(): void {
    if (!this.d.vault.isUnlocked()) throw new SetupRefusal(401, 'locked');
    if (!this.d.vault.hasPassword()) throw new SetupRefusal(409, 'password_required');
    if (this.d.vault.hasPendingRekey()) throw new SetupRefusal(409, 'rekey_pending');
  }

  private flowFor(id: unknown): Flow {
    const f = this.live();
    if (!f || typeof id !== 'string' || !b64uEq(id, f.id)) throw new SetupRefusal(404, 'recovery_unknown');
    return f;
  }

  // ─── 1. recover: a `reset` from a fresh gateway ──────────────────────────

  async recoverStart(input: { code: unknown; label?: unknown; checkKey?: unknown; port: number; sessionId: string; localAddress?: string }): Promise<{
    recoveryId: string; pageUrl: string; checkEmail: true; sameBrowser: true; confirmCode: string; expiresAt: number; rootDid: string;
    /** The devices this will remove, from the VERIFIED chain, as plain text. */
    removes: Array<{ label: string; kind: string }>;
    /** A request for a new identity is open on the account (the Authority Server said so at the lookup); this recovery closes it. */
    pendingIdentityReset?: { id: string; effectiveAt: number };
  } | ({ adopted: true } & Completed)> {
    this.requireUnlocked();
    this.dropExpiredRotate();
    if (this.d.store.exists()) throw new SetupRefusal(409, 'already_set_up');
    if (this.d.setupPending()) throw new SetupRefusal(409, 'setup_pending');
    if (this.busy) throw new SetupRefusal(409, 'setup_busy');
    if (this.live()) throw new SetupRefusal(409, 'recovery_pending');
    this.checkLoopback(input.port, input.sessionId, input.localAddress);
    this.busy = true;
    let rootSeed: Uint8Array | null = null;
    try {
      const dk = await deviceKeys();
      const label = input.label === undefined ? RECOVERY_LABEL : input.label;
      if (!dk.isValidLabel(label)) throw new SetupRefusal(400, 'label_invalid');
      if (input.checkKey !== undefined && typeof input.checkKey !== 'boolean') throw new SetupRefusal(400, 'bad_request');
      if (input.checkKey === true && !this.d.checks) throw new SetupRefusal(409, 'helper_unavailable');
      const root = await this.rootKeyOf(dk, input.code);
      rootSeed = root.privateSeed;

      // The Authority Server proves it holds its key before anything signed is sent to it.
      const key = await this.d.checkAs();
      if (!key.ok) throw new SetupRefusal(key.code === 'as_key_mismatch' || key.code === 'as_tls_mismatch' ? 409 : 502, key.code);

      // 1. lookup: possession of the code is shown by a signature, the code is not sent.
      const lookup: RecoveryLookup = { typ: LOOKUP_TYP, v: 1, aud: key.publicKeyHex, root_pub: dk.b64uEncode(root.publicKey), issued_at: this.nextLookupTime() };
      const body: RecoveryLookupRequest = { lookup, sig: await dk.signObject(lookup, root.privateSeed) };
      const reply = await this.asCall('POST', RECOVERY_PATHS.lookup, { body });
      if (reply.status === 404) throw new SetupRefusal(404, 'recovery_code_unknown');
      this.refuseOnStatus(reply, 200, 'recovery_refused');
      const found = readLookupResponse(reply.body);
      if (!found) throw new SetupRefusal(502, 'as_answer_invalid');

      // The chain is checked, not believed: from the genesis on, and it must be a chain THIS code controls.
      let state: ChainState;
      try {
        state = await dk.verifyChain({ expectedRootDid: found.root_did, entries: found.entries });
      } catch (e) {
        if (isDeviceKeysError(e)) throw new SetupRefusal(502, 'chain_invalid', { asCode: e.code });
        throw e;
      }
      if (state.head.seq !== found.head.seq || state.head.hash !== found.head.hash) throw new SetupRefusal(502, 'head_mismatch');
      if (state.root_pub !== dk.b64uEncode(root.publicKey)) throw new SetupRefusal(404, 'recovery_code_unknown');

      const signing = await loadOrGenerateDeviceSigningKey(this.d.vault);
      const reading = await loadOrGenerateKeyPair(this.d.vault);
      const signPub = dk.b64uEncode(signing.publicKey);
      const readPub = dk.b64uEncode(reading.publicKey);
      // This computer is ALREADY the active device of this chain (a recovery whose answer was lost, a cancelled
      // one the Authority Server had already appended): there is nothing to append, the chain is taken over. The
      // chain was verified against the typed code above, so the Authority Server cannot make this up.
      const mine = Object.values(state.devices).find(x => x.sign_pub === signPub && x.read_pub === readPub);
      if (mine && mine.removed_seq === null) {
        return { adopted: true, ...await this.adopt(dk, state, found.root_did, mine) };
      }
      // A key that ever appeared in this chain cannot be admitted again (KEY_REUSED): say so before anything is signed.
      if (Object.values(state.devices).some(x => x.sign_pub === signPub || x.read_pub === readPub)) throw new SetupRefusal(409, 'device_key_in_chain');

      // This computer's check key: only on request, never silently.
      let checkKey: StoredCheckKey | undefined;
      if (input.checkKey === true) {
        try { checkKey = await this.d.checks!.createKey(); } catch (err) { throw checkRefusal(err); }
      }
      const device = await dk.buildDeviceRecord({
        sign_pub: signPub, read_pub: readPub, kind: 'gateway', label, keystore: 'software',
        ...(checkKey ? { check: platformCheckKey(checkKey.publicKey) } : {}),
      }, signing.publicKey);
      const entry = dk.buildEntry({
        root_did: found.root_did, seq: state.head.seq + 1, prev: state.head.hash, op: 'reset',
        created_at: Math.floor(this.now() / 1000), signer: 'root', device,
      });
      entry.sigs.push(await dk.signEntry(entry, 'root', root.privateSeed));
      entry.sigs.push(await dk.signEntry(entry, device.key_id, signing.privateSeed));
      rootSeed.fill(0); // nothing after this signs with the root key
      if (checkKey) {
        // The device proves it holds its check key: its check over the same entry (3.2, reset). One touch.
        let signed;
        try { signed = await this.d.checks!.sign(checkKey, dk.entrySignedBytes(entry)); } catch (err) { throw checkRefusal(err); }
        entry.checks.push({ by: device.key_id, check: platformCheckProof(signed.signature) });
      }
      // Our own check, exactly the Authority Server's: an entry it would refuse is never offered to the person.
      try {
        await dk.verifyChain({ expectedRootDid: found.root_did, entries: [...found.entries, entry] });
      } catch (e) {
        if (isDeviceKeysError(e)) throw new SetupRefusal(409, 'entry_invalid', { asCode: e.code });
        throw e;
      }
      const removes = dk.activeDevices(state).map(x => ({ label: x.label, kind: x.kind }));
      const hash = await dk.entryHash(entry);
      const f: Flow = {
        id: randomBytes(16).toString('base64url'), kind: 'reset', entry, entryHash: hash, rootDid: found.root_did,
        keyId: device.key_id, label, handoff: null, confirmCode: confirmCodeOf(hash), expiresAt: 0, ...(checkKey ? { checkKey } : {}),
      };
      this.requireUnlocked();
      if (this.d.store.exists()) throw new SetupRefusal(409, 'already_set_up'); // the state may have changed while the keys were made
      // The touch and the Authority Server took time: a set-up may have been started meanwhile.
      if (this.d.setupPending()) throw new SetupRefusal(409, 'setup_pending');
      const handed = await this.stage(f, input.port, input.sessionId);
      this.persist(f);
      this.flow = f;
      return {
        recoveryId: f.id, ...handed, rootDid: f.rootDid, removes,
        ...(found.pending_identity_reset ? { pendingIdentityReset: { id: found.pending_identity_reset.id, effectiveAt: found.pending_identity_reset.effective_at } } : {}),
      };
    } finally {
      // The root key signed one entry and is not needed again, whatever happened.
      rootSeed?.fill(0);
      this.busy = false;
    }
  }

  /** A seed from the typed code, and the root key from it. The seed is zeroed here. */
  private async rootKeyOf(dk: Awaited<ReturnType<typeof deviceKeys>>, code: unknown) {
    if (typeof code !== 'string' || code.length === 0 || code.length > 200) throw new SetupRefusal(400, 'recovery_code_invalid');
    let seed: Uint8Array;
    try {
      seed = await dk.parseRecoveryCode(code);
    } catch (e) {
      if (isDeviceKeysError(e)) throw new SetupRefusal(400, 'recovery_code_invalid');
      throw e;
    }
    try {
      return await dk.deriveRootKey(seed);
    } finally {
      seed.fill(0);
    }
  }

  private checkLoopback(port: number, sessionId: string, localAddress?: string): void {
    if (!sessionId) throw new SetupRefusal(401, 'unauthorized');
    // The Authority Server redirects to http://127.0.0.1:<port>. A gateway that listens on ::1 only would never receive it.
    if (localAddress !== '127.0.0.1' && localAddress !== '::ffff:127.0.0.1') throw new SetupRefusal(409, 'connect_loopback_unsupported');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new SetupRefusal(409, 'connect_port_unsupported');
  }

  /**
   * This computer is the active device of the verified chain: take it over (store the head, sign in). A check key
   * the chain names for this computer must be the one in this vault, or it is refused (never a chain that says
   * "check key" on a computer that has none to show).
   */
  private async adopt(dk: Awaited<ReturnType<typeof deviceKeys>>, state: ChainState, rootDid: string, mine: ChainState['devices'][string]): Promise<Completed> {
    if (mine.check) {
      let held: StoredCheckKey | null = null;
      try { held = this.d.vault.getSecretSlot<StoredCheckKey>('deviceCheckKey'); } catch { held = null; }
      if (!held || !isStoredCheckKey(held) || mine.check.type !== 'platform' || mine.check.pub !== held.publicKey) throw new SetupRefusal(409, 'check_unavailable');
    }
    this.d.store.create({
      v: 1, rootDid, keyId: mine.key_id, head: { seq: state.head.seq, hash: state.head.hash },
      asUrl: this.d.client.asUrl, label: mine.label, setUpAt: Math.floor(this.now() / 1000),
    });
    try { this.persist(null); } catch { /* nothing kept */ }
    this.flow = null;
    void dk;
    const r = await this.d.signin.signIn();
    return { rootDid, deviceKeyId: mine.key_id, head: { seq: state.head.seq, hash: state.head.hash }, signedIn: r.ok, ...(r.ok ? {} : { signinCode: r.code }) };
  }

  /** Post the signed entry to the Authority Server (which emails the person a single-use link) and say where to look. */
  private async stage(f: Flow, port: number, sessionId: string): Promise<{ pageUrl: string; checkEmail: true; sameBrowser: true; confirmCode: string; expiresAt: number }> {
    const h = new LoopbackHandoff(port, sessionId, this.now() + HANDOFF_TTL_SECONDS * 1000);
    const body: StageRequest = { entry: f.entry, code_challenge: h.challenge, port, state_hash: h.stateHash };
    const reply = await this.asCall('POST', RECOVERY_PATHS.stage, { body });
    this.refuseOnStatus(reply, 201, 'recovery_refused');
    const staged = readStageResponse(reply.body, Math.floor(this.now() / 1000));
    if (!staged) throw new SetupRefusal(502, 'as_answer_invalid');
    h.handoffId = staged.handoff_id;
    h.expiresAt = Math.min(h.expiresAt, staged.expires_at * 1000);
    f.handoff = h;
    f.expiresAt = h.expiresAt;
    return {
      pageUrl: pageUrl(this.d.client.asUrl, { handoffId: staged.handoff_id, port, state: h.stateText }),
      checkEmail: true,
      sameBrowser: true,
      confirmCode: f.confirmCode,
      expiresAt: h.expiresAt,
    };
  }

  // ─── 2. rotate-root ─────────────────────────────────────────────────────

  /** Make a new recovery code and show it once. Only its PUBLIC key is kept (in memory), to check the copy. */
  async rotateStart(): Promise<{ rotateId: string; recoveryCode: string; expiresAt: number }> {
    this.requireUnlocked();
    this.dropExpiredRotate();
    if (!this.d.store.exists()) throw new SetupRefusal(409, 'not_set_up');
    if (this.busy) throw new SetupRefusal(409, 'setup_busy');
    if (this.live()) throw new SetupRefusal(409, 'recovery_pending');
    this.busy = true;
    let seed: Uint8Array | null = null;
    let privateSeed: Uint8Array | null = null;
    try {
      const dk = await deviceKeys();
      const made = await dk.generateRecoveryCode();
      seed = made.seed;
      const root = await dk.deriveRootKey(seed);
      privateSeed = root.privateSeed;
      const id = randomBytes(16).toString('base64url');
      this.prepared = { id, newPub: dk.b64uEncode(root.publicKey), expiresAt: this.now() + ROTATE_PREPARE_TTL_MS };
      return { rotateId: id, recoveryCode: made.code, expiresAt: this.prepared.expiresAt };
    } finally {
      seed?.fill(0);
      privateSeed?.fill(0);
      this.busy = false;
    }
  }

  async rotateSubmit(input: { rotateId: unknown; oldCode: unknown; newCode: unknown; port: number; sessionId: string; localAddress?: string }): Promise<{
    recoveryId: string; pageUrl: string; checkEmail: true; sameBrowser: true; confirmCode: string; expiresAt: number;
  }> {
    this.requireUnlocked();
    const stored = this.storedChain();
    this.dropExpiredRotate();
    if (this.busy) throw new SetupRefusal(409, 'setup_busy');
    if (this.live()) throw new SetupRefusal(409, 'recovery_pending');
    const prep = this.prepared;
    if (!prep || typeof input.rotateId !== 'string' || !b64uEq(input.rotateId, prep.id)) throw new SetupRefusal(404, 'rotate_unknown');
    if (prep.expiresAt <= this.now()) { this.prepared = null; throw new SetupRefusal(410, 'rotate_expired'); }
    this.checkLoopback(input.port, input.sessionId, input.localAddress);
    this.busy = true;
    let oldSeed: Uint8Array | null = null;
    try {
      const dk = await deviceKeys();
      // The person copied the new code: typing it again proves the copy is right BEFORE the old code is replaced.
      const newRoot = await this.rootKeyOf(dk, input.newCode);
      newRoot.privateSeed.fill(0);
      if (dk.b64uEncode(newRoot.publicKey) !== prep.newPub) throw new SetupRefusal(409, 'new_code_mismatch');
      const oldRoot = await this.rootKeyOf(dk, input.oldCode);
      oldSeed = oldRoot.privateSeed;

      const key = await this.d.checkAs();
      if (!key.ok) throw new SetupRefusal(key.code === 'as_key_mismatch' || key.code === 'as_tls_mismatch' ? 409 : 502, key.code);
      const { state, entries } = await this.ownChain(stored);
      if (state.root_pub !== dk.b64uEncode(oldRoot.publicKey)) throw new SetupRefusal(409, 'recovery_code_wrong');
      if (!dk.isActive(state, stored.keyId)) throw new SetupRefusal(409, 'device_removed');
      // The second signer must be a granting device: THIS computer, signature and check (3.2, DEC-37, DEC-47).
      const me = state.devices[stored.keyId];
      if (!me.check) throw new SetupRefusal(409, 'granting_device_required');
      if (!this.d.checks || !this.d.checkStore) throw new SetupRefusal(409, 'helper_unavailable');
      const checkKey = this.localCheckKeyFor(dk, me.check);
      const signing = loadDeviceSigningKey(this.d.vault);
      if (!signing || (await dk.keyIdOf(signing.publicKey)) !== stored.keyId) throw new SetupRefusal(409, 'key_mismatch');

      const entry = dk.buildEntry({
        root_did: stored.rootDid, seq: state.head.seq + 1, prev: state.head.hash, op: 'rotate-root',
        created_at: Math.floor(this.now() / 1000), signer: 'root', new_root: dk.b64uEncode(newRoot.publicKey),
      });
      entry.sigs.push(await dk.signEntry(entry, 'root', oldRoot.privateSeed));
      entry.sigs.push(await dk.signEntry(entry, stored.keyId, signing.privateSeed));
      oldSeed.fill(0);
      let signed;
      try { signed = await this.d.checks.sign(checkKey, dk.entrySignedBytes(entry)); } catch (err) { throw checkRefusal(err); }
      entry.checks.push({ by: stored.keyId, check: platformCheckProof(signed.signature) });
      try {
        await dk.verifyChain({ expectedRootDid: stored.rootDid, entries: [...entries, entry] });
      } catch (e) {
        if (isDeviceKeysError(e)) throw new SetupRefusal(409, 'entry_invalid', { asCode: e.code });
        throw e;
      }
      const hash = await dk.entryHash(entry);
      const f: Flow = {
        id: randomBytes(16).toString('base64url'), kind: 'rotate', entry, entryHash: hash, rootDid: stored.rootDid,
        keyId: stored.keyId, label: stored.label, handoff: null, confirmCode: confirmCodeOf(hash), expiresAt: 0,
      };
      this.requireUnlocked();
      const handed = await this.stage(f, input.port, input.sessionId);
      // The Authority Server took time: a lock in between ends it. Nothing is kept of a flow that cannot be sealed.
      this.requireUnlocked();
      this.persist(f);
      this.flow = f;
      this.prepared = null; // the new code is spent: a second submit needs a new code
      return { recoveryId: f.id, ...handed };
    } finally {
      oldSeed?.fill(0);
      this.busy = false;
    }
  }

  private lastLookupAt = 0;
  /**
   * `issued_at` of a lookup, in epoch seconds. The Authority Server answers a signed request once (the same
   * bytes again are an unknown key), and the clock has one-second steps: so it only ever rises.
   */
  private nextLookupTime(): number {
    this.lastLookupAt = Math.max(Math.floor(this.now() / 1000), this.lastLookupAt + 1);
    return this.lastLookupAt;
  }

  /** The stored check key, and only if it is the one the chain names for this computer. */
  private localCheckKeyFor(dk: Awaited<ReturnType<typeof deviceKeys>>, named: NonNullable<ChainState['devices'][string]['check']>): StoredCheckKey {
    let key: StoredCheckKey | null;
    try { key = this.d.checkStore!.read(); } catch { throw new SetupRefusal(409, 'check_unavailable'); }
    if (!key || !dk.checkKeysEqual(platformCheckKey(key.publicKey), named)) throw new SetupRefusal(409, 'check_unavailable');
    return key;
  }

  // ─── the callback (no page session; `state` authorises it) ───────────────

  /**
   * The system browser came back. What authorises this request is `state`: random, kept only here, tied to
   * one page session, single-use, ten minutes, checked HERE. The outcome is read later, by that page session.
   */
  async callback(query: { state?: unknown; code?: unknown; error?: unknown }): Promise<'accepted' | 'unknown'> {
    const f = this.flow;
    const h = f?.handoff;
    if (!f || !h || !h.take(query.state, this.now())) return 'unknown';
    if (typeof query.error === 'string') {
      h.status = 'failed';
      h.failure = { code: 'handoff_refused', ...(SAFE_CODE.test(query.error) ? { asCode: query.error } : {}) };
      return 'accepted';
    }
    if (typeof query.code !== 'string' || !query.code || query.code.length > 128) {
      h.status = 'failed';
      h.failure = { code: 'handoff_refused' };
      return 'accepted';
    }
    try {
      const body: RedeemRequest = { code: query.code, code_verifier: h.verifier };
      const reply = await this.asCall('POST', RECOVERY_PATHS.redeem, { body });
      const redeemed = reply.status === 200 ? readRedeemResponse(reply.body) : null;
      if (reply.status === 200 && !redeemed) {
        h.status = 'failed'; h.failure = { code: 'as_answer_invalid' };
      } else if (!redeemed) {
        h.status = 'failed';
        h.failure = { code: 'handoff_refused', ...(asErrorCode(reply.body) ? { asCode: asErrorCode(reply.body) } : {}) };
      } else if (redeemed.entry_hash !== f.entryHash || redeemed.head.seq !== f.entry.seq || redeemed.head.hash !== f.entryHash) {
        // Not the entry this computer built: nothing is believed (finish reads the chain itself).
        h.status = 'failed'; h.failure = { code: 'head_mismatch' };
      } else {
        h.status = 'authorised';
      }
    } catch (err) {
      h.status = 'failed';
      h.failure = { code: err instanceof AsTlsMismatchError ? 'as_tls_mismatch' : err instanceof AsUnreachableError ? 'as_unreachable' : 'handoff_failed' };
    }
    return 'accepted';
  }

  /** The page session that started the hand-off asks how it went. */
  handoffStatus(id: unknown, sessionId: string): { state: 'waiting' | 'authorised' | 'failed' | 'expired'; code?: string; asCode?: string } {
    const f = this.flowFor(id);
    const h = f.handoff;
    if (!h) throw new SetupRefusal(404, 'handoff_not_started');
    if (h.sessionId !== sessionId) throw new SetupRefusal(403, 'connect_other_session');
    if (h.expired(this.now())) return { state: 'expired', code: 'handoff_timeout' };
    if (h.status === 'failed') return { state: 'failed', code: h.failure!.code, ...(h.failure!.asCode ? { asCode: h.failure!.asCode } : {}) };
    return { state: h.status };
  }

  // ─── finish ─────────────────────────────────────────────────────────────

  /** `reset`: the Authority Server holds our entry. Verify, store the chain, sign in. */
  async recoverFinish(input: { recoveryId: unknown }): Promise<{
    rootDid: string; deviceKeyId: string; head: { seq: number; hash: string }; signedIn: boolean; signinCode?: string;
  }> {
    this.requireUnlocked();
    if (this.busy) throw new SetupRefusal(409, 'setup_busy');
    const f = this.flowFor(input.recoveryId);
    if (f.kind !== 'reset') throw new SetupRefusal(404, 'recovery_unknown');
    if (this.d.store.exists()) throw new SetupRefusal(409, 'already_set_up');
    this.busy = true;
    try {
      const key = await this.d.checkAs();
      if (!key.ok) throw new SetupRefusal(key.code === 'as_key_mismatch' || key.code === 'as_tls_mismatch' ? 409 : 502, key.code);
      // The Authority Server may hold our entry whether or not the redirect came back (a lock, a restart or a
      // closed tab). Find out by signing in with it: this verifies the whole chain with hap-core and that
      // this computer is active at a head that contains exactly the entry it built.
      const probe = await this.d.signin.performSignIn({ rootDid: f.rootDid, keyId: f.keyId, head: { seq: f.entry.seq, hash: f.entryHash } }, { storeHead: false, probe: true });
      if (!probe.ok) {
        const failed = f.handoff?.status === 'failed' ? f.handoff.failure : undefined;
        if (probe.code === 'as_unreachable' || probe.code === 'as_error' || probe.code === 'rate_limited' || probe.code === 'as_tls_mismatch') {
          throw new SetupRefusal(probe.code === 'rate_limited' ? 429 : probe.code === 'as_tls_mismatch' ? 409 : 502, probe.code);
        }
        throw new SetupRefusal(409, 'recovery_not_done', { signinCode: probe.code, ...(failed ? { handoffCode: failed.code, ...(failed.asCode ? { asCode: failed.asCode } : {}) } : {}) });
      }
      return await this.completeReset(f);
    } finally {
      this.busy = false;
    }
  }

  /** The Authority Server holds our `reset`: store the chain (check key's slot first), then sign in. */
  private async completeReset(f: Flow) {
    const asUrl = this.d.client.asUrl;
    // The check key's slot first: from the moment the chain says this computer has a check key, the password
    // is no longer a confirmation here. If the chain cannot be stored the slot is emptied again.
    if (f.checkKey) {
      if (!this.d.checkStore) throw new SetupRefusal(500, 'bad_request');
      this.d.checkStore.write(f.checkKey);
    }
    try {
      this.d.store.create({
        v: 1, rootDid: f.rootDid, keyId: f.keyId, head: { seq: f.entry.seq, hash: f.entryHash },
        asUrl, label: f.label, setUpAt: f.entry.created_at,
      });
    } catch (err) {
      if (f.checkKey) { try { this.d.checkStore!.write(null); } catch { /* the original error is the one to report */ } }
      throw err;
    }
    this.flow = null;
    try { this.persist(null); } catch { /* the chain is stored; an unreadable leftover is ignored once a chain exists */ }
    const r = await this.d.signin.signIn();
    return {
      rootDid: f.rootDid, deviceKeyId: f.keyId, head: { seq: f.entry.seq, hash: f.entryHash },
      signedIn: r.ok, ...(r.ok ? {} : { signinCode: r.code }),
    };
  }

  /** `rotate-root`: read the chain, check our entry is in it, move the stored head. */
  async rotateFinish(input: { recoveryId: unknown }): Promise<{ rootDid: string; head: { seq: number; hash: string } }> {
    this.requireUnlocked();
    const stored = this.storedChain();
    if (this.busy) throw new SetupRefusal(409, 'setup_busy');
    const f = this.flowFor(input.recoveryId);
    if (f.kind !== 'rotate') throw new SetupRefusal(404, 'recovery_unknown');
    this.busy = true;
    try {
      // After a restart the sign-in may not be through yet: this step is the person's own, so it asks for one.
      if (!isBearerCredential(this.d.vault.getSpCookie())) await this.d.signin.signIn();
      const { state } = await this.ownChain(stored);
      // Exactly the entry this computer built, at the place it built it for. A longer chain is fine (others may follow).
      if (state.hashes[f.entry.seq] !== f.entryHash) {
        const failed = f.handoff?.status === 'failed' ? f.handoff.failure : undefined;
        throw new SetupRefusal(409, 'recovery_not_done', failed ? { handoffCode: failed.code, ...(failed.asCode ? { asCode: failed.asCode } : {}) } : {});
      }
      try {
        this.d.store.advance(state.head);
      } catch (e) {
        if (e instanceof ChainHeadRefusedError) throw new SetupRefusal(409, e.reason === 'rollback' ? 'chain_rollback' : 'chain_fork');
        throw e;
      }
      this.flow = null;
      try { this.persist(null); } catch { /* locked: the slot is dropped at the next finish or cancel */ }
      return { rootDid: stored.rootDid, head: state.head };
    } finally {
      this.busy = false;
    }
  }

  // ─── 3. set: turn on Touch ID for approvals on a computer set up without it ──────────────

  /**
   * A computer set up without a check key gets one: the root key (from the typed recovery code) signs a `set` that names
   * THIS computer and a NEW platform check key; the new key checks the entry (the one touch of this step). The Authority
   * Server appends it only with the person's email link (DEC-15), exactly as a `rotate-root`.
   */
  async checkKeySubmit(input: { code: unknown; port: number; sessionId: string; localAddress?: string }): Promise<{
    recoveryId: string; pageUrl: string; checkEmail: true; sameBrowser: true; confirmCode: string; expiresAt: number;
  }> {
    this.requireUnlocked();
    const stored = this.storedChain();
    this.dropExpiredRotate();
    if (this.busy) throw new SetupRefusal(409, 'setup_busy');
    if (this.live()) throw new SetupRefusal(409, 'recovery_pending');
    if (!this.d.checks || !this.d.checkStore) throw new SetupRefusal(409, 'helper_unavailable');
    this.checkLoopback(input.port, input.sessionId, input.localAddress);
    this.busy = true;
    let rootSeed: Uint8Array | null = null;
    try {
      const dk = await deviceKeys();
      const root = await this.rootKeyOf(dk, input.code);
      rootSeed = root.privateSeed;
      const key = await this.d.checkAs();
      if (!key.ok) throw new SetupRefusal(key.code === 'as_key_mismatch' || key.code === 'as_tls_mismatch' ? 409 : 502, key.code);
      const { state, entries } = await this.ownChain(stored);
      if (state.root_pub !== dk.b64uEncode(root.publicKey)) throw new SetupRefusal(409, 'recovery_code_wrong');
      if (!dk.isActive(state, stored.keyId)) throw new SetupRefusal(409, 'device_removed');
      if (state.devices[stored.keyId].check) throw new SetupRefusal(409, 'check_key_present');
      let made: StoredCheckKey;
      try { made = await this.d.checks.createKey(); } catch (err) { throw checkRefusal(err); }

      const entry = dk.buildEntry({
        root_did: stored.rootDid, seq: state.head.seq + 1, prev: state.head.hash, op: 'set',
        created_at: Math.floor(this.now() / 1000), signer: 'root', target: stored.keyId, check: platformCheckKey(made.publicKey),
      });
      entry.sigs.push(await dk.signEntry(entry, 'root', root.privateSeed));
      rootSeed.fill(0);
      let signed;
      try { signed = await this.d.checks.sign(made, dk.entrySignedBytes(entry)); } catch (err) { throw checkRefusal(err); }
      entry.checks.push({ by: stored.keyId, check: platformCheckProof(signed.signature) });
      try {
        await dk.verifyChain({ expectedRootDid: stored.rootDid, entries: [...entries, entry] });
      } catch (e) {
        if (isDeviceKeysError(e)) throw new SetupRefusal(409, 'entry_invalid', { asCode: e.code });
        throw e;
      }
      const hash = await dk.entryHash(entry);
      const f: Flow = {
        id: randomBytes(16).toString('base64url'), kind: 'set', entry, entryHash: hash, rootDid: stored.rootDid,
        keyId: stored.keyId, label: stored.label, checkKey: made, handoff: null, confirmCode: confirmCodeOf(hash), expiresAt: 0,
      };
      this.requireUnlocked();
      const handed = await this.stage(f, input.port, input.sessionId);
      this.requireUnlocked();
      this.persist(f);
      this.flow = f;
      return { recoveryId: f.id, ...handed };
    } finally {
      rootSeed?.fill(0);
      this.busy = false;
    }
  }

  /** `set`: the chain holds our entry: the check key goes into its slot, then the stored head moves. */
  async checkKeyFinish(input: { recoveryId: unknown }): Promise<{ rootDid: string; head: { seq: number; hash: string }; checkKey: true }> {
    this.requireUnlocked();
    const stored = this.storedChain();
    if (this.busy) throw new SetupRefusal(409, 'setup_busy');
    const f = this.flowFor(input.recoveryId);
    if (f.kind !== 'set' || !f.checkKey) throw new SetupRefusal(404, 'recovery_unknown');
    if (!this.d.checkStore) throw new SetupRefusal(409, 'helper_unavailable');
    this.busy = true;
    try {
      if (!isBearerCredential(this.d.vault.getSpCookie())) await this.d.signin.signIn();
      const { state } = await this.ownChain(stored);
      if (state.hashes[f.entry.seq] !== f.entryHash) {
        const failed = f.handoff?.status === 'failed' ? f.handoff.failure : undefined;
        throw new SetupRefusal(409, 'recovery_not_done', failed ? { handoffCode: failed.code, ...(failed.asCode ? { asCode: failed.asCode } : {}) } : {});
      }
      // From the moment the chain names this computer's check key, the slot holds it (a password is then no confirmation here).
      this.d.checkStore.write(f.checkKey);
      try {
        this.d.store.advance(state.head);
      } catch (e) {
        if (e instanceof ChainHeadRefusedError) throw new SetupRefusal(409, e.reason === 'rollback' ? 'chain_rollback' : 'chain_fork');
        throw e;
      }
      this.flow = null;
      try { this.persist(null); } catch { /* locked: the slot is dropped at the next finish or cancel */ }
      return { rootDid: stored.rootDid, head: state.head, checkKey: true };
    } finally {
      this.busy = false;
    }
  }

  /** A rotation whose time is over is dropped (and its sealed slot with it): nothing may stay wedged behind it. */
  private dropExpiredRotate(): void {
    const f = this.live();
    if ((f?.kind === 'rotate' || f?.kind === 'set') && f.expiresAt <= this.now() && f.handoff?.status !== 'authorised') {
      this.flow = null;
      try { this.persist(null); } catch { /* locked */ }
    }
  }

  /**
   * Drop a started recovery or rotation, and a prepared new code. A `reset` is NOT dropped blindly: if the Authority
   * Server already holds the entry (the person pressed the button and the answer was lost), this computer is a device
   * of that chain and dropping would strand it (its check key gone, its entry in a chain it cannot sign in to). So the
   * chain is asked first, with the same sign-in `finish` uses, and the recovery is completed instead. When the
   * Authority Server cannot be asked, nothing is dropped.
   */
  async cancel(): Promise<{ cancelled: true } | { completed: Completed }> {
    if (this.busy) throw new SetupRefusal(409, 'setup_busy');
    const f = this.live(); // load a kept one, so there is nothing left in the slot either
    if (f?.kind === 'reset' && !this.d.store.exists()) {
      this.busy = true;
      try {
        const key = await this.d.checkAs();
        if (!key.ok) throw new SetupRefusal(key.code === 'as_key_mismatch' || key.code === 'as_tls_mismatch' ? 409 : 502, key.code);
        const probe = await this.d.signin.performSignIn({ rootDid: f.rootDid, keyId: f.keyId, head: { seq: f.entry.seq, hash: f.entryHash } }, { storeHead: false, probe: true });
        if (probe.ok) return { completed: await this.completeReset(f) };
        if (probe.code === 'as_unreachable' || probe.code === 'as_error' || probe.code === 'rate_limited' || probe.code === 'as_tls_mismatch') {
          throw new SetupRefusal(probe.code === 'rate_limited' ? 429 : probe.code === 'as_tls_mismatch' ? 409 : 502, probe.code);
        }
        // The Authority Server does not hold the entry: nothing was done, and nothing is lost by dropping it.
      } finally {
        this.busy = false;
      }
    }
    this.flow = null;
    this.prepared = null;
    try { this.persist(null); } catch { /* locked: nothing to clear */ }
    // A check-key slot with no chain behind it is an orphan: clear it.
    try { if (this.d.checkStore && !this.d.store.exists()) this.d.checkStore.write(null); } catch { /* locked */ }
    return { cancelled: true };
  }

  // ─── cancel a request for a new identity ─────────────────────────────────

  async cancelIdentityReset(input: { requestId: unknown }): Promise<{ cancelled: true; requestId: string }> {
    this.requireUnlocked();
    const stored = this.storedChain();
    if (this.busy) throw new SetupRefusal(409, 'setup_busy');
    // Only a request the Authority Server told this computer about (verified at a sign-in) is cancelled here.
    const pending = this.d.alarm.get();
    if (!pending || typeof input.requestId !== 'string' || !b64uEq(input.requestId, pending.id)) throw new SetupRefusal(404, 'reset_unknown');
    this.busy = true;
    try {
      const dk = await deviceKeys();
      const key = await this.d.checkAs();
      if (!key.ok) throw new SetupRefusal(key.code === 'as_key_mismatch' || key.code === 'as_tls_mismatch' ? 409 : 502, key.code);
      const { state } = await this.ownChain(stored);
      if (!dk.isActive(state, stored.keyId)) throw new SetupRefusal(409, 'device_removed');
      const signing = loadDeviceSigningKey(this.d.vault);
      if (!signing || (await dk.keyIdOf(signing.publicKey)) !== stored.keyId) throw new SetupRefusal(409, 'key_mismatch');

      const cancel = dk.buildIdentityCancel({
        aud: key.publicKeyHex, root_did: stored.rootDid, key_id: stored.keyId, request_id: pending.id,
        chain_seq: state.head.seq, chain_head: state.head.hash, issued_at: Math.floor(this.now() / 1000),
      });
      const sig = await dk.signObject(cancel, signing.privateSeed);
      // The chain decides whether a check is needed, not this computer's slot: a device with a check key in
      // the chain must send one (a cancel without it is refused), a device without must send none.
      let check: { signature: string } | undefined;
      const named = state.devices[stored.keyId].check;
      if (named) {
        if (!this.d.checks || !this.d.checkStore) throw new SetupRefusal(409, 'helper_unavailable');
        const local = this.localCheckKeyFor(dk, named);
        let signed;
        try { signed = await this.d.checks.sign(local, dk.signedBytes(cancel)); } catch (err) { throw checkRefusal(err); }
        check = platformCheckProof(signed.signature);
      }
      // Our own check, the Authority Server's: a cancel it would refuse is not sent.
      try {
        await dk.verifyIdentityCancel({ cancel, sig, ...(check ? { check } : {}) }, { chain: state, aud: key.publicKeyHex, requestId: pending.id, now: Math.floor(this.now() / 1000) });
      } catch (e) {
        if (isDeviceKeysError(e)) throw new SetupRefusal(409, 'entry_invalid', { asCode: e.code });
        throw e;
      }
      // No session: the signature is the authentication (plan 6.2). Nothing but the signed object is sent.
      const reply = await this.asCall('POST', '/api/identity/reset/cancel', { body: { request_id: pending.id, cancel, sig, ...(check ? { check } : {}) } });
      this.refuseOnStatus(reply, 200, 'cancel_refused');
      const r = (reply.body as { request?: { id?: unknown; state?: unknown } } | null)?.request;
      if (!r || r.id !== pending.id || r.state !== 'cancelled') throw new SetupRefusal(502, 'as_answer_invalid');
      this.d.alarm.cancelled(pending.id);
      return { cancelled: true, requestId: pending.id };
    } finally {
      this.busy = false;
    }
  }

  // ─── shared ─────────────────────────────────────────────────────────────

  private storedChain(): StoredDeviceChain {
    let stored: StoredDeviceChain | null;
    try { stored = this.d.store.read(); } catch { throw new SetupRefusal(500, 'chain_unreadable'); }
    if (!stored) throw new SetupRefusal(409, 'not_set_up');
    if (stored.asUrl !== this.d.client.asUrl) throw new SetupRefusal(409, 'as_url_mismatch');
    return stored;
  }

  /** This computer's own chain, read with its device session and verified from the genesis on against the stored head. */
  private async ownChain(stored: StoredDeviceChain): Promise<{ state: ChainState; entries: unknown[] }> {
    const dk = await deviceKeys();
    const credential = this.d.vault.getSpCookie();
    if (!isBearerCredential(credential)) throw new SetupRefusal(409, 'not_signed_in');
    const got = await this.asCall('GET', `/api/devices/chain?did=${encodeURIComponent(stored.rootDid)}`, { bearer: credential });
    if (got.status === 401) throw new SetupRefusal(409, 'not_signed_in');
    this.refuseOnStatus(got, 200, 'as_answer_invalid');
    const body = got.body as { entries?: unknown; head?: { seq?: unknown; hash?: unknown } } | null;
    if (!body || !Array.isArray(body.entries)) throw new SetupRefusal(502, 'as_answer_invalid');
    let state: ChainState;
    try {
      state = await dk.verifyChain({ expectedRootDid: stored.rootDid, entries: body.entries, storedHead: stored.head });
    } catch (e) {
      if (isDeviceKeysError(e)) {
        if (e.code === 'ROLLBACK') throw new SetupRefusal(409, 'chain_rollback');
        if (e.code === 'FORK') throw new SetupRefusal(409, 'chain_fork');
        throw new SetupRefusal(502, 'chain_invalid', { asCode: e.code });
      }
      throw e;
    }
    if (body.head?.seq !== state.head.seq || body.head?.hash !== state.head.hash) throw new SetupRefusal(502, 'head_mismatch');
    return { state, entries: body.entries };
  }

  /** One call to the Authority Server, its network failures as refusals with neutral codes. */
  private async asCall(method: string, path: string, opts: { body?: unknown; bearer?: string }): Promise<AsReply> {
    try {
      return await this.d.client.call(method, path, opts);
    } catch (err) {
      if (err instanceof AsTlsMismatchError) throw new SetupRefusal(409, 'as_tls_mismatch');
      if (err instanceof AsUnreachableError) throw new SetupRefusal(502, 'as_unreachable');
      throw err;
    }
  }

  private refuseOnStatus(reply: AsReply, ok: number, code: string): void {
    if (reply.status === ok) return;
    const asCode = asErrorCode(reply.body);
    if (reply.status === 429) throw new SetupRefusal(429, 'rate_limited', asCode ? { asCode } : {});
    if (asCode === 'MAIL_FAILED') throw new SetupRefusal(502, 'mail_failed', { asCode });
    if (asCode === 'ROOT_KEY_TAKEN') throw new SetupRefusal(409, 'root_key_taken', { asCode });
    if (reply.status === 404 && asCode === 'NO_CHAIN') throw new SetupRefusal(404, 'recovery_code_unknown', { asCode });
    if (reply.status >= 500) throw new SetupRefusal(502, 'as_error');
    if (asCode === 'CHAIN_HEAD_MOVED') throw new SetupRefusal(409, 'chain_moved', { asCode });
    throw new SetupRefusal(409, code, asCode ? { asCode } : {});
  }
}
