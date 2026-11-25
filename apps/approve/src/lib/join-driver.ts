/**
 * This phone JOINS an existing identity: another device that holds the account (a computer with its check key, or another
 * phone) shows a QR (`shown_by: "admitter"`), this phone scans it and is admitted (plan 4.3; step 11; 20.17 point 2).
 *
 *   scan      the QR is read inside the app (scan.ts); it carries a secret the server never sees
 *   review    BEFORE this phone makes any key: who it would join. The chain in the mailbox is verified from the genesis on,
 *             the admitter must be a granting device, and the person sees the identity code, where and when the identity was
 *             made and every active device. (This is the part of the joining ceremony of 20.17 that D1 carries; the offer to
 *             replace the recovery code is D3.)
 *   name      what this phone is called
 *   working   keys, passkey, the `add` entry signed by this phone and checked with its passkey, then the COMMITMENT (message
 *             2) so nobody can search for an entry with a chosen comparison code (D19)
 *   compare   after the admitter's `challenge` this phone sends `open` and shows the 6-digit comparison code. The person
 *             confirms on the admitter, which signs and appends the entry
 *   done      the admitter said `done` with the hash of the entry it stored; the phone checks it is the entry it built, stores
 *             the account, and the sign-in that follows finds its own entry in the verified chain
 *
 * The driver has no timers: the screen calls {@link poll} every few seconds while a step waits.
 */
import {
  buildEntry, checkNamedHead, comparisonCode, decodePairingQr, entryHash, identityCode, isValidLabel,
  pairingCommitment, randomBytes, verifyChain, b64uDecode, b64uEncode,
  type ChainEntry, type ChainState, type PairingQr,
} from '@hap/core/device-keys';
import { entryInChain } from '@suveren/pairing';
import { Driver } from './driver';
import type { DeviceKeyStore } from './key-store';
import type { CheckDevice } from './check';
import { CheckError } from './check';
import type { AsApi } from './as-api';
import type { Transport } from './transport';
import type { AccountStore } from './account-store';
import { proveAsKey } from './as-key';
import { checkElement, checkKeyOf, phoneRecord, signWithPhone } from './device-record';
import { deviceRows, labelTaken, originOf, type DeviceRow, type Origin } from './chain-view';
import { Mailbox, pairingKeysOf, type PairingKeys } from './mailbox';
import { cleanLabel } from './register-driver';
import { errorText } from '../texts';

/** What the person sees before this phone trusts the chain. */
export interface JoinFacts {
  /** 24 digits in 6 groups of 4 (hap-core `identityCode`). */
  identityCode: string;
  origin: Origin | null;
  devices: DeviceRow[];
  /** The label of the device that shows the QR. */
  admitterLabel: string;
}

export type JoinState =
  | { step: 'scan'; busy: boolean; error?: string }
  | { step: 'review'; facts: JoinFacts; error?: string }
  | { step: 'name'; busy: boolean; admitterLabel: string; error?: string }
  | { step: 'working'; doing: 'keys' | 'passkey' | 'sign' | 'check' | 'send' }
  | { step: 'waiting'; admitterLabel: string }
  | { step: 'compare'; code: string; admitterLabel: string }
  | { step: 'failed'; error: string }
  | { step: 'done' };

export interface JoinDeps {
  keys: DeviceKeyStore;
  check: CheckDevice;
  transport: Transport;
  api: AsApi;
  accounts: AccountStore;
  asUrl: string;
  /** Epoch seconds. */
  now: () => number;
}

/** What is held between the steps. Nothing of it is stored. */
interface Held {
  qr: PairingQr;
  pairing: PairingKeys;
  chain: ChainState;
  entries: ChainEntry[];
  admitterLabel: string;
  box: Mailbox;
  // after `working`
  keyId?: string;
  entry?: ChainEntry;
  entrySig?: Uint8Array;
  rJ?: Uint8Array;
  opened?: boolean;
  label?: string;
  rpId?: string;
  credId?: string;
}

export class JoinDriver extends Driver<JoinState> {
  private h: Held | null = null;

  constructor(private readonly d: JoinDeps, initial: JoinState = { step: 'scan', busy: false }) {
    super(initial);
  }

  dispose(): void { this.h = null; }

  /** Start over at the scan. Keys made by an unfinished try are removed (no account was stored, so they belong to nothing). */
  async cancel(): Promise<void> {
    this.h = null;
    if (!(await this.d.accounts.read())) await this.d.keys.deleteAll().catch(() => {});
    this.set({ step: 'scan', busy: false });
  }

