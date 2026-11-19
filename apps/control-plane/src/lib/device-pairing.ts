/**
 * Pairing with the phone app, on this computer (device-keys plan 4.3, 3.2, step 11 gateway part; DEC-47 roles, DEC-83, DEC-84).
 * Logic only; routes/device-pairing.ts is the API and the page's screens (apps/ui) are the words. Everything is behind the
 * device-keys switch (it is mounted only with the switch on and device set-up present).
 *
 *   ADMIT  "Add a phone". This computer is the ADMITTER: a granting device (a check key in the native helper). It shows a QR
 *          (`shown_by: "admitter"`), opens the mailbox, answers the phone's `commit` with `challenge`, checks the phone's `open`
 *          (the shared `checkOpen`), shows three comparison codes, and after the person tapped the right one and gave a Touch ID
 *          check over that exact entry, signs the phone's `add`, checks the whole chain, appends it WITH the pairing id (the phone's
 *          passkey registration sits under it at the Authority Server) and says `done`.
 *
 *   JOIN   "Add this computer". This computer has no account yet. It shows a QR (`shown_by: "joiner"`); the phone scans it, opens
 *          the mailbox and says `hello` (its root DID, head, key id, and the AS key). This computer verifies that chain from the
 *          genesis on, shows who it would join (the identity code, where and when it was made, every device: DEC-47's "says so
 *          once, cannot be skipped"), and after the person confirmed builds its `add` (signed with its device key; with its own
 *          Touch ID check where it has a check key), commits, answers `challenge` with `open`, and shows the comparison code
 *          the phone's three buttons are matched against. On `done` it stores the chain and signs in.
 *
 * The protocol logic the phone and this computer share (mailbox, `open` check, code choices, device rows) is `@suveren/pairing`,
 * loaded lazily so a gateway with the switch off never needs it (the same reason as lib/device-keys-lazy.ts).
 *
 * What the page may rely on, all enforced HERE:
 *   - the secret of a QR, the MAC key, the real comparison code and every key stay in this process; the page gets the QR text (it
 *     must draw it), three codes (the real one among them, unmarked) and the device list;
 *   - nothing is signed before the person tapped the real code (ADMIT) or confirmed the account (JOIN); a wrong tap ends the pairing;
 *   - the touch (the check of this computer) is the step: the helper builds the prompt from the entry, so the page cannot say
 *     what the touch is for;
 *   - one pairing at a time; a lock forgets it. No timers: the page polls `status()`.
 *
 * Codes only in refusals. Never a secret, signature, nonce or key in a log or an answer.
 */

import type { ChainEntry, ChainState, PairingQr } from '@hap/core/device-keys';
import { platformCheckKey, platformCheckProof } from '@suveren/unlock-helper';
import type { DeviceRow, Messages, Mailbox, MailboxPort, Origin, OpenedEntry, PairingKeys } from '@suveren/pairing';
import type { Vault } from './vault';
import { deviceKeys, isDeviceKeysError } from './device-keys-lazy';
import { ChainHeadRefusedError, type DeviceChainStore } from './device-chain-store';
import { AsUnreachableError, asErrorCode, type DeviceAsClient } from './device-as-client';
import { AsTlsMismatchError } from './as-tls-pin';
import type { AsKeyCheck, DeviceSignin } from './device-signin';
import { loadDeviceSigningKey, loadOrGenerateDeviceSigningKey, loadOrGenerateKeyPair } from './e2e-key-manager';
import { CheckError, type CheckKeyStore, type PlatformChecks, type StoredCheckKey } from './platform-checks';
import { isBearerCredential } from './as-credential';
import { DEFAULT_DEVICE_LABEL } from './device-setup';

let lazy: Promise<typeof import('@suveren/pairing')> | null = null;
/** `@suveren/pairing`, loaded on first use. */
const pairingLib = (): Promise<typeof import('@suveren/pairing')> => (lazy ??= import('@suveren/pairing'));

/** A refusal with a neutral code. The page's wording for each code is its texts module. `status` is the HTTP status the route answers. */
export class PairingRefusal extends Error {
  constructor(readonly status: number, readonly code: string, readonly extra: Record<string, unknown> = {}) {
    super(code);
    this.name = 'PairingRefusal';
  }
}

/**
 * Every code this class (and its routes) can say. The page maps each to words (apps/ui lib/pairing-texts.ts); a test holds the list to
 * the source and the page's texts to the list.
 */
export const PAIRING_CODES = [
  // the page session and the vault
  'locked', 'password_required', 'rekey_pending', 'bad_request',
  // what must hold
  'not_set_up', 'already_set_up', 'not_signed_in', 'device_removed', 'chain_unreadable', 'key_mismatch', 'cannot_grant', 'too_many_devices',
  'pairing_busy', 'pairing_pending', 'pairing_unknown', 'setup_pending',
  // the Authority Server
  'as_unreachable', 'as_tls_mismatch', 'as_answer_invalid', 'as_key_mismatch', 'as_unverified', 'as_error', 'rate_limited', 'head_mismatch', 'mailbox_refused',
  // the chain
  'chain_invalid', 'chain_fork', 'chain_rollback', 'chain_moved',
  // the pairing
  'qr_expired', 'bad_message', 'open_invalid', 'commit_mismatch', 'label_taken', 'label_invalid', 'wrong_code', 'admitter_cannot_grant', 'store_failed',
  'cancelled_by_phone', 'check_cancelled', 'chain_head_moved', 'generic',
  // this computer's touch
  'cancelled', 'not_recognised', 'biometry_locked', 'no_biometry', 'key_invalid', 'interaction_required', 'helper_failed', 'helper_unavailable', 'check_invalid',
] as const;

