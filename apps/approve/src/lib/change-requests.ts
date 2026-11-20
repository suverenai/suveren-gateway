/**
 * A computer's change to a connector login, confirmed on this phone (device-keys plan section 7 phone path, 20.4; DEC-29 as
 * revised by DEC-44 and DEC-47; stage D3; mockup E1–E3, approved: DEC-86 and the coordinator's note of 2026-11-20).
 *
 *   read     the open requests this phone holds a wrap for (`GET /api/devices/confirmations`, its own wrap only). Each is opened
 *            (the content key from this phone's wrap, the view under it, bound to its request id) and checked BEFORE it is shown
 *            (@suveren/pairing `verifyRequest`): the envelope signed by an ACTIVE GATEWAY of this phone's own verified chain, the
 *            head it names, the hash of what was opened, the request id, not run out. A request that fails is never shown.
 *   confirm  "Confirm with your touch": the phone builds the signed `suveren-change-confirmation` (allow), the touch over exactly
 *            its hash, then signs it and sends it. Cancel stays until the touch is given; after it ("Confirming…") nothing stops it.
 *   deny     "Do not allow": a signed deny, no touch (it changes nothing).
 *
 * The plaintext lives in memory only; nothing here writes to IndexedDB or a cache (plan 8). No error text carries a value.
 */
import { b64uEncode, objectHash, signedBytes } from '@hap/core/device-keys';
import {
  ChangeCheckError, buildConfirmation, openView, verifyRequest, type ChangeView,
} from '@suveren/pairing';
import { Driver } from './driver';
import type { DeviceKeyStore } from './key-store';
import type { CheckDevice } from './check';
import { CheckError } from './check';
import type { AsApi } from './as-api';
import type { AccountStore } from './account-store';
import type { DeviceSession } from './session';
import { errorText } from '../texts';

/** One request as the phone shows it. */
export interface ChangeItem {
  requestId: string;
  /** Epoch seconds. */
  createdAt: number;
  expiresAt: number;
  view: ChangeView;
  /** The computer that asks: its label in this phone's verified chain. */
  gatewayLabel: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const REQUEST_ID = /^[A-Za-z0-9_-]{22}$/;

export interface ChangeReaderDeps {
  keys: DeviceKeyStore;
  api: AsApi;
  accounts: AccountStore;
  session: DeviceSession;
  /** Epoch seconds. */
  now: () => number;
}

export type ChangeListResult = { ok: true; items: ChangeItem[] } | { ok: false; code: 'session_ended' | 'as_unreachable' | 'as_error' };

export class ChangeRequestReader {
  constructor(private readonly d: ChangeReaderDeps) {}

  /** Open and check one row; null if it is not to be shown. `again`: the chain was read again once already. */
  private async one(row: unknown, ownKeyId: string, again = false): Promise<ChangeItem | null> {
    if (!isObj(row) || typeof row.request_id !== 'string' || !REQUEST_ID.test(row.request_id) || typeof row.ciphertext !== 'string') return null;
    const wraps = isObj(row.device_keys) ? row.device_keys : null;
    const wrap = wraps?.[ownKeyId];
    if (!isObj(wrap) || typeof wrap.ct !== 'string' || typeof wrap.enc !== 'string') return null;
    const s = this.d.session.current();
    if (!s) return null;
    let cek: Uint8Array | null = null;
    try {
      cek = await this.d.keys.openContentKey({ ct: wrap.ct, enc: wrap.enc });
      const view = await openView(cek, row.ciphertext, row.request_id);
      const checked = await verifyRequest({ requestId: row.request_id, envelope: row.envelope, senderSig: row.sender_sig, view }, { chain: s.chain, now: this.d.now() });
      return {
        requestId: row.request_id,
        createdAt: typeof row.created_at === 'number' ? row.created_at : checked.envelope.issued_at,
        expiresAt: view.request.expires_at,
        view,
        gatewayLabel: checked.gatewayLabel,
      };
    } catch (e) {
      // A head this phone has not seen yet (a device was added a moment ago): read the chain once, then judge again.
      if (!again && e instanceof ChangeCheckError && e.code === 'chain_ahead') {
        const fresh = await this.d.session.refreshChain();
        if (fresh.ok) return this.one(row, ownKeyId, true);
      }
      return null;
    } finally {
      cek?.fill(0);
    }
  }

