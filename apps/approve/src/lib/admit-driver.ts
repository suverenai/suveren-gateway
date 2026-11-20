/**
 * This phone ADMITS a new computer: the new gateway shows a QR (`shown_by: "joiner"`), this phone scans it (plan 4.3; 20.11;
 * step 11 "the app admits a gateway"). The phone is a granting device: it signs the `add` entry and checks it with its passkey.
 *
 *   scan      the QR's `as_key` must be the one this phone pinned; the phone creates the mailbox and says `hello`
 *   opening   waits for the computer's `commit`, answers with `challenge`, waits for `open`
 *   choose    one screen (20.11): the new device's kind and label, THREE 6-digit codes, the resulting device list. The person taps
 *             the code the computer shows. A wrong tap ends the pairing and adds nothing
 *   checking  the phone's passkey checks the entry, the full chain is verified locally, the entry is appended, `done` is sent
 *   done      the whole device list, from the chain the phone fetched again
 *
 * What the phone checks before it shows a code: the computer's entry is exactly an `add` of a computer that extends this phone's
 * own verified head, signed by the computer's key; the commitment of message 2 matches message 4; the label is not taken. The
 * AS and every other device verify the same entry again (3.3).
 */
import {
  b64uEncode, comparisonCode, decodePairingQr, entryHash, entrySignedBytes, randomBytes,
  verifyChain, MAX_ACTIVE_DEVICES, activeDevices,
  type ChainEntry, type PairingQr,
} from '@hap/core/device-keys';
import { checkOpen, codeChoices, OpenCheckError } from '@suveren/pairing';
import { Driver } from './driver';
import type { DeviceKeyStore } from './key-store';
import type { CheckDevice } from './check';
import { CheckError } from './check';
import type { AsApi } from './as-api';
import type { AccountStore, StoredAccount } from './account-store';
import type { DeviceSession } from './session';
import { deviceRows, type DeviceRow } from './chain-view';
import { Mailbox, pairingKeysOf, type PairingKeys } from './mailbox';
import { errorText } from '../texts';

export interface AdmitChoice {
  /** Three 6-digit codes, one of them the real one, in random order. */
  codes: string[];
  kind: 'gateway' | 'approve-app';
  label: string;
  /** The device list as it would be after the add; the new device is marked. */
  rows: Array<DeviceRow & { adding?: boolean }>;
}

export type AdmitState =
  | { step: 'scan'; busy: boolean; error?: string }
  | { step: 'opening' }
  | { step: 'choose'; choice: AdmitChoice; error?: string }
  | { step: 'checking' }
  | { step: 'failed'; error: string }
  | { step: 'done'; label: string; rows: DeviceRow[] };

export interface AdmitDeps {
  keys: DeviceKeyStore;
  check: CheckDevice;
  api: AsApi;
  accounts: AccountStore;
  session: DeviceSession;
  /** Epoch seconds. */
  now: () => number;
}

interface Held {
  qr: PairingQr;
  pairing: PairingKeys;
  box: Mailbox;
  account: StoredAccount;
  commit?: string;
  rA?: Uint8Array;
  /** After `open` was verified. */
  entry?: ChainEntry;
  joinerSig?: string;
  code?: string;
}

// `codeChoices` (the real code and two others) is the shared package's; kept exported here for the phone's tests.
export { codeChoices };

export class AdmitDriver extends Driver<AdmitState> {
  private h: Held | null = null;

  constructor(private readonly d: AdmitDeps, initial: AdmitState = { step: 'scan', busy: false }) {
    super(initial);
  }

  dispose(): void { this.h = null; }

  cancel(): void {
    this.h = null;
    this.set({ step: 'scan', busy: false });
  }

  private setScanError(code: string): void {
    this.h = null;
    this.set({ step: 'scan', busy: false, error: errorText(code) });
  }

  // ─── scan ───────────────────────────────────────────────────────────────────