const refuse = (status: number, code: string, extra?: Record<string, unknown>): never => { throw new PairingRefusal(status, code, extra); };

export type DeviceRowView = DeviceRow & { adding?: boolean };

export type PairingView =
  | { flow: 'none' }
  | { flow: 'admit'; step: 'qr'; qr: string; expiresAt: number }
  | { flow: 'admit'; step: 'connected' }
  | { flow: 'admit'; step: 'choose'; label: string; kind: 'gateway' | 'approve-app'; codes: string[]; rows: DeviceRowView[] }
  | { flow: 'admit'; step: 'checking' }
  | { flow: 'admit'; step: 'done'; label: string; rows: DeviceRowView[] }
  | { flow: 'admit'; step: 'failed'; code: string }
  | { flow: 'join'; step: 'qr'; qr: string; expiresAt: number; canGrant: boolean }
  | { flow: 'join'; step: 'review'; identityCode: string; origin: Origin | null; devices: DeviceRowView[]; admitterLabel: string; suggestedLabel: string; canGrant: boolean; error?: string }
  | { flow: 'join'; step: 'working'; doing: 'check' | 'send' }
  | { flow: 'join'; step: 'waiting'; admitterLabel: string }
  | { flow: 'join'; step: 'compare'; code: string; admitterLabel: string }
  | { flow: 'join'; step: 'done'; signedIn: boolean; signinCode?: string }
  | { flow: 'join'; step: 'failed'; code: string };

export interface DevicesView {
  rows: DeviceRowView[];
  identityCode: string;
  origin: Origin | null;
  /** This computer holds a check key its chain names: it can add devices. */
  canGrant: boolean;
  /** Another device can be added (the chain has room). */
  hasRoom: boolean;
}

export interface DevicePairingDeps {
  vault: Vault;
  store: DeviceChainStore;
  client: Pick<DeviceAsClient, 'call' | 'asUrl'>;
  signin: Pick<DeviceSignin, 'signIn' | 'performSignIn'>;
  checkAs: () => Promise<AsKeyCheck>;
  /** This computer's check key through the native helper. Unset: this computer cannot admit, and a computer that joins has none. */
  checks?: PlatformChecks;
  checkStore?: CheckKeyStore;
  /** Epoch seconds. */
  now?: () => number;
  /** A set-up or a recovery is started and not finished: a pairing never runs beside one. */
  otherFlowPending?: () => boolean;
}

interface LoadedChain {
  credential: string;
  stored: NonNullable<ReturnType<DeviceChainStore['read']>>;
  entries: ChainEntry[];
  chain: ChainState;
}

interface HeldCommon {
  qr: PairingQr;
  text: string;
  pairing: PairingKeys;
  box: Mailbox;
}

interface AdmitHeld extends HeldCommon {
  role: 'admit';
  step: 'qr' | 'connected' | 'choose' | 'checking' | 'done' | 'failed';
  loaded: LoadedChain;
  commit?: string;
  rA?: Uint8Array;
  opened?: OpenedEntry;
  code?: string;
  choice?: { label: string; kind: 'gateway' | 'approve-app'; codes: string[]; rows: DeviceRowView[] };
  done?: { label: string; rows: DeviceRowView[] };
  error?: string;
}

interface JoinHeld extends HeldCommon {
  role: 'join';
  step: 'qr' | 'review' | 'working' | 'waiting' | 'compare' | 'done' | 'failed';
  doing?: 'check' | 'send';
  asKey: string;
  checkKey?: StoredCheckKey;
  /** After `hello`, verified. */
  admitter?: { keyId: string; label: string };
  chain?: ChainState;
  entries?: ChainEntry[];
  /** After the person confirmed. */
  entry?: ChainEntry;
  entryHash?: string;
  entrySigBytes?: Uint8Array;
  label?: string;
  rJ?: Uint8Array;
  opened?: boolean;
  code?: string;
  result?: { signedIn: boolean; signinCode?: string };
  reviewError?: string;
  error?: string;
}

type Held = AdmitHeld | JoinHeld;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A check that did not come (the person cancelled, the helper is not there): the code the page's texts know. */
function checkCode(err: unknown): string {
  if (err instanceof CheckError) {
    const h = err.helperCode;
    if (err.code === 'helper_failed') {
      if (h === 'user_cancelled') return 'cancelled';
      if (h === 'auth_failed') return 'not_recognised';
      if (h === 'biometry_locked' || h === 'no_biometry' || h === 'key_invalid' || h === 'interaction_required') return h;
      return 'helper_failed';
    }
    if (err.code === 'no_biometry') return 'no_biometry';
    if (err.code === 'check_invalid') return 'check_invalid';
    return 'helper_unavailable';
  }
  return 'helper_failed';
}

