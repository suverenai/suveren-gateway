/**
 * The pairing mailbox from the phone's side (plan 4.3, 6.2). The mailbox is a table on the Authority Server named by the
 * `pairing_id` that both devices derive from the QR's secret. The server only carries the messages; each one carries a MAC
 * (`HMAC-SHA256(mac_key, kind || 0x00 || JCS(body))`) that only the two devices can make, so the server can drop or delay
 * a message but cannot forge or change one.
 *
 * Reading: every stored message is verified (shape, then MAC). A message that fails, or a `kind` that appears twice, is not
 * skipped: the pairing stops (`bad_message`). The server accepts each kind once, the first one winning, so an honest mailbox
 * never holds either; silence would hide a tampering server.
 */
import {
  buildPairingMessage, derivePairing, verifyPairingMessage,
  type PairingKind, type PairingMessage, type PairingQr,
  b64uDecode,
} from '@hap/core/device-keys';
import type { AsApi, MailboxAnswer } from './as-api';

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
  constructor(private readonly api: AsApi, private readonly keys: PairingKeys) {}

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
