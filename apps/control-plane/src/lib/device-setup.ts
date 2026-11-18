/**
 * Set-up of device keys on this computer (device-keys plan 2.1, 3.1, 3.2, 20.17,
 * 20.18; step 6). Logic only; routes/device-setup.ts is the API, the screens and
 * their words are not built (O19, O26).
 *
 *   start    makes the recovery code and the root key, builds the `genesis` entry with
 *            this computer as the first device (kind `gateway`) and signs it with the
 *            root key and the device key. The code is returned ONCE, in that answer.
 *            It is never stored, logged or sent to the Authority Server; the root key
 *            is dropped from memory as soon as the entry is signed, because nothing
 *            after set-up signs with it (no check key before stage B: later chain
 *            changes need the code again).
 *   connect  (optional) makes `state` and a PKCE verifier, kept here and tied to the
 *            page session that asked, and hands back the address to open in the
 *            system browser. The browser comes back to /connect/callback on
 *            127.0.0.1 (RFC 8252); the code is redeemed here, with the verifier and
 *            this computer's signing public key, for an enrolment code bound to it.
 *   finish   posts the `genesis` with an enrolment code (from Connect or pasted from
 *            the dashboard), checks the answer against the entry it built, stores the
 *            chain in the vault and signs in by device key.
 *
 * One set-up at a time. While one is being finished, a second call is refused with
 * `setup_busy`; a set-up that was started and not finished must be cancelled
 * before another can start (`setup_pending`).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ChainEntry } from '@hap/core/device-keys';
import { deviceKeys } from './device-keys-lazy';
import { platformCheckKey, platformCheckProof } from '@suveren/unlock-helper';
import type { Vault } from './vault';
import { loadOrGenerateKeyPair, loadOrGenerateDeviceSigningKey } from './e2e-key-manager';
import type { DeviceChainStore } from './device-chain-store';
import { DeviceAsClient, AsUnreachableError, asErrorCode } from './device-as-client';
import { AsTlsMismatchError } from './as-tls-pin';
import type { DeviceSignin, AsKeyCheck } from './device-signin';
import { CheckKeyStore, CheckError, type PlatformChecks, type StoredCheckKey } from './platform-checks';

export const DEFAULT_DEVICE_LABEL = 'This computer';
/** How long a started Connect waits. Proposed number. */
export const CONNECT_TTL_MS = 10 * 60_000;

/** A refusal with a neutral code. The page's wording for each code is the maintainer's (O19). */
export class SetupRefusal extends Error {
  constructor(readonly status: number, readonly code: string, readonly extra: Record<string, unknown> = {}) {
    super(code);
    this.name = 'SetupRefusal';
  }
}

/** The vault slot that keeps a started set-up across a lock or a restart. No secret is in it (see `persist`). */
const PENDING_SLOT = 'deviceSetupPending';

export interface ConnectAccount { name: string; email: string }

interface Connect {
  state: Buffer;
  verifier: string;
  port: number;
  sessionId: string;
  expiresAt: number;
  /** Set the moment the callback arrives with the right state: a state works once. */
  used: boolean;
  status: 'waiting' | 'ready' | 'failed';
  failure?: { code: string; asCode?: string };
  result?: { enrolmentCode: string; account: ConnectAccount };
}

interface Pending {
  id: string;
  entry: ChainEntry;
  entryHash: string;
  rootDid: string;
  keyId: string;
  label: string;
  connect: Connect | null;
  /**
   * This computer's check key, made at `start` when the person asked for one (plan 23.3: a stage-B
   * account is set up fresh with it, so the first chain entry already carries it and no root-signed
   * `set` is ever needed). Only moved into the check-key slot when the chain is stored.
   */
  checkKey?: StoredCheckKey;
}