/** The phone's own reason for ending (`done` with `refused`), as a code the page knows. A word that is not a code is no word at all. */
function refusedCode(refused: string): string {
  if (refused === 'CODE_MISMATCH') return 'wrong_code';
  if (refused === 'CANCELLED') return 'cancelled_by_phone';
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(refused) ? refused.toLowerCase() : 'bad_message';
}

/** An answer of the chain-append route read into a code the texts know. */
function appendCode(asCode: string | undefined, status: number): string {
  if (asCode === 'CHAIN_HEAD_MOVED') return 'chain_moved';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'as_error';
  return asCode ? asCode.toLowerCase() : 'as_error';
}

export class DevicePairing {
  private h: Held | null = null;
  /** An operation that waits for the person or the helper is running: `poll` answers what it has, a second operation is refused. */
  private busy = false;
  private readonly now: () => number;

  constructor(private readonly d: DevicePairingDeps) {
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
    // A lock forgets the pairing: the secret of its QR and the keys it made live only in memory.
    d.vault.onLocked(() => { this.h = null; });
  }

  // ─── the network, as the neutral refusals of this class ────────────────────────

  private async as(method: string, path: string, credential?: string, body?: unknown) {
    try {
      return await this.d.client.call(method, path, { ...(credential ? { bearer: credential } : {}), ...(body !== undefined ? { body } : {}) });
    } catch (e) {
      if (e instanceof AsTlsMismatchError) return refuse(409, 'as_tls_mismatch');
      if (e instanceof AsUnreachableError) return refuse(502, 'as_unreachable');
      throw e;
    }
  }

  /** The mailbox's two calls, over this computer's pinned client; the unreachable network is status 0 (the shared Mailbox words it). */
  private port(): MailboxPort {
    const ok = (status: number): boolean => status >= 200 && status < 300;
    const call = async (method: string, path: string, body?: unknown) => {
      try {
        const r = await this.d.client.call(method, path, body !== undefined ? { body } : {});
        return ok(r.status)
          ? { ok: true as const, data: (r.body ?? {}) as never, status: r.status }
          : { ok: false as const, code: asErrorCode(r.body) ?? 'REFUSED', status: r.status };
      } catch {
        return { ok: false as const, code: 'as_unreachable', status: 0 };
      }
    };
    return {
      postMessage: (id, message) => call('POST', `/api/devices/pairings/${encodeURIComponent(id)}/messages`, message),
      readMailbox: (id) => call('GET', `/api/devices/pairings/${encodeURIComponent(id)}`),
    };
  }

  // ─── what must hold before anything starts ───────────────────────────────────

  private requireVault(): void {
    const { vault } = this.d;
    if (!vault.isUnlocked()) refuse(401, 'locked');
    if (!vault.hasPassword()) refuse(409, 'password_required');
    if (vault.hasPendingRekey()) refuse(409, 'rekey_pending');
  }

  private requireFree(): void {
    if (this.busy) refuse(409, 'pairing_busy');
    const h = this.h;
    if (h && h.step !== 'done' && h.step !== 'failed') refuse(409, 'pairing_pending');
    if (this.d.otherFlowPending?.()) refuse(409, 'setup_pending');
  }

  /** This person's own chain, verified from the genesis on against the head stored here; this computer must be an active device of it. */
  private async loadChain(): Promise<LoadedChain> {
    const { vault, store } = this.d;
    if (!vault.isUnlocked()) refuse(401, 'locked');
    let stored;
    try { stored = store.read(); } catch { return refuse(500, 'chain_unreadable'); }
    if (!stored) return refuse(409, 'not_set_up');
    const credential = vault.getSpCookie();
    if (!isBearerCredential(credential)) return refuse(409, 'not_signed_in');
    const dk = await deviceKeys();
    const got = await this.as('GET', `/api/devices/chain?did=${encodeURIComponent(stored.rootDid)}`, credential);
    if (got.status === 401) return refuse(409, 'not_signed_in');
    if (got.status !== 200 || !isObj(got.body) || !Array.isArray(got.body.entries)) return refuse(502, 'as_answer_invalid');
    let chain: ChainState;
    try {
      chain = await dk.verifyChain({ expectedRootDid: stored.rootDid, entries: got.body.entries, storedHead: stored.head });
    } catch (e) {
      if (isDeviceKeysError(e)) return refuse(409, e.code === 'ROLLBACK' ? 'chain_rollback' : e.code === 'FORK' ? 'chain_fork' : 'chain_invalid');
      throw e;
    }
    const named = isObj(got.body.head) ? got.body.head : null;
    if (!named || named.seq !== chain.head.seq || named.hash !== chain.head.hash) return refuse(502, 'head_mismatch');
    if (!dk.isActive(chain, stored.keyId)) return refuse(409, 'device_removed');
    try { store.advance(chain.head); } catch (e) {
      if (e instanceof ChainHeadRefusedError) return refuse(409, e.reason === 'rollback' ? 'chain_rollback' : 'chain_fork');
      throw e;
    }
    return { credential, stored, entries: got.body.entries as ChainEntry[], chain };
  }

