/**
 * Replace the recovery code on this phone (`rotate-root`; plan 10 "Recovery code exposed or to be replaced", DEC-37, 20.17;
 * DEC-85: offered once after the phone joined, with "Later", and kept under Devices until done; mockup D1–D5).
 *
 * The recovery code of an identity made on a computer was shown on that computer, where an AI may have seen it. Replacing it on
 * the phone needs three things (3.2): the OLD code (its root key signs the entry), this phone as a granting device (its
 * signature AND its touch over the entry), and the account's email (DEC-15): the Authority Server appends a root-signed entry
 * only after the person confirmed the mailed link (the hand-off, `return: "app"`: the link page on this phone confirms, and
 * this phone then finds its entry in the chain it reads with its own session).
 *
 *   old       the old code, typed or scanned from the recovery paper; it must derive the root key IN FORCE at the head
 *   new       the new code, shown ONCE ("Write it on paper", DEC-85) and typed again
 *   checking  the phone's touch over the entry; the whole chain verified locally with it; the hand-off staged
 *   waiting   "open the link in the email on this phone", the 6-digit code the link page must show; the chain is read again
 *             until the entry is in it (or the hand-off ran out)
 *   done
 *
 * Secrets: the codes live in this driver's memory only, never in the state's fields that a screen does not need, a store or a
 * request; the root keys' seeds are zeroed as soon as the entry is signed. The new code is in the state only while it is shown.
 * Order differs from mockup D1–D5 (email before the new code): the hand-off sends the email for a SIGNED entry, and the entry
 * names the new root key, so the new code exists and the touch is made before the email.
 */
import {
  b64uEncode, buildEntry, deriveRootKey, entryHash, entrySignedBytes, generateRecoveryCode, parseRecoveryCode,
  rootKeyFromRecoveryCode, signEntry, verifyChain, utf8, sha256,
  type ChainEntry, type ChainState,
} from '@hap/core/device-keys';
import { Driver } from './driver';
import type { DeviceKeyStore } from './key-store';
import type { CheckDevice } from './check';
import { CheckError } from './check';
import type { AsApi } from './as-api';
import type { AccountStore } from './account-store';
import type { DeviceSession } from './session';
import { errorText } from '../texts';

export type RotateState =
  | { step: 'idle' }
  | { step: 'old'; busy: boolean; error?: string }
  | { step: 'new'; code: string; error?: string }
  | { step: 'checking'; error?: string }
  | { step: 'waiting'; confirmCode: string; email: string | null; expiresAt: number }
  | { step: 'done' }
  | { step: 'failed'; error: string };

export interface RotateDeps {
  keys: DeviceKeyStore;
  check: CheckDevice;
  api: AsApi;
  accounts: AccountStore;
  session: DeviceSession;
  now: () => number;
}

/** The six-digit consistency code of the hand-off: the Authority Server's page shows the same one (its `confirmCodeOf`). */
export async function confirmCodeOf(hash: string): Promise<string> {
  const d = await sha256(new Uint8Array([...utf8('suveren-recovery-confirm-v1\u0000'), ...utf8(hash)]));
  const n = ((d[0] << 24) >>> 0) + (d[1] << 16) + (d[2] << 8) + d[3];
  return String(n % 1_000_000).padStart(6, '0');
}

/**
 * Is replacing the code still offered to this phone (DEC-85)? Yes when the phone joined an identity made elsewhere (it is not
 * the genesis device) and no `rotate-root` this phone co-signed came after it joined.
 */
export function rotateOffered(entries: readonly ChainEntry[], state: ChainState, ownKeyId: string): boolean {
  const me = state.devices[ownKeyId];
  if (!me || me.removed_seq !== null || me.added_seq === 0) return false;
  return !entries.some((e) => e.op === 'rotate-root' && e.seq > me.added_seq && e.sigs.some((s) => s.by === ownKeyId));
}

/** Where the code in force was made: the device that co-signed the last `rotate-root`, else the first device. */
export function codeMadeOn(entries: readonly ChainEntry[], state: ChainState): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.op === 'rotate-root') {
      const by = e.sigs.find((s) => s.by !== 'root')?.by;
      return by && state.devices[by] ? state.devices[by].label : null;
    }
  }
  return entries[0]?.device?.label ?? null;
}

/** "a•••@example.com": enough to recognise the address, not to read it out. */
export function maskEmail(email: string | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  return `${email[0]}•••${email.slice(at)}`;
}

export class RotateDriver extends Driver<RotateState> {
  private oldCode: string | null = null;
  private newCode: string | null = null;
  /** Bumped by Cancel: a touch that answers after it is ignored, and nothing is staged. */
  private gen = 0;
  private staged: { entry: ChainEntry; hash: string } | null = null;

  constructor(private readonly d: RotateDeps) {
    super({ step: 'idle' });
  }

  start(): void {
    this.newCode = null;
    this.staged = null;
    this.set({ step: 'old', busy: false });
  }

  /** Cancel while the touch is asked (or after it failed): back to the new code; a late answer stages nothing. */
  cancelTouch(): void {
    if (this.state.step !== 'checking' || !this.newCode) return;
    this.gen++;
    this.set({ step: 'new', code: this.newCode });
  }

  /** "Try again" after a failed touch: the new code was already typed again correctly. */
  async retryTouch(): Promise<void> {
    const st = this.state;
    if (st.step !== 'checking' || !st.error || !this.newCode) return;
    await this.sign();
  }

