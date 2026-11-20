/**
 * This phone removes a device from the account (plan 3.2, step 14, DEC-47, DEC-85; mockup C1–C5). A remove is a *grant*: the phone
 * signs a `remove` entry and checks it with its passkey over exactly that entry. Any device can be removed from here, this phone
 * included (DEC-85: "a phone may remove itself, with the same check").
 *
 *   confirm   the device, what removing it does, and the list as it will be after the change, BEFORE the touch
 *   refused   the change would leave no device that can confirm changes (NO_GRANTING_DEVICE, 3.2): said before the touch, nothing
 *             is signed. The Authority Server and every device refuse it too (3.3)
 *   checking  the phone's touch, the full chain verified locally with the new entry, then the append
 *   done      the list from the chain fetched again; `self` when this phone removed itself (the app then clears its keys)
 *
 * Removing ITSELF: hap-core lets a device remove itself with its own signature alone and refuses a check on that entry (3.3:
 * `checks` holds only what an entry needs). DEC-85 asks for the same check anyway, so the phone asks for the touch over the entry's
 * hash first, as for any other remove, and sends the entry without it. The touch is the person's confirmation on this phone; the
 * entry's own proof is the phone's signature.
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
  | { step: 'checking'; target: DeviceRow; self: boolean }
  | { step: 'done'; label: string; rows: DeviceRow[]; self: boolean }
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
  constructor(private readonly d: RemoveDeps) {
    super({ step: 'idle' });
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
    this.set({ step: 'idle' });
  }

  /** The touch, then sign, verify and append. */
  async confirm(): Promise<void> {
    const st = this.state;
    if (st.step !== 'confirm') return;
    const { target, self } = st;
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
      // The touch over exactly this entry, for every remove (DEC-85, also for this phone itself).
      const proof = await d.check.prove(account.check.cred_id, hash);
      const sig = b64uEncode(await d.keys.sign(entrySignedBytes(entry)));
      const final: ChainEntry = {
        ...entry,
        sigs: [{ by: account.key_id, sig }],
        checks: self ? [] : [{ by: account.key_id, check: proof }],
      };
      // The same check the server and every device make (3.3): a defect found here is found before anything is sent.
      await verifyChain({ expectedRootDid: account.root_did, entries: [...s.entries, final] });

      const res = await d.api.appendEntry(final, bearer);
      d.session.noteUse();
      if (!res.ok) {
        this.set({ step: 'failed', target, error: errorText(res.code === 'CHAIN_HEAD_MOVED' ? 'remove_chain_moved' : res.status === 0 ? 'as_unreachable' : res.code) });
        return;
      }
      if (self) {
        // This phone is no longer a device: it can neither sign in nor read the chain again. The app clears its keys.
        this.set({ step: 'done', label: target.label, rows: [], self: true });
        return;
      }
      const fresh = await d.session.refreshChain();
      if (!fresh.ok) { this.set({ step: 'failed', target, error: errorText(fresh.code) }); return; }
      this.set({ step: 'done', label: target.label, rows: deviceRows(fresh.session.entries, fresh.session.chain, account.key_id, d.now()), self: false });
    } catch (e) {
      if (e instanceof CheckError) { this.set({ step: 'failed', target, error: errorText(e.code === 'failed' ? 'check_failed' : e.code) }); return; }
      const code = (e as { code?: unknown } | null)?.code;
      this.set({ step: 'failed', target, error: errorText(code === 'NO_GRANTING_DEVICE' ? 'last_granting' : 'generic') });
    }
  }
}