  /** The check key of this computer, when its chain names it. Null: this computer cannot grant. */
  private async ownCheckKey(l: LoadedChain): Promise<StoredCheckKey | null> {
    const { checks, checkStore } = this.d;
    if (!checks || !checkStore) return null;
    const dk = await deviceKeys();
    const device = l.chain.devices[l.stored.keyId];
    if (!device?.check) return null;
    let key: StoredCheckKey | null;
    try { key = checkStore.read(); } catch { return null; }
    if (!key || !dk.checkKeysEqual(device.check, platformCheckKey(key.publicKey))) return null;
    return key;
  }

  private async rows(entries: readonly ChainEntry[], chain: ChainState, ownKeyId: string): Promise<DeviceRowView[]> {
    return (await pairingLib()).deviceRows(entries, chain, ownKeyId, this.now());
  }

  // ─── the list ────────────────────────────────────────────────────────────────

  /** The devices of this account, from the chain this computer verified, for the Devices page. */
  async devices(): Promise<DevicesView> {
    this.requireVault();
    const dk = await deviceKeys();
    const lib = await pairingLib();
    const l = await this.loadChain();
    const canGrant = (await this.ownCheckKey(l)) !== null;
    return {
      rows: lib.deviceRows(l.entries, l.chain, l.stored.keyId, this.now()),
      identityCode: await dk.identityCode(l.stored.rootDid),
      origin: lib.originOf(l.entries),
      canGrant,
      hasRoom: dk.activeDevices(l.chain).length < dk.MAX_ACTIVE_DEVICES,
    };
  }

  // ─── the view ────────────────────────────────────────────────────────────────

  /** What the page draws now. Never a secret: the QR text is for drawing, the codes are three, the real one among them. */
  view(): PairingView {
    const h = this.h;
    if (!h) return { flow: 'none' };
    const expiresAt = h.qr.expires_at;
    if (h.role === 'admit') {
      switch (h.step) {
        case 'qr': return { flow: 'admit', step: 'qr', qr: h.text, expiresAt };
        case 'connected': return { flow: 'admit', step: 'connected' };
        case 'choose': return { flow: 'admit', step: 'choose', ...(h.choice as NonNullable<AdmitHeld['choice']>) };
        case 'checking': return { flow: 'admit', step: 'checking' };
        case 'done': return { flow: 'admit', step: 'done', ...(h.done as NonNullable<AdmitHeld['done']>) };
        case 'failed': return { flow: 'admit', step: 'failed', code: h.error ?? 'generic' };
      }
    }
    const canGrant = h.checkKey !== undefined;
    switch (h.step) {
      case 'qr': return { flow: 'join', step: 'qr', qr: h.text, expiresAt, canGrant };
      case 'review': return this.reviewView(h);
      case 'working': return { flow: 'join', step: 'working', doing: h.doing ?? 'send' };
      case 'waiting': return { flow: 'join', step: 'waiting', admitterLabel: h.admitter?.label ?? '' };
      case 'compare': return { flow: 'join', step: 'compare', code: h.code ?? '', admitterLabel: h.admitter?.label ?? '' };
      case 'done': return { flow: 'join', step: 'done', ...(h.result as NonNullable<JoinHeld['result']>) };
      case 'failed': return { flow: 'join', step: 'failed', code: h.error ?? 'generic' };
    }
  }

  private reviewView(h: JoinHeld): PairingView {
    const stash = this.reviewFacts;
    return {
      flow: 'join', step: 'review',
      identityCode: stash?.identityCode ?? '', origin: stash?.origin ?? null, devices: stash?.devices ?? [],
      admitterLabel: h.admitter?.label ?? '', suggestedLabel: stash?.suggestedLabel ?? DEFAULT_DEVICE_LABEL,
      canGrant: h.checkKey !== undefined, ...(h.reviewError ? { error: h.reviewError } : {}),
    };
  }

  /** What the review step shows, made once when `hello` was verified (identity code is async). */
  private reviewFacts: { identityCode: string; origin: Origin | null; devices: DeviceRowView[]; suggestedLabel: string } | null = null;

  /** The mailbox looked at once, and the view. The page calls this every couple of seconds while a step waits. */
  async status(): Promise<PairingView> {
    await this.poll();
    return this.view();
  }

  /** Stop and forget. An admitter tells the phone, so it stops too. */
  async cancel(): Promise<PairingView> {
    const h = this.h;
    this.h = null;
    this.reviewFacts = null;
    if (h && h.role === 'admit' && h.step !== 'done' && h.step !== 'failed') await h.box.send('done', { refused: 'CANCELLED' }).catch(() => {});
    return { flow: 'none' };
  }

  private fail(h: Held, code: string): void {
    h.step = 'failed';
    h.error = code;
    // What is secret is dropped: the pairing is over.
    if (h.role === 'admit') { h.rA = undefined; h.opened = undefined; h.code = undefined; h.choice = undefined; }
    else { h.rJ = undefined; h.entrySigBytes = undefined; h.checkKey = undefined; h.code = undefined; }
  }