  cancel(): void {
    this.gen++;
    this.oldCode = null;
    this.newCode = null;
    this.staged = null;
    this.set({ step: 'idle' });
  }

  /** The old code: it must be the code IN FORCE for this account (its root key the one the verified chain names at its head). */
  async submitOld(text: string): Promise<void> {
    if (this.state.step !== 'old') return;
    this.set({ step: 'old', busy: true });
    const s = this.d.session.current();
    if (!s) { this.set({ step: 'failed', error: errorText('session_ended') }); return; }
    let root;
    try {
      root = await rootKeyFromRecoveryCode(text);
    } catch {
      this.set({ step: 'old', busy: false, error: errorText('recovery_code_invalid') });
      return;
    }
    const fits = b64uEncode(root.publicKey) === s.chain.root_pub;
    root.privateSeed.fill(0);
    if (!fits) { this.set({ step: 'old', busy: false, error: errorText('recovery_code_wrong') }); return; }
    this.oldCode = text;
    this.newCode = (await generateRecoveryCode()).code;
    this.set({ step: 'new', code: this.newCode });
  }

  /** The new code typed again, then the touch, the signatures, the local check and the hand-off. */
  async confirmNew(typed: string): Promise<void> {
    const st = this.state;
    if (st.step !== 'new' || !this.newCode || !this.oldCode) return;
    let same = false;
    try {
      const a = await parseRecoveryCode(typed);
      const b = await parseRecoveryCode(this.newCode);
      same = a.length === b.length && a.every((x, i) => x === b[i]);
    } catch {
      same = false;
    }
    if (!same) { this.set({ step: 'new', code: this.newCode, error: errorText('new_code_mismatch') }); return; }
    await this.sign();
  }

  /** The touch over the entry, the signatures, the local check, then the hand-off. */
  private async sign(): Promise<void> {
    if (!this.newCode || !this.oldCode) return;
    const gen = ++this.gen;
    this.set({ step: 'checking' });
    const d = this.d;
    const s = d.session.current();
    const account = await d.accounts.read();
    if (!s || !account) { this.set({ step: 'failed', error: errorText('session_ended') }); return; }
    const oldRoot = await rootKeyFromRecoveryCode(this.oldCode);
    const newRoot = await deriveRootKey(await parseRecoveryCode(this.newCode));
    try {
      const entry = buildEntry({
        root_did: account.root_did, seq: s.chain.head.seq + 1, prev: s.chain.head.hash, op: 'rotate-root',
        created_at: d.now(), signer: 'root', new_root: b64uEncode(newRoot.publicKey),
      });
      const hash = await entryHash(entry);
      const proof = await d.check.prove(account.check.cred_id, hash);
      const final: ChainEntry = {
        ...entry,
        sigs: [await signEntry(entry, 'root', oldRoot.privateSeed), { by: account.key_id, sig: b64uEncode(await d.keys.sign(entrySignedBytes(entry))) }],
        checks: [{ by: account.key_id, check: proof }],
      };
      // The same check the server and every device make (3.3): a defect found here is found before anything is sent.
      await verifyChain({ expectedRootDid: account.root_did, entries: [...s.entries, final] });
      // Cancelled while the touch was asked: nothing is staged, no email goes out.
      if (gen !== this.gen) return;
      const res = await d.api.stageRecovery(final);
      d.session.noteUse();
      if (!res.ok) {
        this.set({ step: 'failed', error: errorText(res.code === 'CHAIN_HEAD_MOVED' ? 'rotate_chain_moved' : res.status === 0 ? 'as_unreachable' : res.code) });
        return;
      }
      const expiresAt = typeof res.data.expires_at === 'number' ? res.data.expires_at : d.now() + 600;
      this.staged = { entry: final, hash };
      this.oldCode = null;
      this.set({ step: 'waiting', confirmCode: await confirmCodeOf(hash), email: maskEmail(s.user.email), expiresAt });
    } catch (e) {
      if (gen !== this.gen) return;
      // A touch that failed or was cancelled in the system window: said in the same place, with Try again and Cancel.
      if (e instanceof CheckError) { this.set({ step: 'checking', error: errorText(e.code === 'failed' ? 'check_failed' : e.code) }); return; }
      this.set({ step: 'failed', error: errorText('generic') });
    } finally {
      oldRoot.privateSeed.fill(0);
      newRoot.privateSeed.fill(0);
    }
  }

  /** While waiting: read the chain again; done when the staged entry is in it, failed when the hand-off ran out. */
  async poll(): Promise<void> {
    const st = this.state;
    if (st.step !== 'waiting' || !this.staged) return;
    const r = await this.d.session.refreshChain();
    if (r.ok) {
      const e = r.session.entries[this.staged.entry.seq];
      if (e && (await entryHash(e)) === this.staged.hash) {
        this.staged = null;
        this.newCode = null;
        this.set({ step: 'done' });
        return;
      }
      // Something else took the place: the hand-off can never append any more.
      if (e) { this.staged = null; this.set({ step: 'failed', error: errorText('rotate_chain_moved') }); return; }
    }
    if (this.d.now() >= st.expiresAt) {
      this.staged = null;
      this.set({ step: 'failed', error: errorText('handoff_expired') });
    }
  }
}
