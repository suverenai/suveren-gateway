/**
 * The phone path of a confirmation for a change to a connector login (device-keys plan section 7, phone path; 20.4, 20.13;
 * DEC-29 as revised by DEC-44 and DEC-47; stage D3). Only on a computer WITHOUT its own check key: there it is offered first,
 * and the unlock password stays the fallback.
 *
 *   send    the request the page asked for (lib/change-confirmation.ts) is sealed for the person's phones: the view the phone
 *           shows (never a secret, lib/change-describe.ts) under a fresh content key, the key HPKE-wrapped to each ACTIVE PHONE of
 *           the own chain this gateway verified (never the Authority Server's word), and an envelope signed with this computer's
 *           device key over the hash of the view (20.4). The Authority Server only carries it (`POST /api/devices/confirmations`).
 *   poll    reads the answer and verifies it against the OWN chain, verified again from the genesis on (plan 7): an active granting
 *           device, the head check of 3.3 rule 3, the signature, for an allow the check, this request, this change hash, this
 *           gateway, its time. Only then is the request confirmed (`via: 'phone'`); the change still runs only once, from the page
 *           session that asked, for the exact change (ChangeConfirmations.consume).
 *   cancel  withdraws it at the Authority Server and here.
 *
 * Nothing is logged but codes: never a view, a key, a wrap or an answer.
 */
import { randomBytes } from 'node:crypto';
import type { Vault } from './vault';
import type { DeviceChainStore } from './device-chain-store';
import type { DeviceAsClient } from './device-as-client';
import { AsUnreachableError } from './device-as-client';
import { AsTlsMismatchError } from './as-tls-pin';
import type { DeviceReaders } from './device-readers';
import { OwnChainError } from './device-readers';
import type { ChangeConfirmations } from './change-confirmation';
import { isBearerCredential } from './as-credential';
import { loadDeviceSigningKey, loadOrGenerateKeyPair } from './e2e-key-manager';
import { sealContentKey } from './content-wraps';
import { deviceKeys } from './device-keys-lazy';

let lazy: Promise<typeof import('@suveren/pairing')> | null = null;
const pairingLib = (): Promise<typeof import('@suveren/pairing')> => (lazy ??= import('@suveren/pairing'));

/** A refusal with a neutral code; the page has the words. */
export class PhoneConfirmRefusal extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'PhoneConfirmRefusal';
  }
}

export type PhoneConfirmStatus = 'waiting' | 'confirmed' | 'denied' | 'expired' | 'invalid';

interface Sent {
  sessionId: string;
  rootDid: string;
  gatewayKeyId: string;
  changeHash: string;
  /** Epoch seconds. */
  createdAt: number;
  expiresAt: number;
  /** Set once an answer was judged; the status no longer changes. */
  final?: PhoneConfirmStatus;
}

export interface PhoneConfirmationsDeps {
  vault: Vault;
  store: DeviceChainStore;
  client: DeviceAsClient;
  readers: DeviceReaders;
  confirmations: ChangeConfirmations;
  /** Does this computer have its own check key? Then the phone path is never used (DEC-47). */
  hasCheckKey: () => boolean;
  /** Epoch seconds. */
  now?: () => number;
  log?: (m: string) => void;
}

export class PhoneConfirmations {
  private readonly sent = new Map<string, Sent>();
  private readonly now: () => number;

