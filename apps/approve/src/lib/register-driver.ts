/**
 * Register this phone as the FIRST device of a new identity (plan 3.2 `genesis`, 6.2 "genesis from a phone", 8, 20.9, 20.10;
 * step 11). The person comes from suveren.ai with an enrolment code.
 *
 *   code     the one-time enrolment code (scanned or typed); the app asks the server for its key and makes it prove it holds it
 *   name     what this phone is called in the device list
 *   sheet    the recovery code, shown ONCE (the phone makes it; the server never sees it)
 *   kept     "I wrote it down"
 *   working  keys, passkey (Face ID: asked twice, once to make it and once to check the entry), the signed `genesis`, the
 *            server's answer checked against the entry the phone built, the account stored
 *   done
 *
 * Until `working` nothing is made or stored, so "cancel" is true: the code stops working because nobody has it. The recovery
 * code lives in this driver's memory only, from the sheet to the answer; it is never in the state, a store or a request. The
 * root key (derived from it) signs the `genesis` and is dropped; nothing after set-up signs with it on this phone.
 *
 * The phone pins its own identity: the root DID it made is stored, and the sign-in that follows refuses a server that names
 * another (session.ts). The person's own registration compares no identity code (20.9).
 */
import {
  buildEntry, deriveRootKey, entryHash, generateRecoveryCode, isValidLabel, parseRecoveryCode, signEntry, verifyChain,
  type ChainEntry,
} from '@hap/core/device-keys';
import { Driver } from './driver';
import type { DeviceKeyStore } from './key-store';
import type { CheckDevice } from './check';
import { CheckError } from './check';
import type { AsApi } from './as-api';
import type { Transport } from './transport';
import type { AccountStore } from './account-store';
import { learnAsKey } from './as-key';
import { checkKeyOf, checkElement, phoneRecord, signWithPhone } from './device-record';
import { errorText } from '../texts';

export type RegisterState =
  | { step: 'code'; busy: boolean; error?: string }
  | { step: 'name'; busy: boolean; error?: string }
  | { step: 'sheet'; error?: string }
  | { step: 'kept'; checked: boolean; error?: string }
  | { step: 'working'; /** what is being done, for the one-line progress */ doing: 'keys' | 'passkey' | 'sign' | 'check' | 'send' }
  | { step: 'failed'; error: string; /** the recovery code is still on this phone's screen flow: the person can try again */ canRetry: boolean }
  | { step: 'done' };

export interface RegisterDeps {
  keys: DeviceKeyStore;
  check: CheckDevice;
  transport: Transport;
  api: AsApi;
  accounts: AccountStore;
  /** The Authority Server this build talks to. */
  asUrl: string;
  /** The app's own address's host: the passkey's relying-party id. */
  rpId: string;
  /** Epoch seconds. */
  now: () => number;
}

/** An enrolment code is 128 random bits in base64url (22 characters); the server accepts up to 128. */
const ENROLMENT_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

/** What a label is made of before it is checked: NFC, trimmed. */
export function cleanLabel(raw: string): string {
  return raw.normalize('NFC').trim();
}

export class RegisterDriver extends Driver<RegisterState> {
  /** The recovery code. Never in the state, never stored, never sent. */
  private code: string | null = null;
  private enrolment: string | null = null;
  private asKey: string | null = null;
  private label = '';

  constructor(private readonly d: RegisterDeps, initial: RegisterState = { step: 'code', busy: false }) {
    super(initial);
  }

  /** The code for the one screen that shows it. */
  recoveryCode(): string | null { return this.code; }

  /** Drop everything held in memory (the flow ended or the screen is left). */
  dispose(): void {
    this.code = null;
    this.enrolment = null;
  }

  /** Start over from the first step. Nothing was made yet, so nothing is left behind. */
  cancel(): void {
    this.dispose();
    this.asKey = null;
    this.label = '';
    this.set({ step: 'code', busy: false });
  }

  // ─── code ───────────────────────────────────────────────────────────────────

  async submitCode(text: string): Promise<void> {
    const st = this.state;
    if (st.step !== 'code' || st.busy) return;
    const code = text.trim();
    if (!ENROLMENT_SHAPE.test(code)) { this.set({ step: 'code', busy: false, error: errorText('enrolment_code_invalid') }); return; }
    this.set({ step: 'code', busy: true });
    const key = await learnAsKey(this.d.transport, this.d.now);
    if (!key.ok) { this.set({ step: 'code', busy: false, error: errorText(key.code) }); return; }
    this.enrolment = code;
    this.asKey = key.keyHex;
    this.set({ step: 'name', busy: false });
  }