  private fail(code: string): void {
    this.set({ step: 'failed', error: errorText(code) });
  }

  // ─── scan and review ───────────────────────────────────────────────────────

  async scanned(text: string): Promise<void> {
    const st = this.state;
    if (st.step !== 'scan' || st.busy) return;
    this.set({ step: 'scan', busy: true });
    const d = this.d;
    try {
      if (await d.accounts.read()) return this.setScanError('already_paired');
      let qr: PairingQr;
      try {
        qr = decodePairingQr(text, { now: d.now() });
      } catch (e) {
        return this.setScanError((e as { code?: string }).code === 'QR_EXPIRED' ? 'qr_expired' : 'qr_invalid');
      }
      // A phone that scans a QR shown by a NEW computer is the admitter's job, not a join.
      if (qr.shown_by !== 'admitter') return this.setScanError('qr_wrong_kind');
      if (qr.as_url !== d.asUrl) return this.setScanError('qr_other_server');
      const key = await proveAsKey(d.transport, qr.as_key, d.now);
      if (!key.ok) return this.setScanError(key.code);

      const pairing = await pairingKeysOf(qr);
      const box = new Mailbox(d.api, pairing);
      const polled = await box.poll();
      if (!polled.ok) return this.setScanError(polled.code === 'mailbox_missing' ? 'qr_not_open' : polled.code);
      if (!polled.chain) return this.setScanError('as_answer_invalid');

      // The chain, from the genesis on, against the root DID in the QR (never against what the server says).
      let chain: ChainState;
      try {
        chain = await verifyChain({ expectedRootDid: qr.root_did as string, entries: polled.chain.entries });
        checkNamedHead(chain, (qr.head as { seq: number }).seq, (qr.head as { hash: string }).hash);
      } catch (e) {
        return this.setScanError((e as { code?: string }).code === 'FORK' ? 'chain_fork' : 'chain_invalid');
      }
      const admitter = chain.devices[qr.key_id as string];
      if (!admitter || admitter.removed_seq !== null || admitter.check === null) return this.setScanError('admitter_cannot_grant');

      const entries = polled.chain.entries as ChainEntry[];
      this.h = { qr, pairing, chain, entries, admitterLabel: admitter.label, box };
      this.set({
        step: 'review',
        facts: {
          identityCode: await identityCode(qr.root_did as string),
          origin: originOf(entries),
          devices: deviceRows(entries, chain, '', d.now()),
          admitterLabel: admitter.label,
        },
      });
    } catch {
      this.setScanError('generic');
    }
  }

  private setScanError(code: string): void {
    this.h = null;
    this.set({ step: 'scan', busy: false, error: errorText(code) });
  }

  /** The person looked at the account and wants this phone added to it. */
  confirmReview(): void {
    if (this.state.step === 'review' && this.h) this.set({ step: 'name', busy: false, admitterLabel: this.h.admitterLabel });
  }

  // ─── name, then everything that makes the entry ───────────────────────────

  async submitName(raw: string): Promise<void> {
    const st = this.state;
    if (st.step !== 'name' || st.busy || !this.h) return;
    const label = cleanLabel(raw);
    if (!isValidLabel(label)) { this.set({ ...st, error: errorText('label_invalid') }); return; }
    if (labelTaken(this.h.chain, label)) { this.set({ ...st, error: errorText('label_taken') }); return; }
    this.h.label = label;
    await this.make();
  }