  /** Tell the phone the pairing ended, then fail. Best effort: the phone also times out. */
  private async stop(h: AdmitHeld, code: string, refused?: string): Promise<void> {
    await h.box.send('done', { refused: refused ?? code.toUpperCase() }).catch(() => {});
    this.fail(h, code);
  }

  // ─── ADMIT: "Add a phone" ─────────────────────────────────────────────────────

  async admitStart(): Promise<PairingView> {
    this.requireVault();
    this.requireFree();
    this.busy = true;
    try {
      const dk = await deviceKeys();
      const lib = await pairingLib();
      const loaded = await this.loadChain();
      if (!(await this.ownCheckKey(loaded))) refuse(409, 'cannot_grant');
      if (dk.activeDevices(loaded.chain).length >= dk.MAX_ACTIVE_DEVICES) refuse(409, 'too_many_devices');
      const as = await this.d.checkAs();
      if (!as.ok) return refuse(as.code === 'as_key_mismatch' || as.code === 'as_tls_mismatch' ? 409 : 502, as.code);
      const qr: PairingQr = {
        v: 1, as_url: this.d.client.asUrl, as_key: as.publicKeyHex, shown_by: 'admitter',
        secret: dk.b64uEncode(dk.randomBytes(32)), root_did: loaded.stored.rootDid, head: loaded.chain.head,
        key_id: loaded.stored.keyId, expires_at: this.now() + dk.PAIRING_TTL_SECONDS,
      };
      const text = dk.encodePairingQr(qr);
      const pairing = await lib.pairingKeysOf(qr);
      const made = await this.as('POST', '/api/devices/pairings', loaded.credential, { pairing_id: pairing.pairingId, expires_at: qr.expires_at });
      if (made.status !== 201) return refuse(made.status === 429 ? 429 : 502, made.status === 429 ? 'rate_limited' : 'mailbox_refused');
      this.reviewFacts = null;
      this.h = { role: 'admit', step: 'qr', qr, text, pairing, box: new lib.Mailbox(this.port(), pairing), loaded };
      return this.view();
    } finally {
      this.busy = false;
    }
  }

  private async pollAdmit(h: AdmitHeld): Promise<void> {
    if (h.step !== 'qr' && h.step !== 'connected') return;
    if (this.now() > h.qr.expires_at) { await this.stop(h, 'qr_expired'); return; }
    const r = await h.box.poll();
    if (!r.ok) {
      // A mailbox that cannot be read right now is tried again; one that cannot be trusted ends the pairing.
      if (r.code === 'bad_message') await this.stop(h, 'bad_message');
      return;
    }
    const m: Messages = r.messages;
    if (m.commit && !h.commit) {
      h.commit = m.commit.body.c as string;
      const dk = await deviceKeys();
      h.rA = dk.randomBytes(32);
      const sent = await h.box.send('challenge', { r_a: dk.b64uEncode(h.rA) });
      if (!sent.ok) { await this.stop(h, sent.code); return; }
      h.step = 'connected';
    }
    if (m.open && h.commit && h.rA) await this.onOpen(h, m.open.body);
  }

  /** Message 4: every check of plan 4.3 that can be made before the person is asked. */
  private async onOpen(h: AdmitHeld, body: Record<string, unknown>): Promise<void> {
    const dk = await deviceKeys();
    const lib = await pairingLib();
    let opened: OpenedEntry;
    try {
      opened = await lib.checkOpen(body, {
        chain: h.loaded.chain, rootDid: h.loaded.stored.rootDid, admitterKeyId: h.loaded.stored.keyId, kind: 'approve-app', commit: h.commit as string,
      });
    } catch (e) {
      await this.stop(h, e instanceof lib.OpenCheckError ? e.code : 'open_invalid');
      return;
    }
    const dev = opened.entry.device as NonNullable<ChainEntry['device']>;
    h.opened = opened;
    h.code = await dk.comparisonCode(h.pairing.macKey, opened.entry, opened.rJ, h.rA as Uint8Array);
    const rows: DeviceRowView[] = [
      ...(await this.rows(h.loaded.entries, h.loaded.chain, h.loaded.stored.keyId)),
      { keyId: dev.key_id, label: dev.label, kind: dev.kind, thisDevice: false, canGrant: dev.check !== null, addedAt: opened.entry.created_at, recent: true, adding: true },
    ];
    h.choice = { label: dev.label, kind: dev.kind, codes: lib.codeChoices(h.code), rows };
    h.step = 'choose';
  }