  async scanned(text: string): Promise<void> {
    const st = this.state;
    if (st.step !== 'scan' || st.busy) return;
    this.set({ step: 'scan', busy: true });
    const d = this.d;
    try {
      const account = await d.accounts.read();
      const session = d.session.current();
      const bearer = d.session.bearer();
      if (!account || !session || !bearer) return this.setScanError('session_ended');
      let qr: PairingQr;
      try {
        qr = decodePairingQr(text, { now: d.now() });
      } catch (e) {
        return this.setScanError((e as { code?: string }).code === 'QR_EXPIRED' ? 'qr_expired' : 'qr_invalid');
      }
      // A QR shown by a device that already holds the account is for a phone that joins, not for this phone to admit.
      if (qr.shown_by !== 'joiner') return this.setScanError('qr_wrong_kind');
      if (qr.as_url !== account.as_url) return this.setScanError('qr_other_server');
      // Plan 4.3 step 2: the phone that admits compares `as_key` with its own pin and refuses a difference.
      if (qr.as_key !== account.as_key) return this.setScanError('as_key_mismatch');
      if (activeDevices(session.chain).length >= MAX_ACTIVE_DEVICES) return this.setScanError('too_many_devices');
      const own = session.chain.devices[account.key_id];
      if (!own || own.removed_seq !== null || own.check === null) return this.setScanError('cannot_grant');

      const pairing = await pairingKeysOf(qr);
      const made = await d.api.createMailbox(pairing.pairingId, qr.expires_at, bearer);
      if (!made.ok) return this.setScanError(made.status === 0 ? 'as_unreachable' : made.code === 'SESSION_EXPIRED' ? 'session_ended' : 'mailbox_refused');
      d.session.noteUse();
      const box = new Mailbox(d.api, pairing);
      const hello = await box.send('hello', { root_did: account.root_did, head: session.chain.head, key_id: account.key_id, as_key: account.as_key });
      if (!hello.ok) return this.setScanError(hello.code === 'as_unreachable' ? 'as_unreachable' : 'mailbox_refused');
      this.h = { qr, pairing, box, account };
      this.set({ step: 'opening' });
    } catch {
      this.setScanError('generic');
    }
  }

  // ─── the mailbox, polled ──────────────────────────────────────────────────

  async poll(): Promise<void> {
    const h = this.h;
    if (!h || this.state.step !== 'opening') return;
    if (this.d.now() > h.qr.expires_at) { await this.stop('qr_expired', false); return; }
    const r = await h.box.poll();
    if (!r.ok) {
      if (r.code === 'bad_message') await this.stop('bad_message', true);
      return;
    }
    const m = r.messages;
    if (m.commit && !h.commit) {
      h.commit = m.commit.body.c as string;
      h.rA = randomBytes(32);
      const sent = await h.box.send('challenge', { r_a: b64uEncode(h.rA) });
      if (!sent.ok) { await this.stop(sent.code, false); return; }
    }
    if (m.open && h.commit && h.rA) await this.onOpen(h, m.open.body);
  }

  /** Message 4. Every check of plan 4.3 that the phone can make before the person is asked. */
  private async onOpen(h: Held, body: Record<string, unknown>): Promise<void> {
    const d = this.d;
    const session = d.session.current();
    if (!session) { await this.stop('session_ended', false); return; }
    let entry: ChainEntry;
    let rJ: Uint8Array;
    let joinerSig: string;
    try {
      ({ entry, rJ, joinerSig } = await checkOpen(body, {
        chain: session.chain, rootDid: h.account.root_did, admitterKeyId: h.account.key_id, kind: 'gateway', commit: h.commit as string, now: d.now(),
      }));
    } catch (e) {
      await this.stop(e instanceof OpenCheckError ? e.code : 'open_invalid', true);
      return;
    }
    h.entry = entry;
    h.joinerSig = joinerSig;
    h.code = await comparisonCode(h.pairing.macKey, entry, rJ, h.rA as Uint8Array);
    const dev = entry.device as NonNullable<ChainEntry['device']>;
    const rows: AdmitChoice['rows'] = [
      ...deviceRows(session.entries, session.chain, h.account.key_id, d.now()),
      { keyId: dev.key_id, label: dev.label, kind: dev.kind, thisDevice: false, canGrant: dev.check !== null, addedAt: entry.created_at, recent: true, adding: true },
    ];
    this.set({ step: 'choose', choice: { codes: codeChoices(h.code), kind: dev.kind, label: dev.label, rows } });
  }