  private async make(): Promise<void> {
    const h = this.h;
    if (!h || !h.label) return;
    const d = this.d;
    try {
      this.set({ step: 'working', doing: 'keys' });
      if (await d.keys.exists()) await d.keys.deleteAll();
      const pk = await d.keys.create();
      h.keyId = pk.keyId;

      this.set({ step: 'working', doing: 'passkey' });
      const reg = await d.check.register(pk.keyId, h.label);
      h.rpId = reg.rp_id;
      h.credId = reg.cred_id;

      this.set({ step: 'working', doing: 'sign' });
      const device = await phoneRecord(pk, h.label, checkKeyOf(reg));
      const entry = buildEntry({
        root_did: h.qr.root_did as string, seq: h.chain.head.seq + 1, prev: h.chain.head.hash, op: 'add',
        created_at: d.now(), signer: h.qr.key_id as string, device,
      });
      const mine = await signWithPhone(d.keys, entry, pk.keyId);
      h.entrySig = b64uDecode(mine.sig);

      this.set({ step: 'working', doing: 'check' });
      entry.checks = [checkElement(pk.keyId, await d.check.prove(reg.cred_id, await entryHash(entry)))];
      h.entry = entry;

      this.set({ step: 'working', doing: 'send' });
      // The passkey registration goes to the server under the pairing id, for the admitter's `add` (plan 3.2 rule 2a; see the hand-over).
      const pk2 = await d.api.postPairingPasskey(h.pairing.pairingId, reg);
      if (!pk2.ok) { await this.abort(pk2.status === 0 ? 'as_unreachable' : pk2.code); return; }
      h.rJ = randomBytes(32);
      const c = await pairingCommitment(entry, h.entrySig, h.rJ);
      const sent = await h.box.send('commit', { c });
      if (!sent.ok) { await this.abort(sent.code); return; }
      this.set({ step: 'waiting', admitterLabel: h.admitterLabel });
    } catch (e) {
      await d.keys.deleteAll().catch(() => {});
      this.h = null;
      if (e instanceof CheckError) { this.set({ step: 'failed', error: errorText(e.code === 'failed' ? 'check_failed' : e.code) }); return; }
      this.fail('generic');
    }
  }

  /** Stop: this phone made keys and nothing came of it. */
  private async abort(code: string): Promise<void> {
    await this.d.keys.deleteAll().catch(() => {});
    this.h = null;
    this.fail(code);
  }

  // ─── the mailbox, polled ──────────────────────────────────────────────────

  async poll(): Promise<void> {
    const h = this.h;
    const st = this.state;
    if (!h || (st.step !== 'waiting' && st.step !== 'compare')) return;
    if (this.d.now() > (h.qr.expires_at as number) + 60 && st.step === 'waiting') { await this.abort('qr_expired'); return; }
    const r = await h.box.poll();
    if (!r.ok) {
      // A mailbox that cannot be read right now is tried again; one that cannot be trusted ends the pairing.
      if (r.code === 'bad_message') await this.abort('bad_message');
      return;
    }
    const m = r.messages;

    if (m.done) {
      const body = m.done.body;
      if (typeof body.refused === 'string') { await this.abort(body.refused === 'CODE_MISMATCH' ? 'wrong_code' : body.refused); return; }
      // A `done` that names an entry counts only after this phone sent `open` (the person is at the comparison); earlier it is not the answer to anything.
      if (st.step === 'compare') await this.finish(body.entry_hash as string, r.chain);
      return;
    }
    // `challenge` only counts after our `commit`; the admitter creates it only then.
    if (m.challenge && !h.opened && h.entry && h.entrySig && h.rJ) {
      const rA = b64uDecode(m.challenge.body.r_a as string);
      const sent = await h.box.send('open', { entry: h.entry, sig: b64uEncode(h.entrySig), r_j: b64uEncode(h.rJ) });
      if (!sent.ok) { await this.abort(sent.code); return; }
      h.opened = true;
      this.set({ step: 'compare', code: await comparisonCode(h.pairing.macKey, h.entry, h.rJ, rA), admitterLabel: h.admitterLabel });
    }
  }

  private async finish(entryHashAnswered: string, chain: { root_did: string; entries: unknown[] } | undefined): Promise<void> {
    const h = this.h;
    const d = this.d;
    if (!h?.entry || !h.keyId || !h.label || !h.rpId || !h.credId) return;
    const mine = await entryHash(h.entry);
    // The admitter must have stored the entry this phone built, no other.
    if (entryHashAnswered !== mine) { await this.abort('head_mismatch'); return; }
    // The `done` message is the admitter's word. Nothing is kept until the chain the server shows holds this phone's entry (verified from
    // the genesis on): the shared check of @suveren/pairing, the same one the gateway page makes.
    if (!(await entryInChain(chain, { rootDid: h.qr.root_did as string, seq: h.entry.seq, hash: mine, keyId: h.keyId }))) { await this.abort('head_mismatch'); return; }
    try {
      const as = await proveAsKey(d.transport, h.qr.as_key, d.now);
      if (!as.ok) { await this.abort(as.code); return; }
      await d.accounts.write({
        v: 1, as_url: d.asUrl, as_key: h.qr.as_key, root_did: h.qr.root_did as string, key_id: h.keyId, label: h.label,
        head: { seq: h.entry.seq, hash: mine }, check: { rp_id: h.rpId, cred_id: h.credId }, paired_at: d.now(),
      });
    } catch {
      await this.abort('store_failed');
      return;
    }
    this.h = null;
    this.set({ step: 'done' });
  }
}