  /**
   * The person tapped a code. A wrong one ends the pairing and adds nothing. The right one asks for the Touch ID check over THIS
   * entry, signs, verifies the whole chain, appends with the pairing id, and tells the phone.
   */
  async admitChoose(code: unknown): Promise<PairingView> {
    this.requireVault();
    const h = this.h;
    if (this.busy) refuse(409, 'pairing_busy');
    if (!h || h.role !== 'admit' || h.step !== 'choose' || !h.opened || !h.code) return refuse(409, 'pairing_unknown');
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return refuse(400, 'bad_request');
    const lib = await pairingLib();
    if (!lib.sameCode(code, h.code)) { await this.stop(h, 'wrong_code', 'CODE_MISMATCH'); return this.view(); }
    this.busy = true;
    h.step = 'checking';
    try {
      await this.sealAndAppend(h);
    } catch (e) {
      if (e instanceof CheckError) await this.stop(h, checkCode(e), 'CHECK_CANCELLED');
      else if (e instanceof PairingRefusal) await this.stop(h, e.code);
      else { await this.stop(h, 'generic'); console.error('[Control Plane] Pairing error:', e instanceof Error ? e.name : 'error'); }
    } finally {
      this.busy = false;
    }
    return this.view();
  }

  private async sealAndAppend(h: AdmitHeld): Promise<void> {
    const dk = await deviceKeys();
    const opened = h.opened as OpenedEntry;
    const checks = this.d.checks;
    // The head must still be the one the phone built its entry on.
    const now = await this.loadChain();
    if (now.chain.head.seq !== h.loaded.chain.head.seq || now.chain.head.hash !== h.loaded.chain.head.hash) return refuse(409, 'chain_moved');
    const checkKey = await this.ownCheckKey(now);
    if (!checks || !checkKey) return refuse(409, 'cannot_grant');
    const signing = loadDeviceSigningKey(this.d.vault);
    if (!signing || (await dk.keyIdOf(signing.publicKey)) !== now.stored.keyId) return refuse(409, 'key_mismatch');

    const entry = opened.entry;
    const dev = entry.device as NonNullable<ChainEntry['device']>;
    const hash = await dk.entryHash(entry);
    const mine = await dk.signEntry(entry, now.stored.keyId, signing.privateSeed);
    // The touch: one check over exactly these bytes (the helper words the prompt from them).
    const signed = await checks.sign(checkKey, dk.entrySignedBytes(entry));
    const final: ChainEntry = {
      ...entry,
      sigs: [mine, { by: dev.key_id, sig: opened.joinerSig }],
      checks: [...entry.checks, { by: now.stored.keyId, check: platformCheckProof(signed.signature) }],
    };
    // The same check the server and every device make (3.3): a defect found here is found before anything is sent.
    let after: ChainState;
    try {
      after = await dk.verifyChain({ expectedRootDid: now.stored.rootDid, entries: [...now.entries, final] });
    } catch {
      return refuse(409, 'chain_invalid');
    }
    const res = await this.as('POST', '/api/devices/chain', now.credential, { entry: final, pairing_id: h.pairing.pairingId });
    if (res.status !== 201) return refuse(res.status === 409 ? 409 : 502, appendCode(asErrorCode(res.body), res.status));
    const head = isObj(res.body) && isObj(res.body.head) ? res.body.head : null;
    if (!head || head.seq !== final.seq || head.hash !== after.head.hash) return refuse(502, 'head_mismatch');
    try { this.d.store.advance(after.head); } catch { /* the next sign-in reads the head again; the entry is stored */ }
    await h.box.send('done', { entry_hash: hash }).catch(() => { /* the phone also finds its entry in the chain */ });
    const rows = await this.rows([...now.entries, final], after, now.stored.keyId);
    h.done = { label: dev.label, rows };
    h.step = 'done';
    h.rA = undefined; h.opened = undefined; h.code = undefined; h.choice = undefined;
  }

  // ─── JOIN: "Add this computer" ─────────────────────────────────────────────────

  async joinStart(): Promise<PairingView> {
    this.requireVault();
    this.requireFree();
    if (this.d.store.exists()) refuse(409, 'already_set_up');
    this.busy = true;
    try {
      const dk = await deviceKeys();
      const lib = await pairingLib();
      const as = await this.d.checkAs();
      if (!as.ok) return refuse(as.code === 'as_key_mismatch' || as.code === 'as_tls_mismatch' ? 409 : 502, as.code);
      // The keys of this computer, made now so the vault holds them whatever comes (the same slots set-up uses).
      await loadOrGenerateDeviceSigningKey(this.d.vault);
      await loadOrGenerateKeyPair(this.d.vault);
      // A check key where this computer can have one (Touch ID, no touch to make it): a joiner brings its own (plan 4.3 rules).
      let checkKey: StoredCheckKey | undefined;
      if (this.d.checks && this.d.checkStore) {
        try {
          if ((await this.d.checks.possible()).ok) checkKey = await this.d.checks.createKey();
        } catch { checkKey = undefined; }   // no check key: this computer approves and does not grant
      }
      const qr: PairingQr = {
        v: 1, as_url: this.d.client.asUrl, as_key: as.publicKeyHex, shown_by: 'joiner',
        secret: dk.b64uEncode(dk.randomBytes(32)), root_did: null, head: null, key_id: null, expires_at: this.now() + dk.PAIRING_TTL_SECONDS,
      };
      const text = dk.encodePairingQr(qr);
      const pairing = await lib.pairingKeysOf(qr);
      this.reviewFacts = null;
      this.h = { role: 'join', step: 'qr', qr, text, pairing, box: new lib.Mailbox(this.port(), pairing), asKey: as.publicKeyHex, ...(checkKey ? { checkKey } : {}) };
      return this.view();
    } finally {
      this.busy = false;
    }
  }

