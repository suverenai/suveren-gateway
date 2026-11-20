/**
 * This phone removes a device from the account (plan 3.2, step 14, DEC-47, DEC-85; mockup C1–C5). A remove is a *grant*: the phone
 * signs a `remove` entry and checks it with its passkey over exactly that entry. Any device can be removed from here, this phone
 * included (DEC-85: a phone may remove itself after the same touch; for itself that touch is a confirmation, not a check: below).
 *
 *   confirm   the device, what removing it does, and the list as it will be after the change, BEFORE the touch
 *   refused   the change would leave no device that can confirm changes (NO_GRANTING_DEVICE, 3.2): said before the touch, nothing
 *             is signed. The Authority Server and every device refuse it too (3.3)
 *   checking  the phone's touch (Cancel possible: nothing has left the phone)
 *   sending   the touch was given: the full chain verified locally with the new entry, then the append. No Cancel any more: the
 *             request may already be on its way, and what happened is read from the chain
 *   done      the list from the chain fetched again (or, when that read failed, the list as computed before, said so); `self` when
 *             this phone removed itself: its keys are wiped HERE, at done, not when the person presses on
 *
 * Removing ITSELF: hap-core lets a device remove itself with its own signature alone and refuses a check on that entry (3.3:
 * `checks` holds only what an entry needs). DEC-85 asks for the same touch anyway, so the phone asks for it first, as for any
 * other remove, and sends the entry without it. That touch is a confirmation by the person on this phone, a UI step and NOT a
 * cryptographic check: nothing verifies it but this phone, and the entry's only proof is the phone's signature.
 */
import {
  activeDevices, buildEntry, entryHash, entrySignedBytes, b64uEncode, verifyChain,
  type ChainEntry, type ChainState,
} from '@hap/core/device-keys';
import { Driver } from './driver';
import type { DeviceKeyStore } from './key-store';
import type { CheckDevice } from './check';
import { CheckError } from './check';
import type { AsApi } from './as-api';
import type { AccountStore } from './account-store';
import type { DeviceSession } from './session';
import { deviceRows, type DeviceRow } from './chain-view';
import { errorText } from '../texts';

export type RemoveState =
  | { step: 'idle' }
  | { step: 'confirm'; target: DeviceRow; after: DeviceRow[]; self: boolean }
  | { step: 'refused'; target: DeviceRow; self: boolean; error: string }
  | { step: 'checking'; target: DeviceRow; self: boolean; error?: string }
  | { step: 'sending'; target: DeviceRow; self: boolean }
  | { step: 'done'; label: string; rows: DeviceRow[]; self: boolean; listError?: string }
  | { step: 'failed'; target: DeviceRow | null; error: string };

export interface RemoveDeps {
  keys: DeviceKeyStore;
  check: CheckDevice;
  api: AsApi;
  accounts: AccountStore;
  session: DeviceSession;
  now: () => number;
}

/** Would the chain still hold a device that can confirm changes once `target` is gone? (3.2 rule, NO_GRANTING_DEVICE) */
export function leavesGrantingDevice(state: ChainState, target: string): boolean {
  const active = activeDevices(state);
  const hadGranter = active.some((d) => d.check !== null);
  return !hadGranter || active.some((d) => d.key_id !== target && d.check !== null);
}

export class RemoveDriver extends Driver<RemoveState> {
  /** The confirm screen the touch came from: Cancel in the touch wait goes back to it. */
  private confirmed: Extract<RemoveState, { step: 'confirm' }> | null = null;
  /** Bumped by Cancel: a touch that answers after it is ignored, and nothing is sent. */
  private gen = 0;

  constructor(private readonly d: RemoveDeps) {
    super({ step: 'idle' });
  }

  /** Cancel while the touch is asked (or after it failed): back to the confirm screen; a late answer sends nothing. */
  cancelTouch(): void {
    if (this.state.step !== 'checking') return;
    this.gen++;
    if (this.confirmed) this.set(this.confirmed); else this.set({ step: 'idle' });
  }

  /** Open the confirm screen for one device of the verified list. A removal that would leave no granting device is refused here. */
  async start(targetKeyId: string): Promise<void> {
    const s = this.d.session.current();
    const account = await this.d.accounts.read();
    if (!s || !account) { this.set({ step: 'failed', target: null, error: errorText('session_ended') }); return; }
    const rows = deviceRows(s.entries, s.chain, account.key_id, this.d.now());
    const target = rows.find((r) => r.keyId === targetKeyId);
    if (!target) { this.set({ step: 'failed', target: null, error: errorText('generic') }); return; }
    const self = targetKeyId === account.key_id;
    if (!leavesGrantingDevice(s.chain, targetKeyId)) {
      this.set({ step: 'refused', target, self, error: errorText(self ? 'last_granting_self' : 'last_granting') });
      return;
    }
    this.set({ step: 'confirm', target, after: rows.filter((r) => r.keyId !== targetKeyId), self });
  }