  // ─── the person's choice, the check, the append ────────────────────────────

  async choose(code: string): Promise<void> {
    const st = this.state;
    const h = this.h;
    if (st.step !== 'choose' || !h?.entry || !h.code || !h.joinerSig) return;
    // A wrong tap ends the pairing and adds nothing.
    if (code !== h.code) { await this.stop('wrong_code', true, 'CODE_MISMATCH'); return; }
    this.set({ step: 'checking' });
    const d = this.d;
    try {
      const session = d.session.current();
      const bearer = d.session.bearer();
      if (!session || !bearer) { await this.stop('session_ended', false); return; }
      const entry = h.entry;
      const hash = await entryHash(entry);
      const proof = await d.check.prove(h.account.check.cred_id, hash);
      const sig = await this.sign(entry);
      const final: ChainEntry = {
        ...entry,
        sigs: [{ by: h.account.key_id, sig }, { by: (entry.device as NonNullable<ChainEntry['device']>).key_id, sig: h.joinerSig }],
        checks: [...entry.checks, { by: h.account.key_id, check: proof }],
      };
      // The same check the server and every device make (3.3): a defect found here is found before anything is sent.
      await verifyChain({ expectedRootDid: h.account.root_did, entries: [...session.entries, final] });

      const res = await d.api.appendEntry(final, bearer);
      d.session.noteUse();
      if (!res.ok) {
        const refused = res.code === 'CHAIN_HEAD_MOVED' ? 'CHAIN_HEAD_MOVED' : res.status === 0 ? 'AS_UNREACHABLE' : res.code;
        await h.box.send('done', { refused }).catch(() => {});
        this.h = null;
        this.set({ step: 'failed', error: errorText(res.code === 'CHAIN_HEAD_MOVED' ? 'chain_moved' : res.status === 0 ? 'as_unreachable' : res.code) });
        return;
      }
      await h.box.send('done', { entry_hash: hash }).catch(() => { /* the computer also finds its entry in the chain */ });
      this.h = null;
      // The list the person confirms (plan 4.3 step 7) comes from the chain fetched again, not from what the phone built.
      const fresh = await d.session.refreshChain();
      if (!fresh.ok) { this.set({ step: 'failed', error: errorText(fresh.code) }); return; }
      this.set({ step: 'done', label: (entry.device as NonNullable<ChainEntry['device']>).label, rows: deviceRows(fresh.session.entries, fresh.session.chain, h.account.key_id, d.now()) });
    } catch (e) {
      this.h = null;
      if (e instanceof CheckError) {
        await h.box.send('done', { refused: 'CHECK_CANCELLED' }).catch(() => {});
        this.set({ step: 'failed', error: errorText(e.code === 'failed' ? 'check_failed' : e.code) });
        return;
      }
      this.set({ step: 'failed', error: errorText('generic') });
    }
  }

  /** The phone's own signature over the entry (base64url). */
  private async sign(entry: ChainEntry): Promise<string> {
    return b64uEncode(await this.d.keys.sign(entrySignedBytes(entry)));
  }

  /** Stop the pairing; `tell` sends `done` with a refusal so the other device stops too. */
  private async stop(code: string, tell: boolean, refused?: string): Promise<void> {
    const h = this.h;
    this.h = null;
    if (tell && h) await h.box.send('done', { refused: refused ?? code.toUpperCase() }).catch(() => {});
    this.set({ step: 'failed', error: errorText(code) });
  }
}