  private async pollJoin(h: JoinHeld): Promise<void> {
    if (h.step !== 'qr' && h.step !== 'waiting' && h.step !== 'compare') return;
    const late = this.now() > h.qr.expires_at + 60;
    if (late && h.step === 'qr') { this.fail(h, 'qr_expired'); return; }
    if (late) { await this.reconcile(h); return; }
    const r = await h.box.poll();
    if (!r.ok) {
      // Until the phone has opened its mailbox there is none: that is not a failure. One that cannot be trusted ends it.
      if (r.code === 'bad_message') this.fail(h, 'bad_message');
      else if (r.code === 'mailbox_missing' && h.step !== 'qr') await this.reconcile(h);
      return;
    }
    const m = r.messages;
    if (h.step === 'qr') {
      if (m.hello) await this.onHello(h, m.hello.body, r.chain);
      return;
    }
    if (m.done) {
      const body = m.done.body;
      if (typeof body.refused === 'string') { this.fail(h, refusedCode(body.refused)); return; }
      await this.finishJoin(h, body.entry_hash);
      return;
    }
    // `challenge` only counts after our `commit`; the phone creates it only then.
    if (m.challenge && !h.opened && h.entry && h.entrySigBytes && h.rJ) {
      const dk = await deviceKeys();
      const rA = dk.b64uDecode(m.challenge.body.r_a as string);
      const sent = await h.box.send('open', { entry: h.entry, sig: dk.b64uEncode(h.entrySigBytes), r_j: dk.b64uEncode(h.rJ) });
      if (!sent.ok) { this.fail(h, sent.code); return; }
      h.opened = true;
      h.code = await dk.comparisonCode(h.pairing.macKey, h.entry, h.rJ, rA);
      h.step = 'compare';
    }
  }

  /** Message 1. The chain it names is verified from the genesis on BEFORE the person sees anything; the server's word is not taken. */
  private async onHello(h: JoinHeld, body: Record<string, unknown>, mailChain: { root_did: string; entries: unknown[]; head: { seq: number; hash: string } } | undefined): Promise<void> {
    const dk = await deviceKeys();
    const lib = await pairingLib();
    const rootDid = body.root_did;
    const head = body.head;
    const keyId = body.key_id;
    if (typeof rootDid !== 'string' || !isObj(head) || typeof head.seq !== 'number' || typeof head.hash !== 'string' || typeof keyId !== 'string') { this.fail(h, 'bad_message'); return; }
    // The phone must pin the same Authority Server this computer trusts.
    if (body.as_key !== h.asKey) { this.fail(h, 'as_key_mismatch'); return; }
    if (!mailChain || !Array.isArray(mailChain.entries)) { this.fail(h, 'as_answer_invalid'); return; }
    let chain: ChainState;
    try {
      chain = await dk.verifyChain({ expectedRootDid: rootDid, entries: mailChain.entries });
      dk.checkNamedHead(chain, head.seq, head.hash);
    } catch (e) {
      this.fail(h, isDeviceKeysError(e) && e.code === 'FORK' ? 'chain_fork' : 'chain_invalid');
      return;
    }
    const admitter = chain.devices[keyId];
    if (!admitter || admitter.removed_seq !== null || admitter.check === null) { this.fail(h, 'admitter_cannot_grant'); return; }
    if (dk.activeDevices(chain).length >= dk.MAX_ACTIVE_DEVICES) { this.fail(h, 'too_many_devices'); return; }
    const entries = mailChain.entries as ChainEntry[];
    h.chain = chain;
    h.entries = entries;
    h.admitter = { keyId, label: admitter.label };
    let suggestedLabel = DEFAULT_DEVICE_LABEL;
    for (let n = 2; lib.labelTaken(chain, suggestedLabel) && n < 20; n++) suggestedLabel = `${DEFAULT_DEVICE_LABEL} ${n}`;
    this.reviewFacts = {
      identityCode: await dk.identityCode(rootDid),
      origin: lib.originOf(entries),
      devices: lib.deviceRows(entries, chain, '', this.now()),
      suggestedLabel,
    };
    h.step = 'review';
  }