  cancel(): void {
    this.gen++;
    this.confirmed = null;
    this.set({ step: 'idle' });
  }

  /** The touch, then sign, verify and append. Also "Try again" after a failed touch. */
  async confirm(): Promise<void> {
    const st = this.state;
    if (st.step === 'confirm') this.confirmed = st;
    else if (!(st.step === 'checking' && st.error)) return;
    const { target, self } = st;
    const gen = ++this.gen;
    this.set({ step: 'checking', target, self });
    const d = this.d;
    try {
      const s = d.session.current();
      const bearer = d.session.bearer();
      const account = await d.accounts.read();
      if (!s || !bearer || !account) { this.set({ step: 'failed', target, error: errorText('session_ended') }); return; }
      const entry = buildEntry({
        root_did: account.root_did, seq: s.chain.head.seq + 1, prev: s.chain.head.hash, op: 'remove',
        target: target.keyId, created_at: d.now(), signer: account.key_id,
      });
      const hash = await entryHash(entry);
      // The touch over exactly this entry, for every remove (DEC-85, also for this phone itself, where it is a confirmation only).
      const proof = await d.check.prove(account.check.cred_id, hash);
      // Cancelled while the touch was asked: nothing is sent, and the confirm screen the person went back to stays.
      if (gen !== this.gen) return;
      this.set({ step: 'sending', target, self });
      const sig = b64uEncode(await d.keys.sign(entrySignedBytes(entry)));
      const final: ChainEntry = {
        ...entry,
        sigs: [{ by: account.key_id, sig }],
        checks: self ? [] : [{ by: account.key_id, check: proof }],
      };
      // The same check the server and every device make (3.3): a defect found here is found before anything is sent.
      await verifyChain({ expectedRootDid: account.root_did, entries: [...s.entries, final] });
      const after = deviceRows(s.entries, s.chain, account.key_id, d.now()).filter((r) => r.keyId !== target.keyId);

      const res = await d.api.appendEntry(final, bearer);
      d.session.noteUse();
      if (!res.ok) {
        // No answer, or the server failed: the request may have gone through. The chain says what is true.
        if (res.status === 0 || res.status >= 500) {
          const truth = await this.landed(final, account.key_id, self);
          if (truth === 'landed') { await this.finish(target, self, after); return; }
        }
        this.set({ step: 'failed', target, error: errorText(res.code === 'CHAIN_HEAD_MOVED' ? 'remove_chain_moved' : res.status === 0 ? 'as_unreachable' : res.code) });
        return;
      }
      await this.finish(target, self, after);
    } catch (e) {
      if (gen !== this.gen) return;
      // A touch that failed or was cancelled in the system window: said in the same place, with Try again and Cancel.
      if (e instanceof CheckError) { this.set({ step: 'checking', target, self, error: errorText(e.code === 'failed' ? 'check_failed' : e.code) }); return; }
      const code = (e as { code?: unknown } | null)?.code;
      this.set({ step: 'failed', target, error: errorText(code === 'NO_GRANTING_DEVICE' ? 'last_granting' : 'generic') });
    }
  }

  /** Did the entry land? Read the chain again: the entry at its seq with its hash, or (removing itself) this phone gone from it. */
  private async landed(entry: ChainEntry, ownKeyId: string, self: boolean): Promise<'landed' | 'not' | 'unknown'> {
    const r = await this.d.session.refreshChain();
    if (!r.ok) return self && r.code === 'device_removed' ? 'landed' : 'unknown';
    const at = r.session.entries[entry.seq];
    if (!at) return 'not';
    return (await entryHash(at)) === (await entryHash(entry)) && at.sigs.some((x) => x.by === ownKeyId) ? 'landed' : 'not';
  }

  /** The removal is in the chain: the new list, or (removing itself) the keys wiped now. */
  private async finish(target: DeviceRow, self: boolean, after: DeviceRow[]): Promise<void> {
    const d = this.d;
    if (self) {
      // This phone is no longer a device: its keys are useless and are wiped now, whatever the person does next.
      await d.session.end().catch(() => {});
      await d.keys.deleteAll().catch(() => {});
      await d.accounts.clear().catch(() => {});
      this.set({ step: 'done', label: target.label, rows: [], self: true });
      return;
    }
    const account = await d.accounts.read();
    const fresh = await d.session.refreshChain();
    if (!fresh.ok || !account) {
      // The removal went through; only the new list could not be read. Said, with the list as the phone computed it.
      this.set({ step: 'done', label: target.label, rows: after, self: false, listError: errorText('list_not_refreshed') });
      return;
    }
    this.set({ step: 'done', label: target.label, rows: deviceRows(fresh.session.entries, fresh.session.chain, account.key_id, d.now()), self: false });
  }
}