  async list(): Promise<ChangeListResult> {
    const bearer = this.d.session.bearer();
    const account = await this.d.accounts.read();
    if (!bearer || !account) return { ok: false, code: 'session_ended' };
    const r = await this.d.api.confirmations(bearer);
    if (!r.ok) return { ok: false, code: r.status === 401 ? 'session_ended' : r.status === 0 ? 'as_unreachable' : 'as_error' };
    const rows = Array.isArray(r.data.requests) ? r.data.requests.slice(0, 20) : [];
    const items: ChangeItem[] = [];
    for (const row of rows) {
      const it = await this.one(row, account.key_id);
      if (it) items.push(it);
    }
    return { ok: true, items };
  }
}

/**
 * What the card of one request shows:
 *   idle       the change and the two buttons
 *   touch      "Waiting for your touch…" with Cancel (≥44pt); `error` when the touch did not work (Try again, Cancel)
 *   sending    "Confirming…" (or the deny going out): no Cancel any more
 *   confirmed  the gateway's result: check mark, "Confirmed", "Recorded"
 *   denied     "Not allowed" (alert, one pinned button)
 *   expired    "Run out" (alert, one pinned button)
 *   failed     anything else (alert, one pinned button)
 */
export type ChangeCardState =
  | { step: 'idle' }
  | { step: 'touch'; error?: string }
  | { step: 'sending'; decision: 'allow' | 'deny' }
  | { step: 'confirmed' }
  | { step: 'denied' }
  | { step: 'expired' }
  | { step: 'failed'; error: string };

export interface ChangeDriverDeps extends ChangeReaderDeps {
  check: CheckDevice;
}

export class ChangeConfirmDriver extends Driver<ChangeCardState> {
  /** Bumped by Cancel: a touch that answers after it is ignored, and nothing is sent. */
  private gen = 0;

  constructor(private readonly d: ChangeDriverDeps, private readonly item: ChangeItem) {
    super({ step: 'idle' });
  }

  /** Cancel while the touch is asked (or after it failed): back to the card; a late answer sends nothing. */
  cancelTouch(): void {
    if (this.state.step !== 'touch') return;
    this.gen++;
    this.set({ step: 'idle' });
  }

  private async build(decision: 'allow' | 'deny') {
    const s = this.d.session.current();
    const bearer = this.d.session.bearer();
    const account = await this.d.accounts.read();
    if (!s || !bearer || !account) return null;
    const r = this.item.view.request;
    const confirmation = buildConfirmation({
      root_did: account.root_did, key_id: account.key_id, chain_seq: s.chain.head.seq, chain_head: s.chain.head.hash,
      request_id: r.request_id, change_hash: r.change_hash, gateway_key_id: r.gateway_key_id, decision, confirmed_at: this.d.now(),
    });
    return { confirmation, bearer, credId: account.check.cred_id };
  }

  private async send(confirmation: ReturnType<typeof buildConfirmation>, bearer: string, check?: unknown): Promise<void> {
    const sig = b64uEncode(await this.d.keys.sign(signedBytes(confirmation)));
    const res = await this.d.api.answerConfirmation(this.item.requestId, { confirmation, sig, ...(check !== undefined ? { check } : {}) }, bearer);
    this.d.session.noteUse();
    if (res.ok) {
      this.set(confirmation.decision === 'allow' ? { step: 'confirmed' } : { step: 'denied' });
      return;
    }
    // Gone (run out, or withdrawn on the computer) or already answered elsewhere.
    if (res.status === 404) { this.set({ step: 'expired' }); return; }
    if (res.status === 401) { this.set({ step: 'failed', error: errorText('session_ended') }); return; }
    this.set({ step: 'failed', error: errorText(res.status === 0 ? 'as_unreachable' : res.code === 'ALREADY_ANSWERED' ? 'change_answered' : 'generic') });
  }

  /** "Confirm with your touch", and "Try again" after a failed touch. */
  async confirm(): Promise<void> {
    const st = this.state;
    if (!(st.step === 'idle' || (st.step === 'touch' && st.error))) return;
    if (this.item.expiresAt <= this.d.now()) { this.set({ step: 'expired' }); return; }
    const gen = ++this.gen;
    this.set({ step: 'touch' });
    try {
      const b = await this.build('allow');
      if (!b) { this.set({ step: 'failed', error: errorText('session_ended') }); return; }
      // The touch over exactly this answer.
      const proof = await this.d.check.prove(b.credId, await objectHash(b.confirmation));
      if (gen !== this.gen) return;   // cancelled while the touch was asked: nothing is sent
      this.set({ step: 'sending', decision: 'allow' });
      await this.send(b.confirmation, b.bearer, proof);
    } catch (e) {
      if (gen !== this.gen) return;
      if (e instanceof CheckError) { this.set({ step: 'touch', error: errorText(e.code === 'cancelled' ? 'cancelled' : e.code === 'no_user_verification' ? 'no_user_verification' : 'check_failed') }); return; }
      this.set({ step: 'failed', error: errorText('generic') });
    }
  }

  /** "Do not allow": a signed deny, no touch. */
  async deny(): Promise<void> {
    if (this.state.step !== 'idle') return;
    if (this.item.expiresAt <= this.d.now()) { this.set({ step: 'expired' }); return; }
    this.set({ step: 'sending', decision: 'deny' });
    try {
      const b = await this.build('deny');
      if (!b) { this.set({ step: 'failed', error: errorText('session_ended') }); return; }
      await this.send(b.confirmation, b.bearer);
    } catch {
      this.set({ step: 'failed', error: errorText('generic') });
    }
  }
}