  /** The person read who this computer would join and chose a name. Builds the entry, signs it (its own touch where it has a check key), commits. */
  async joinConfirm(rawLabel: unknown): Promise<PairingView> {
    this.requireVault();
    const h = this.h;
    if (this.busy) refuse(409, 'pairing_busy');
    if (!h || h.role !== 'join' || h.step !== 'review' || !h.chain || !h.admitter || !h.entries) return refuse(409, 'pairing_unknown');
    if (typeof rawLabel !== 'string') return refuse(400, 'bad_request');
    const dk = await deviceKeys();
    const lib = await pairingLib();
    const label = rawLabel.normalize('NFC').trim();
    h.reviewError = undefined;
    if (!dk.isValidLabel(label)) { h.reviewError = 'label_invalid'; return this.view(); }
    if (lib.labelTaken(h.chain, label)) { h.reviewError = 'label_taken'; return this.view(); }
    if (this.d.store.exists()) return refuse(409, 'already_set_up');
    this.busy = true;
    try {
      h.label = label;
      const signing = await loadOrGenerateDeviceSigningKey(this.d.vault);
      const reading = await loadOrGenerateKeyPair(this.d.vault);
      const device = await dk.buildDeviceRecord({
        sign_pub: dk.b64uEncode(signing.publicKey), read_pub: dk.b64uEncode(reading.publicKey),
        kind: 'gateway', label, keystore: 'software',
        ...(h.checkKey ? { check: platformCheckKey(h.checkKey.publicKey) } : {}),
      }, signing.publicKey);
      const entry = dk.buildEntry({
        root_did: h.chain.root_did, seq: h.chain.head.seq + 1, prev: h.chain.head.hash, op: 'add',
        created_at: this.now(), signer: h.admitter.keyId, device,
      });
      const sig = await dk.signEntry(entry, device.key_id, signing.privateSeed);
      if (h.checkKey && this.d.checks) {
        // Its own check over the same entry: it proves this computer holds the check key it names. One touch.
        h.step = 'working';
        h.doing = 'check';
        const signed = await this.d.checks.sign(h.checkKey, dk.entrySignedBytes(entry));
        entry.checks = [{ by: device.key_id, check: platformCheckProof(signed.signature) }];
      }
      h.step = 'working';
      h.doing = 'send';
      const sigBytes = dk.b64uDecode(sig.sig);
      const rJ = dk.randomBytes(32);
      const c = await dk.pairingCommitment(entry, sigBytes, rJ);
      const sent = await h.box.send('commit', { c });
      if (!sent.ok) { this.fail(h, sent.code); return this.view(); }
      h.entry = entry;
      h.entryHash = await dk.entryHash(entry);
      h.entrySigBytes = sigBytes;
      h.rJ = rJ;
      h.step = 'waiting';
    } catch (e) {
      if (e instanceof CheckError) this.fail(h, checkCode(e));
      else { this.fail(h, 'generic'); console.error('[Control Plane] Pairing error:', e instanceof Error ? e.name : 'error'); }
    } finally {
      this.busy = false;
    }
    return this.view();
  }

  /** `done` named an entry hash: it must be the entry this computer built. Then the chain is stored and this computer signs in. */
  private async finishJoin(h: JoinHeld, answered: unknown): Promise<void> {
    if (!h.entry || !h.entryHash || !h.label || !h.chain) return;
    if (answered !== h.entryHash) { this.fail(h, 'head_mismatch'); return; }
    await this.complete(h);
  }

  /** The mailbox is gone or late and no `done` came. The Authority Server may still hold our entry: a sign-in proves it. */
  private async reconcile(h: JoinHeld): Promise<void> {
    if (!h.entry || !h.entryHash || !h.chain) { this.fail(h, 'qr_expired'); return; }
    const probe = await this.d.signin.performSignIn(
      { rootDid: h.chain.root_did, keyId: h.entry.device!.key_id, head: { seq: h.entry.seq, hash: h.entryHash } },
      { storeHead: false, probe: true },
    );
    if (!probe.ok) { this.fail(h, 'qr_expired'); return; }
    await this.complete(h);
  }

  private async complete(h: JoinHeld): Promise<void> {
    const entry = h.entry as ChainEntry;
    const chain = h.chain as ChainState;
    // The check key's slot first: from the moment the chain says this computer has a check key, the password is no longer a
    // confirmation here. If the chain cannot be stored the slot is emptied again.
    if (h.checkKey) {
      if (!this.d.checkStore) { this.fail(h, 'generic'); return; }
      this.d.checkStore.write(h.checkKey);
    }
    try {
      this.d.store.create({
        v: 1, rootDid: chain.root_did, keyId: (entry.device as NonNullable<ChainEntry['device']>).key_id,
        head: { seq: entry.seq, hash: h.entryHash as string }, asUrl: this.d.client.asUrl, label: h.label as string, setUpAt: entry.created_at,
      });
    } catch (e) {
      if (h.checkKey) { try { this.d.checkStore!.write(null); } catch { /* the original error is the one to report */ } }
      this.fail(h, 'store_failed');
      console.error('[Control Plane] Pairing error:', e instanceof Error ? e.name : 'error');
      return;
    }
    h.checkKey = undefined;
    h.rJ = undefined; h.entrySigBytes = undefined; h.code = undefined;
    // The sign-in verifies the Authority Server's chain from the genesis on and finds this computer's entry in it.
    const r = await this.d.signin.signIn();
    h.result = { signedIn: r.ok, ...(r.ok ? {} : { signinCode: r.code }) };
    h.step = 'done';
  }

  // ─── one look ───────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    const h = this.h;
    if (!h || this.busy) return;
    this.busy = true;
    try {
      if (h.role === 'admit') await this.pollAdmit(h); else await this.pollJoin(h);
    } catch (e) {
      if (e instanceof PairingRefusal) this.fail(h, e.code);
      else { this.fail(h, 'generic'); console.error('[Control Plane] Pairing error:', e instanceof Error ? e.name : 'error'); }
    } finally {
      this.busy = false;
    }
  }
}