  constructor(private readonly d: PhoneConfirmationsDeps) {
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private credential(): string {
    if (!this.d.vault.isUnlocked()) throw new PhoneConfirmRefusal(401, 'locked');
    const c = this.d.vault.getSpCookie();
    if (!isBearerCredential(c)) throw new PhoneConfirmRefusal(409, 'not_signed_in');
    return c;
  }

  private async ownChain() {
    const kp = await loadOrGenerateKeyPair(this.d.vault);
    try {
      return await this.d.readers.own(kp.publicKey);
    } catch (e) {
      if (e instanceof OwnChainError) throw new PhoneConfirmRefusal(e.code === 'as_unreachable' ? 502 : 409, e.code === 'as_unreachable' ? 'as_unreachable' : 'own_chain_unusable');
      if (e instanceof AsTlsMismatchError) throw new PhoneConfirmRefusal(502, 'as_tls_mismatch');
      throw e;
    }
  }

  /** Send the request to the person's phones. Returns when it runs out (ms) and the phones' labels. */
  async send(sessionId: string, requestId: string): Promise<{ expiresAt: number; phones: string[] }> {
    const { d } = this;
    if (!d.store.exists()) throw new PhoneConfirmRefusal(409, 'not_set_up');
    if (d.hasCheckKey()) throw new PhoneConfirmRefusal(409, 'check_key_required');
    const credential = this.credential();
    if (this.sent.has(requestId)) throw new PhoneConfirmRefusal(409, 'already_sent');
    // Peek first (nothing is extended for a request this session does not hold).
    if (!d.confirmations.openRequest(sessionId, requestId)) throw new PhoneConfirmRefusal(404, 'request_unknown');
    const own = await this.ownChain();
    const dk = await deviceKeys();
    const phones = own.devices.filter((x) => {
      const s = own.state.devices[x.keyId];
      return s && s.kind === 'approve-app' && s.check !== null;
    });
    if (phones.length === 0) throw new PhoneConfirmRefusal(409, 'no_phone');
    const req = d.confirmations.forPhone(sessionId, requestId);
    if (!req) throw new PhoneConfirmRefusal(404, 'request_unknown');
    if (!req.detail) throw new PhoneConfirmRefusal(409, 'change_not_describable');
    const key = loadDeviceSigningKey(d.vault);
    if (!key || (await dk.keyIdOf(key.publicKey)) !== own.keyId) throw new PhoneConfirmRefusal(409, 'key_mismatch');

    const lib = await pairingLib();
    const issuedAt = this.now();
    const expiresAt = Math.floor(req.expires_at / 1000);
    const view: import('@suveren/pairing').ChangeView = {
      typ: lib.CHANGE_VIEW_TYP, v: 1,
      request: { request_id: req.request_id, kind: req.kind, name: req.name, change_hash: req.change_hash, gateway_key_id: own.keyId, expires_at: expiresAt },
      connector: req.detail.connector,
      fields: req.detail.fields,
      issued_at: issuedAt,
    };
    lib.validateView(view);
    const cek = new Uint8Array(randomBytes(32));
    let ciphertext: string;
    const wraps: Record<string, { ct: string; enc: string }> = {};
    try {
      ciphertext = await lib.sealView(view, cek);
      for (const p of phones) wraps[p.keyId] = await sealContentKey(cek, p.readPub);
    } finally {
      cek.fill(0);
    }
    const envelope = lib.buildEnvelope({ gateway_key_id: own.keyId, chain_seq: own.state.head.seq, chain_head: own.state.head.hash, content_hash: await dk.objectHash(view), issued_at: issuedAt });
    const senderSig = await dk.signObject(envelope, key.privateSeed);

    let reply;
    try {
      reply = await d.client.call('POST', '/api/devices/confirmations', { bearer: credential, body: { request_id: req.request_id, envelope, sender_sig: senderSig, ciphertext, device_keys: wraps } });
    } catch (e) {
      if (e instanceof AsTlsMismatchError) throw new PhoneConfirmRefusal(502, 'as_tls_mismatch');
      if (e instanceof AsUnreachableError) throw new PhoneConfirmRefusal(502, 'as_unreachable');
      throw e;
    }
    if (reply.status === 429) throw new PhoneConfirmRefusal(429, 'too_many_requests');
    if (reply.status !== 201) throw new PhoneConfirmRefusal(502, 'as_refused');
    this.sent.set(req.request_id, { sessionId, rootDid: own.rootDid, gatewayKeyId: own.keyId, changeHash: req.change_hash, createdAt: Math.floor(req.createdAt / 1000), expiresAt });
    this.prune();
    const labels = phones.map((p) => own.state.devices[p.keyId]?.label).filter((l): l is string => typeof l === 'string');
    return { expiresAt: req.expires_at, phones: labels };
  }

  /** What became of a request sent to the phones. Confirms it here only after the answer verified against the own chain. */
  async poll(sessionId: string, requestId: string): Promise<PhoneConfirmStatus> {
    const s = this.sent.get(requestId);
    if (!s || s.sessionId !== sessionId) throw new PhoneConfirmRefusal(404, 'request_unknown');
    if (s.final) return s.final;
    if (this.now() >= s.expiresAt) return this.finish(sessionId, requestId, s, 'expired');
    const credential = this.credential();
    let reply;
    try {
      reply = await this.d.client.call('GET', `/api/devices/confirmations/${encodeURIComponent(requestId)}`, { bearer: credential });
    } catch (e) {
      if (e instanceof AsTlsMismatchError) throw new PhoneConfirmRefusal(502, 'as_tls_mismatch');
      if (e instanceof AsUnreachableError) return 'waiting';   // try again on the next poll
      throw e;
    }
    // Gone at the Authority Server before the time ran out: withdrawn or dropped. Nothing can confirm it any more.
    if (reply.status === 404) return this.finish(sessionId, requestId, s, 'expired');
    const body = reply.body as { status?: unknown; answer?: unknown } | null;
    if (reply.status !== 200 || !body) return 'waiting';
    if (body.status !== 'answered') return 'waiting';
    const answer = body.answer as { confirmation?: unknown; sig?: unknown; check?: unknown } | undefined;
    if (!answer || typeof answer !== 'object') return this.finish(sessionId, requestId, s, 'invalid');
    const own = await this.ownChain();
    const lib = await pairingLib();
    let decision: 'allow' | 'deny';
    try {
      const c = await lib.verifyAnswer(
        { confirmation: answer.confirmation, sig: answer.sig, ...(answer.check !== undefined ? { check: answer.check } : {}) },
        { chain: own.state, now: this.now(), expect: { rootDid: s.rootDid, requestId, changeHash: s.changeHash, gatewayKeyId: s.gatewayKeyId, createdAt: s.createdAt, expiresAt: s.expiresAt } },
      );
      decision = c.decision;
    } catch (e) {
      const code = e instanceof lib.ChangeCheckError ? e.code : 'error';
      this.d.log?.(`[Control Plane] phone confirmation refused: ${code}`);
      return this.finish(sessionId, requestId, s, code === 'expired' ? 'expired' : 'invalid');
    }
    if (decision === 'deny') return this.finish(sessionId, requestId, s, 'denied');
    if (!this.d.confirmations.confirm(sessionId, requestId, 'phone')) return this.finish(sessionId, requestId, s, 'expired');
    s.final = 'confirmed';
    return 'confirmed';
  }

  /** The person cancelled on the page: withdrawn at the Authority Server and here. */
  async cancel(sessionId: string, requestId: string): Promise<void> {
    const s = this.sent.get(requestId);
    if (!s || s.sessionId !== sessionId) { this.d.confirmations.forget(sessionId, requestId); return; }
    this.sent.delete(requestId);
    this.d.confirmations.forget(sessionId, requestId);
    try {
      await this.d.client.call('DELETE', `/api/devices/confirmations/${encodeURIComponent(requestId)}`, { bearer: this.credential() });
    } catch {
      /* it runs out at the Authority Server by itself */
    }
  }

  private finish(sessionId: string, requestId: string, s: Sent, status: PhoneConfirmStatus): PhoneConfirmStatus {
    s.final = status;
    this.d.confirmations.forget(sessionId, requestId);
    return status;
  }

  private prune(): void {
    const t = this.now();
    for (const [id, s] of this.sent) if (s.expiresAt + 60 < t) this.sent.delete(id);
  }
}
