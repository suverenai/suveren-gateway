/**
 * The pairing mailbox from either device's side (plan 4.3, 6.2). The mailbox is a table on the Authority Server named by the
 * `pairing_id` that both devices derive from the QR's secret. The server only carries the messages; each one carries a MAC
 * (`HMAC-SHA256(mac_key, kind || 0x00 || JCS(body))`) that only the two devices can make, so the server can drop or delay
 * a message but cannot forge or change one.
 *
 * Reading: every stored message is verified (shape, then MAC). A message that fails, or a `kind` that appears twice, is not
 * skipped: the pairing stops (`bad_message`). The server accepts each kind once, the first one winning, so an honest mailbox
 * never holds either; silence would hide a tampering server.
 *
 * The network is a {@link MailboxPort}: the phone's `AsApi` and the gateway's control-plane adapter both fit it, so the
 * phone and the gateway page run THIS code and no second copy.
 */
import {
  buildPairingMessage, derivePairing, verifyPairingMessage, b64uDecode,
  type PairingKind, type PairingMessage, type PairingQr,
} from '@hap/core/device-keys';

/** A mailbox message as it is stored: `{ kind, body, mac }` (plan 4.3). */
export interface MailboxMessage { kind: string; body: Record<string, unknown>; mac: string }

export interface MailboxAnswer {
  messages: unknown[];
  /** The chain of the mailbox owner, so a joiner can verify it (plan 6.2, `GET /api/devices/pairings/:id`). */
  chain?: { root_did: string; entries: unknown[]; head: { seq: number; hash: string } };
}

export type PortResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; code: string; status: number };

/** The two calls the mailbox makes. `status` 0 means nothing could be asked (no network). */
export interface MailboxPort {
  postMessage(pairingId: string, message: MailboxMessage): Promise<PortResult<unknown>>;
  readMailbox(pairingId: string): Promise<PortResult<MailboxAnswer>>;
}

export interface PairingKeys {
  pairingId: string;
  macKey: Uint8Array;
}

/** The two derived values of a QR (plan 4.3 "Derived values"). The server only ever sees `pairingId`. */
export async function pairingKeysOf(qr: Pick<PairingQr, 'secret'>): Promise<PairingKeys> {
  const { pairingId, macKey } = await derivePairing(b64uDecode(qr.secret));
  return { pairingId, macKey };
}

export type Messages = Partial<Record<PairingKind, PairingMessage>>;

export type PollResult =
  | { ok: true; messages: Messages; chain?: MailboxAnswer['chain'] }
  | { ok: false; code: 'as_unreachable' | 'mailbox_missing' | 'bad_message' | 'as_error' };

export class Mailbox {
  constructor(private readonly api: MailboxPort, private readonly keys: PairingKeys) {}

  async send(kind: PairingKind, body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; code: string }> {
    const msg = await buildPairingMessage(this.keys.macKey, kind, body);
    const r = await this.api.postMessage(this.keys.pairingId, msg);
    return r.ok ? { ok: true } : { ok: false, code: r.status === 0 ? 'as_unreachable' : r.code };
  }

  async poll(): Promise<PollResult> {
    const r = await this.api.readMailbox(this.keys.pairingId);
    if (!r.ok) {
      if (r.status === 0) return { ok: false, code: 'as_unreachable' };
      if (r.status === 404) return { ok: false, code: 'mailbox_missing' };
      return { ok: false, code: 'as_error' };
    }
    if (!Array.isArray(r.data.messages)) return { ok: false, code: 'bad_message' };
    const messages: Messages = {};
    for (const raw of r.data.messages) {
      let m: PairingMessage;
      try {
        m = await verifyPairingMessage(this.keys.macKey, raw);
      } catch {
        return { ok: false, code: 'bad_message' };
      }
      if (messages[m.kind]) return { ok: false, code: 'bad_message' };
      messages[m.kind] = m;
    }
    return { ok: true, messages, ...(r.data.chain ? { chain: r.data.chain } : {}) };
  }
}