export interface DeviceSetupDeps {
  vault: Vault;
  store: DeviceChainStore;
  client: DeviceAsClient;
  signin: DeviceSignin;
  checkAs: () => Promise<AsKeyCheck>;
  /** Epoch ms. */
  now?: () => number;
  /** The computer's check key through the native helper. Unset: a set-up cannot ask for one. */
  checks?: PlatformChecks;
  checkStore?: CheckKeyStore;
  /** Is a recovery with the recovery code started and not finished (lib/device-recovery.ts)? A set-up and a recovery never run together. */
  otherFlowPending?: () => boolean;
}

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

const sha256Ascii = (s: string): Buffer => createHash('sha256').update(s, 'ascii').digest();
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export class DeviceSetup {
  private pending: Pending | null = null;
  /** Held from the first await of `start` and of `finish` to the end: a second call is refused, not queued. */
  private busy = false;
  private readonly now: () => number;

  constructor(private readonly d: DeviceSetupDeps) {
    this.now = d.now ?? Date.now;
    // A lock forgets what is in memory (a Connect in progress included). The started set-up itself is
    // in a sealed vault slot and comes back after unlock, so a finish that was cut short can resume.
    d.vault.onLocked(() => { this.pending = null; });
  }

  /**
   * What is kept of a started set-up: the signed `genesis` entry, which is public once
   * it is posted, and the ids. NOT the recovery code and NOT the root key (neither is
   * ever held after `start` returns). Sealed in the vault, so the AI cannot rewrite it
   * while the gateway is locked. Chosen over resuming from memory because a lock or a
   * restart during `finish` (after the Authority Server stored the genesis) would
   * otherwise leave an account with a chain this computer cannot adopt.
   */
  private persist(p: Pending | null): void {
    this.d.vault.setSecretSlot(PENDING_SLOT, p && { v: 1, id: p.id, entry: p.entry, entryHash: p.entryHash, rootDid: p.rootDid, keyId: p.keyId, label: p.label, ...(p.checkKey ? { checkKey: p.checkKey } : {}) });
  }

  private live(): Pending | null {
    if (this.pending || !this.d.vault.isUnlocked()) return this.pending;
    let raw: Record<string, unknown> | null = null;
    try { raw = this.d.vault.getSecretSlot<Record<string, unknown>>(PENDING_SLOT); } catch { return null; }
    if (!raw || raw.v !== 1) return null;
    const { id, entry, entryHash: h, rootDid, keyId, label, checkKey } = raw as Record<string, unknown>;
    if (typeof id !== 'string' || typeof h !== 'string' || typeof rootDid !== 'string' || typeof keyId !== 'string' || typeof label !== 'string' || !entry || typeof entry !== 'object') return null;
    // A check key that is there but is not one this code wrote makes the whole pending set-up unusable: never "no check key".
    if (checkKey !== undefined && !isStoredCheckKey(checkKey)) return null;
    this.pending = { id, entry: entry as ChainEntry, entryHash: h, rootDid, keyId, label, connect: null, ...(checkKey ? { checkKey } : {}) };
    return this.pending;
  }

  private requireVault(): void {
    if (!this.d.vault.isUnlocked()) throw new SetupRefusal(401, 'locked');
    if (!this.d.vault.hasPassword()) throw new SetupRefusal(409, 'password_required');
    if (this.d.vault.hasPendingRekey()) throw new SetupRefusal(409, 'rekey_pending');
    if (this.d.store.exists()) throw new SetupRefusal(409, 'already_set_up');
  }

  /** What the page needs to show; never the recovery code. */
  status(): { setUp: boolean; setupPending: boolean; connect?: 'waiting' | 'ready' | 'failed' } {
    const p = this.live();
    return { setUp: this.d.store.exists(), setupPending: p !== null, ...(p?.connect ? { connect: p.connect.status } : {}) };
  }

  /**
   * Make the recovery code and the `genesis` entry. The code is in the return value
   * and nowhere else: not in the vault, not in a file, not in a log, not in a request.
   */
  async start(input: { label?: unknown; checkKey?: unknown }): Promise<{ setupId: string; recoveryCode: string; rootDid: string; deviceKeyId: string; label: string }> {
    this.requireVault();
    if (this.busy) throw new SetupRefusal(409, 'setup_busy');
    if (this.live()) throw new SetupRefusal(409, 'setup_pending');
    if (this.d.otherFlowPending?.()) throw new SetupRefusal(409, 'recovery_pending');
    this.busy = true;
    let rootSeed: Uint8Array | null = null;
    try {
      const dk = await deviceKeys();
      const label = input.label === undefined ? DEFAULT_DEVICE_LABEL : input.label;
      if (!dk.isValidLabel(label)) throw new SetupRefusal(400, 'label_invalid');
      if (input.checkKey !== undefined && typeof input.checkKey !== 'boolean') throw new SetupRefusal(400, 'bad_request');
      // The computer's check key: only on request, never silently, and only where the helper can make one.
      let checkKey: StoredCheckKey | undefined;
      if (input.checkKey === true) {
        if (!this.d.checks) throw new SetupRefusal(409, 'helper_unavailable');
        try { checkKey = await this.d.checks.createKey(); } catch (err) { throw checkRefusal(err); }
      }
      const { seed, code } = await dk.generateRecoveryCode();
      const root = await dk.deriveRootKey(seed);
      rootSeed = root.privateSeed;
      seed.fill(0);
      const signing = await loadOrGenerateDeviceSigningKey(this.d.vault);
      const reading = await loadOrGenerateKeyPair(this.d.vault);
      const device = await dk.buildDeviceRecord({
        sign_pub: dk.b64uEncode(signing.publicKey),
        read_pub: dk.b64uEncode(reading.publicKey),
        kind: 'gateway',
        label,
        keystore: 'software',
        ...(checkKey ? { check: platformCheckKey(checkKey.publicKey) } : {}),
      }, signing.publicKey);
      const entry = dk.buildEntry({
        root_did: root.did, seq: 0, prev: null, op: 'genesis',
        created_at: Math.floor(this.now() / 1000), signer: 'root', device,
      });
      entry.sigs.push(await dk.signEntry(entry, 'root', root.privateSeed));
      entry.sigs.push(await dk.signEntry(entry, device.key_id, signing.privateSeed));
      if (checkKey) {
        // The device proves it holds its check key: its check over the same entry (3.2, genesis). One touch.
        let signed;
        try { signed = await this.d.checks!.sign(checkKey, dk.entrySignedBytes(entry)); } catch (err) { throw checkRefusal(err); }
        entry.checks.push({ by: device.key_id, check: platformCheckProof(signed.signature) });
      }
      // Our own check: an entry the Authority Server would refuse is never offered to the person.
      await dk.verifyChain({ expectedRootDid: root.did, entries: [entry] });
      // The state may have changed while the keys were made.
      this.requireVault();
      const id = randomBytes(16).toString('base64url');
      const p: Pending = {
        id, entry, entryHash: await dk.entryHash(entry), rootDid: root.did, keyId: device.key_id,
        label, connect: null, ...(checkKey ? { checkKey } : {}),
      };
      this.persist(p);
      this.pending = p;
      return { setupId: id, recoveryCode: code, rootDid: root.did, deviceKeyId: device.key_id, label };
    } finally {
      // The root key signed one entry and is not needed again, whatever happened.
      rootSeed?.fill(0);
      this.busy = false;
    }
  }

  /** Drop a started set-up. The recovery code that was shown with it is dead. */
  cancel(): void {
    if (this.busy) throw new SetupRefusal(409, 'setup_busy');
    this.live(); // load a kept one, so there is nothing left in the slot either
    this.pending = null;
    try { this.persist(null); } catch { /* locked: nothing to clear */ }
    // A check-key slot with no chain behind it is an orphan (the crash window of `complete`): clear it.
    try { if (this.d.checkStore && !this.d.store.exists()) this.d.checkStore.write(null); } catch { /* locked */ }
  }

  private pendingFor(setupId: unknown): Pending {
    const p = this.live();
    if (!p || typeof setupId !== 'string' || setupId.length !== p.id.length
      || !timingSafeEqual(Buffer.from(setupId), Buffer.from(p.id))) {
      throw new SetupRefusal(404, 'setup_unknown');
    }
    return p;
  }

  // ─── Connect (20.18) ──────────────────────────────────────────────────────

  /**
   * Begin Connect for the started set-up. `port` is the port THIS server answers on:
   * the Authority Server builds the redirect from a port number alone, never from a URL.
   * `sessionId` is the page session; only it may read the result.
   */
  connectStart(setupId: unknown, port: number, sessionId: string, localAddress?: string): { authorizeUrl: string; expiresAt: number } {
    this.requireVault();
    if (this.busy) throw new SetupRefusal(409, 'setup_busy');
    const p = this.pendingFor(setupId);
    if (!sessionId) throw new SetupRefusal(401, 'unauthorized');
    // The Authority Server redirects to http://127.0.0.1:<port>. A gateway that listens on ::1 only would
    // never receive it, and a redirect to another address would be a different trust decision: refuse
    // Connect there (the pasted enrolment code still works).
    if (localAddress !== '127.0.0.1' && localAddress !== '::ffff:127.0.0.1') throw new SetupRefusal(409, 'connect_loopback_unsupported');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new SetupRefusal(409, 'connect_port_unsupported');
    const state = randomBytes(32);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = sha256Ascii(verifier).toString('base64url');
    const expiresAt = this.now() + CONNECT_TTL_MS;
    // A new Connect replaces an earlier one: the earlier state no longer matches anything.
    p.connect = { state, verifier, port, sessionId, expiresAt, used: false, status: 'waiting' };
    const q = new URLSearchParams({ port: String(port), state: state.toString('base64url'), code_challenge: challenge });
    // PLACEHOLDER path: 20.18 says "suveren.ai/connect" and the page is not built yet (see the report).
    return { authorizeUrl: `${this.d.client.asUrl}/connect?${q.toString()}`, expiresAt };
  }

  /**
   * The system browser came back. No page session here: the browser that follows a
   * redirect from suveren.ai sends no SameSite=Strict cookie. What authorises this
   * request is `state`: random, kept only here, tied to one page session, single-use.
   * Everything about the outcome is read later, by that page session, from `connectStatus`.
   */
  async connectCallback(query: { state?: unknown; code?: unknown; error?: unknown }): Promise<'accepted' | 'unknown'> {
    const p = this.live();
    const c = p?.connect;
    if (!p || !c || typeof query.state !== 'string') return 'unknown';
    let given: Buffer;
    try { given = Buffer.from(query.state, 'base64url'); } catch { return 'unknown'; }
    if (given.length !== c.state.length || !timingSafeEqual(given, c.state)) return 'unknown';
    if (c.used || c.expiresAt <= this.now()) return 'unknown';
    c.used = true; // before the first await: a second request with the same state finds it used

    if (typeof query.error === 'string') {
      // An AS that refuses (RFC 6749 error redirect) says so here; today it does not redirect a refusal at all.
      c.status = 'failed';
      c.failure = { code: 'connect_refused', ...(SAFE_CODE.test(query.error) ? { asCode: query.error } : {}) };
      return 'accepted';
    }
    if (typeof query.code !== 'string' || !query.code || query.code.length > 128) {
      c.status = 'failed';
      c.failure = { code: 'connect_refused' };
      return 'accepted';
    }
    try {
      const signing = await loadOrGenerateDeviceSigningKey(this.d.vault);
      const key = await this.d.checkAs();
      if (!key.ok) { c.status = 'failed'; c.failure = { code: key.code }; return 'accepted'; }
      const r = await this.d.client.call('POST', '/api/connect/token', {
        body: { code: query.code, code_verifier: c.verifier, gateway_key: Buffer.from(signing.publicKey).toString('base64url') },
      });
      const body = r.body as { enrolment_code?: unknown; account?: { name?: unknown; email?: unknown } } | null;
      if (r.status === 201 && typeof body?.enrolment_code === 'string' && body.enrolment_code.length > 0 && body.enrolment_code.length <= 128
        && typeof body.account?.name === 'string' && typeof body.account?.email === 'string') {
        c.status = 'ready';
        c.result = { enrolmentCode: body.enrolment_code, account: { name: body.account.name, email: body.account.email } };
      } else {
        c.status = 'failed';
        c.failure = r.status === 201
          ? { code: 'as_answer_invalid' }
          : { code: 'connect_refused', ...(asErrorCode(r.body) ? { asCode: asErrorCode(r.body) } : {}) };
      }
    } catch (err) {
      c.status = 'failed';
      c.failure = { code: err instanceof AsTlsMismatchError ? 'as_tls_mismatch' : err instanceof AsUnreachableError ? 'as_unreachable' : 'connect_failed' };
    }
    return 'accepted';
  }

  /** The page session that started Connect asks how it went. The enrolment code itself never leaves this process. */
  connectStatus(setupId: unknown, sessionId: string): { state: 'waiting' | 'ready' | 'failed' | 'expired'; code?: string; asCode?: string; account?: ConnectAccount } {
    const p = this.pendingFor(setupId);
    const c = p.connect;
    if (!c) throw new SetupRefusal(404, 'connect_not_started');
    if (c.sessionId !== sessionId) throw new SetupRefusal(403, 'connect_other_session');
    if (c.status === 'waiting' && c.expiresAt <= this.now()) {
      // The browser never came back: the Authority Server refused in the browser (today it refuses every
      // Connect there), the person closed the tab, or it took too long. The gateway cannot tell which.
      return { state: 'expired', code: 'connect_timeout' };
    }
    if (c.status === 'ready') return { state: 'ready', account: c.result!.account };
    if (c.status === 'failed') return { state: 'failed', code: c.failure!.code, ...(c.failure!.asCode ? { asCode: c.failure!.asCode } : {}) };
    return { state: 'waiting' };
  }

  // ─── finish ───────────────────────────────────────────────────────────────

  async finish(input: { setupId: unknown; enrolmentCode?: unknown; sessionId: string }): Promise<{
    rootDid: string; deviceKeyId: string; head: { seq: number; hash: string };
    account?: ConnectAccount; signedIn: boolean; signinCode?: string;
  }> {
    this.requireVault();
    if (this.busy) throw new SetupRefusal(409, 'setup_busy');
    const p = this.pendingFor(input.setupId);
    this.busy = true;
    try {
      const pasted = input.enrolmentCode;
      let code: string | undefined;
      let account: ConnectAccount | undefined;
      if (pasted !== undefined) {
        if (typeof pasted !== 'string' || !pasted.trim() || pasted.length > 128) throw new SetupRefusal(400, 'enrolment_code_invalid');
        code = pasted.trim();
      } else if (p.connect?.status === 'ready' && p.connect.sessionId === input.sessionId) {
        code = p.connect.result!.enrolmentCode;
        account = p.connect.result!.account;
      }
      // No code: the Authority Server may already hold this computer's genesis (a lock, a restart or a lost
      // answer cut an earlier finish short). Find out; only then is a code missing.
      if (!code) return await this.reconcile(p, account, { code: 'enrolment_code_missing', status: 400 });

      // The Authority Server proves it holds its key before it is handed a code.
      const key = await this.d.checkAs();
      if (!key.ok) throw new SetupRefusal(key.code === 'as_key_mismatch' || key.code === 'as_tls_mismatch' ? 409 : 502, key.code);

      let reply;
      try {
        reply = await this.d.client.call('POST', '/api/devices/chain', { body: { entry: p.entry, enrolment_code: code } });
      } catch (err) {
        if (err instanceof AsTlsMismatchError) throw new SetupRefusal(409, 'as_tls_mismatch');
        if (!(err instanceof AsUnreachableError)) throw err;
        // The Authority Server may have stored the genesis and lost the answer.
        return await this.reconcile(p, account, { code: 'as_unreachable', status: 502 });
      }

      if (reply.status === 201) {
        const head = (reply.body as { head?: { seq?: unknown; hash?: unknown } } | null)?.head;
        // The answer is checked against the entry this computer built, not believed.
        if (head?.seq !== 0 || head.hash !== p.entryHash) throw new SetupRefusal(502, 'head_mismatch');
        return await this.complete(p, account);
      }
      const asCode = asErrorCode(reply.body);
      if (reply.status >= 500) return await this.reconcile(p, account, { code: 'as_error', status: 502, asCode });
      // A genesis already stored for this account can be ours (a lost answer, then a second code).
      if (asCode === 'CHAIN_EXISTS' || asCode === 'ENROLMENT_CODE_USED') {
        return await this.reconcile(p, account, { code: 'setup_refused', status: 409, asCode });
      }
      throw new SetupRefusal(reply.status === 429 ? 429 : 409, 'setup_refused', asCode ? { asCode } : {});
    } finally {
      this.busy = false;
    }
  }

  /**
   * The answer to the genesis is unknown or the account already has a chain. If the
   * Authority Server holds exactly the entry this computer signed, this computer can
   * sign in with it: the chain is ours, finish. Otherwise report the original refusal
   * and keep the started set-up, so another enrolment code can be tried.
   */
  private async reconcile(p: Pending, account: ConnectAccount | undefined, refusal: { code: string; status: number; asCode?: string }): Promise<Awaited<ReturnType<DeviceSetup['finish']>>> {
    const probe = await this.d.signin.performSignIn({ rootDid: p.rootDid, keyId: p.keyId, head: { seq: 0, hash: p.entryHash } }, { storeHead: false, probe: true });
    if (!probe.ok) throw new SetupRefusal(refusal.status, refusal.code, refusal.asCode ? { asCode: refusal.asCode } : {});
    return this.complete(p, account);
  }

  /** The Authority Server holds our genesis: store the chain, then sign in. */
  private async complete(p: Pending, account: ConnectAccount | undefined): Promise<Awaited<ReturnType<DeviceSetup['finish']>>> {
    const asUrl = this.d.client.asUrl;
    // The check key's slot first: from the moment the chain says this computer has a check key, the
    // password is no longer a confirmation here. If the chain cannot be stored the slot is emptied again.
    if (p.checkKey) {
      if (!this.d.checkStore) throw new SetupRefusal(500, 'bad_request');
      this.d.checkStore.write(p.checkKey);
    }
    try {
      this.d.store.create({
        v: 1, rootDid: p.rootDid, keyId: p.keyId, head: { seq: 0, hash: p.entryHash },
        asUrl, label: p.label, setUpAt: p.entry.created_at,
      });
    } catch (err) {
      if (p.checkKey) { try { this.d.checkStore!.write(null); } catch { /* the original error is the one to report */ } }
      throw err;
    }
    this.pending = null;
    try { this.persist(null); } catch { /* the chain is stored; an unreadable leftover is ignored once a chain exists */ }
    const r = await this.d.signin.signIn();
    return {
      rootDid: p.rootDid,
      deviceKeyId: p.keyId,
      head: { seq: 0, hash: p.entryHash },
      ...(account ? { account } : {}),
      signedIn: r.ok,
      ...(r.ok ? {} : { signinCode: r.code }),
    };
  }
}