  // ─── name, sheet ────────────────────────────────────────────────────────────

  async submitName(raw: string): Promise<void> {
    const st = this.state;
    if (st.step !== 'name' || st.busy) return;
    const label = cleanLabel(raw);
    if (!isValidLabel(label)) { this.set({ step: 'name', busy: false, error: errorText('label_invalid') }); return; }
    this.label = label;
    this.code ??= (await generateRecoveryCode()).code;
    this.set({ step: 'sheet' });
  }

  codeSeen(): void {
    if (this.state.step === 'sheet') this.set({ step: 'kept', checked: false });
  }

  toggleKept(checked: boolean): void {
    const st = this.state;
    if (st.step === 'kept') this.set({ ...st, checked, error: undefined });
  }

  // ─── finish ─────────────────────────────────────────────────────────────────

  async finish(): Promise<void> {
    const st = this.state;
    const retry = st.step === 'failed' && st.canRetry;
    if (!(st.step === 'kept' && st.checked) && !retry) return;
    if (!this.code || !this.enrolment || !this.asKey) { this.set({ step: 'failed', error: errorText('generic'), canRetry: false }); return; }
    const d = this.d;
    try {
      if (await d.accounts.read()) { this.set({ step: 'failed', error: errorText('already_paired'), canRetry: false }); return; }

      this.set({ step: 'working', doing: 'keys' });
      // An unfinished earlier try left keys and no account: they belong to nothing, so a fresh set replaces them.
      if (await d.keys.exists()) await d.keys.deleteAll();
      const pk = await d.keys.create();

      this.set({ step: 'working', doing: 'passkey' });
      const reg = await d.check.register(pk.keyId, this.label);

      this.set({ step: 'working', doing: 'sign' });
      const root = await deriveRootKey(await parseRecoveryCode(this.code));
      const device = await phoneRecord(pk, this.label, checkKeyOf(reg));
      const entry: ChainEntry = buildEntry({ root_did: root.did, seq: 0, prev: null, op: 'genesis', created_at: d.now(), signer: 'root', device });
      entry.sigs = [await signEntry(entry, 'root', root.privateSeed), await signWithPhone(d.keys, entry, pk.keyId)];
      root.privateSeed.fill(0);
      const hash = await entryHash(entry);

      this.set({ step: 'working', doing: 'check' });
      entry.checks = [checkElement(pk.keyId, await d.check.prove(reg.cred_id, hash))];
      // The server will verify this; so does the phone, first. A defect here is the phone's, and it is found before anything is sent.
      await verifyChain({ expectedRootDid: root.did, entries: [entry] });

      this.set({ step: 'working', doing: 'send' });
      const res = await d.api.genesis(entry, this.enrolment, reg);
      if (!res.ok) { await this.undo(res.code); return; }
      // The answer must be about the entry the phone built (the gateway's rule too).
      if (res.data.head?.seq !== 0 || res.data.head?.hash !== hash) {
        await d.keys.deleteAll().catch(() => {});
        this.set({ step: 'failed', error: errorText('head_mismatch'), canRetry: false });
        return;
      }
      try {
        await d.accounts.write({
          v: 1, as_url: d.asUrl, as_key: this.asKey, root_did: root.did, key_id: pk.keyId, label: this.label,
          head: { seq: 0, hash }, check: { rp_id: reg.rp_id, cred_id: reg.cred_id }, paired_at: d.now(),
        });
      } catch {
        // The server holds the identity but this phone could not store it. The recovery code on paper is the way back.
        this.set({ step: 'failed', error: errorText('store_failed'), canRetry: false });
        return;
      }
      this.dispose();
      this.set({ step: 'done' });
    } catch (e) {
      await d.keys.deleteAll().catch(() => {});
      if (e instanceof CheckError) { this.set({ step: 'failed', error: errorText(e.code === 'failed' ? 'check_failed' : e.code), canRetry: true }); return; }
      this.set({ step: 'failed', error: errorText('generic'), canRetry: true });
    }
  }

  /**
   * The server refused the genesis (or did not answer): this phone's keys belong to nothing. Only "could not reach the server"
   * can be tried again with the same enrolment code; any refusal means the code is used up or wrong, and the person starts again
   * from suveren.ai.
   */
  private async undo(code: string): Promise<void> {
    await this.d.keys.deleteAll().catch(() => {});
    this.set({ step: 'failed', error: errorText(code), canRetry: code === 'as_unreachable' });
  }
}
