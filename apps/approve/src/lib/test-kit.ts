/**
 * Test helpers: a fake Authority Server (a {@link Transport}) that holds one account and answers the routes the phone calls,
 * a fake passkey (a {@link CheckDevice} whose assertions verify under hap-core's `verifyCheck`), and a fake computer that plays
 * the other side of a pairing. Real keys, real signatures, real chain verification: the fakes decide only what the network would.
 *
 * The fake server enforces what the plan says the real one must (and the real one does not yet, see the hand-over): a phone
 * `genesis` and a phone `add` need a passkey registration whose credential is the one named in the entry; a phone session needs
 * a check over the sign-in; a mailbox takes each kind once.
 */
import {
  b64uDecode, b64uEncode, buildDeviceRecord, buildEntry, comparisonCode, concat, deriveRootKey, ecdsaRawToDer, ed25519PublicKey,
  encodeCoseEc2, encodePairingQr, entryHash, entrySignedBytes, generateRecoveryCode, hashBytes, jcs, keyIdOf, objectHash, pairingCommitment,
  randomBytes, sha256, signEd25519, signEntry, signedBytes, utf8, verifyChain, verifyCheck, verifyDecision, verifyEd25519, verifySignin, b64uBytes,
  type ChainEntry, type ChainState, type Decision, type DeviceRecord, type PairingMessage, type PairingQr, type RootKey, type WebauthnProof,
} from '@hap/core/device-keys';
import type { CheckDevice, PasskeyRegistration } from './check';
import { CheckError, registrationChallenge } from './check';
import type { Method, Reply, Transport } from './transport';
import { UnreachableError } from './transport';
import { AsApi } from './as-api';
import { Mailbox, pairingKeysOf, type PairingKeys } from './mailbox';
import { MemoryKv } from './kv';
import { DeviceKeyStore } from './key-store';
import { AccountStore } from './account-store';
import { DeviceSession } from './session';
import { ProposalReader } from './proposals';
import { PhoneDecider } from './decide';
import type { CheckDeps } from './card-checks';
import { RegisterDriver } from './register-driver';

export const AS_URL = 'https://as.test';
export const APP_RP_ID = 'approve.test';

export const refusal = (status: number, code: string): Reply => ({ status, body: { approved: false, errors: [{ code, message: 'x' }] } });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** ECDSA P-256 over `data` with a WebCrypto private key, as DER (what an authenticator gives). */
async function p256Der(priv: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, new Uint8Array(data)));
  return ecdsaRawToDer(raw);
}

// ─── the fake Authority Server ───────────────────────────────────────────────────────

export class FakeAs implements Transport {
  readonly calls: Array<{ method: string; path: string; body?: any; bearer?: string }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  clock = 1_800_000_000;
  now = (): number => this.clock;
  down = false;
  entries: ChainEntry[] = [];
  rootDid = '';
  user = { id: 'user-1', name: 'Anna Muster', email: 'anna@example.com' };
  codes = new Set<string>();
  usedCodes = new Set<string>();
  sessions = new Map<string, string>();
  nonces = new Map<string, string>();
  mailboxes = new Map<string, { messages: Json[]; passkey?: Json }>();
  pending: Json[] = [];
  approverPending: Json[] = [];
  byId = new Map<string, Json>();
  /** Knobs for the failures a test wants. */
  sessionRefusal: { status: number; code: string } | null = null;
  acceptAnySignin = false;
  /** The key that SIGNS challenges (default: the key named by `keyHex`). */
  challengeKey: CryptoKey | null = null;
  private seq = 0;

  // ─── stage D2: what the card reads, and the decision routes ───────────────────────────
  /** Signed mandate blobs and the revoked flag, by authorization id (`GET /api/mandates?authorization_id=`). */
  mandates = new Map<string, { blobs: string[]; revoked?: boolean }>();
  /** Profiles by id (`GET /api/profiles/:id`, public). */
  profiles = new Map<string, unknown>();
  /** The mandate id the server checks a decision on a proposal against. */
  mandateOf = new Map<string, string>();
  /** Decisions the server accepted. */
  decisions: Array<{ id: string; route: string; body: Json; decision: Decision }> = [];
  private seenNonces = new Set<string>();

  // ─── stage D3: a computer's change requests, carried like the real server (suveren-as change-confirmations.ts) ───
  /** Change requests by id: what the gateway sent and the phone's answer. */
  confirmations = new Map<string, Json>();
  /** The next decision call finds the session over (the server's own limit): 401 SESSION_EXPIRED, session gone. */
  expireSessionOnDecision = false;
  /** Refuse the next decision call with this code. */
  refuseDecision: { status: number; code: string } | null = null;

  /** A mandate blob signed by this server's key, as `{ header, payload, signature }`. */
  async mandateBlob(payload: Json, over: { signWith?: CryptoKey } = {}): Promise<string> {
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, over.signWith ?? this.key.privateKey, new Uint8Array(utf8(jcs(payload)))));
    const mandate = { header: { typ: 'HAP-mandate', alg: 'EdDSA' }, payload, signature: b64uEncode(sig) };
    return b64uEncode(utf8(JSON.stringify(mandate)));
  }

  private constructor(private readonly key: CryptoKeyPair, readonly keyHex: string) {}

  static async create(): Promise<FakeAs> {
    const key = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const hex = [...new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey))].map((b) => b.toString(16).padStart(2, '0')).join('');
    return new FakeAs(key, hex);
  }

  issueCode(): string {
    const c = b64uEncode(randomBytes(16));
    this.codes.add(c);
    return c;
  }

  async state(): Promise<ChainState> {
    return verifyChain({ expectedRootDid: this.rootDid, entries: this.entries });
  }

  /** Append an entry straight into the chain (a computer that has its own session, or a root-signed entry). Verifies like the real one. */
  async appendDirect(entry: ChainEntry): Promise<void> {
    await verifyChain({ expectedRootDid: this.rootDid || entry.root_did, entries: [...this.entries, entry] });
    if (!this.rootDid) this.rootDid = entry.root_did;
    this.entries.push(entry);
  }

  private async signChallenge(body: Json): Promise<string> {
    const bytes = concat(utf8('hap-as-challenge\u0000'), utf8(jcs({ typ: body.typ, nonce: body.nonce, issuedAt: body.issuedAt })));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, this.challengeKey ?? this.key.privateKey, new Uint8Array(bytes)));
    return btoa(String.fromCharCode(...sig));
  }

  private bearerKey(bearer?: string): string | null {
    return bearer ? this.sessions.get(bearer) ?? null : null;
  }

  /** The change-request routes, with the real server's rules (only the session kinds, wraps for the person's phones, signatures). */
  private async confirmationRoute(method: Method, id: string | undefined, answer: boolean, body: Json, bearer?: string): Promise<Reply> {
    const keyId = this.bearerKey(bearer);
    if (!keyId) return refusal(401, 'DEVICE_SESSION_REQUIRED');
    const state = await this.state();
    const me = state.devices[keyId];
    if (!me || me.removed_seq !== null) return refusal(401, 'DEVICE_SESSION_REQUIRED');
    const sigOk = async (signPub: string, obj: object, sig: unknown) => {
      try { return typeof sig === 'string' && await verifyEd25519(b64uBytes(signPub, 32, 'sign_pub'), signedBytes(obj), b64uBytes(sig, 64, 'sig')); } catch { return false; }
    };
    for (const [rid, row] of this.confirmations) if (row.expires_at <= this.now()) this.confirmations.delete(rid);
    if (method === 'POST' && !id) {
      if (me.kind !== 'gateway') return refusal(403, 'DEVICE_KIND_NOT_ALLOWED');
      const env = body.envelope as Json;
      if (!env || env.gateway_key_id !== keyId || env.kind !== 'change-request') return refusal(403, 'NOT_THIS_GATEWAY');
      if (!(await sigOk(me.sign_pub, env, body.sender_sig))) return refusal(400, 'BAD_SIGNATURE');
      const wraps = body.device_keys as Record<string, Json>;
      for (const k of Object.keys(wraps ?? {})) {
        const d = state.devices[k];
        if (!d || d.removed_seq !== null || d.kind !== 'approve-app') return refusal(403, 'NOT_YOUR_PHONE');
      }
      if (this.confirmations.has(body.request_id)) return refusal(409, 'REQUEST_EXISTS');
      const row = { ...body, gateway_key_id: keyId, created_at: this.now(), expires_at: this.now() + 900, answer: null };
      this.confirmations.set(body.request_id, row);
      return { status: 201, body: { request_id: body.request_id, expires_at: row.expires_at } };
    }
    if (method === 'GET' && !id) {
      if (me.kind !== 'approve-app') return refusal(403, 'DEVICE_KIND_NOT_ALLOWED');
      const requests = [...this.confirmations.values()].filter((r) => !r.answer && r.device_keys[keyId]).map((r) => ({
        request_id: r.request_id, gateway_key_id: r.gateway_key_id, envelope: r.envelope, sender_sig: r.sender_sig, ciphertext: r.ciphertext,
        device_keys: { [keyId]: r.device_keys[keyId] }, created_at: r.created_at, expires_at: r.expires_at, status: 'waiting',
      }));
      return { status: 200, body: { requests } };
    }
    const row = id ? this.confirmations.get(id) : undefined;
    if (method === 'GET' && id) {
      if (!row) return refusal(404, 'NO_REQUEST');
      if (me.kind === 'gateway') {
        if (row.gateway_key_id !== keyId) return refusal(404, 'NO_REQUEST');
        return { status: 200, body: { request_id: id, status: row.answer ? 'answered' : 'waiting', expires_at: row.expires_at, ...(row.answer ? { answer: row.answer } : {}) } };
      }
      if (!row.device_keys[keyId]) return refusal(404, 'NO_REQUEST');
      return { status: 200, body: { ...row, device_keys: { [keyId]: row.device_keys[keyId] }, answer: undefined } };
    }
    if (method === 'DELETE' && id) {
      if (me.kind !== 'gateway') return refusal(403, 'DEVICE_KIND_NOT_ALLOWED');
      if (row && row.gateway_key_id === keyId) this.confirmations.delete(id);
      return { status: 204, body: null };
    }
    if (method === 'POST' && id && answer) {
      if (me.kind !== 'approve-app') return refusal(403, 'DEVICE_KIND_NOT_ALLOWED');
      if (!row || !row.device_keys[keyId]) return refusal(404, 'NO_REQUEST');
      const c = body.confirmation as Json;
      if (!c || c.request_id !== id || c.gateway_key_id !== row.gateway_key_id) return refusal(400, 'WRONG_REQUEST');
      if (c.key_id !== keyId) return refusal(403, 'NOT_THIS_DEVICE');
      if (!(await sigOk(me.sign_pub, c, body.sig))) return refusal(400, 'BAD_SIGNATURE');
      if (c.decision === 'allow') {
        if (!me.check || body.check === undefined) return refusal(400, 'CHECK_REQUIRED');
        if (!(await verifyCheck(me.check, await objectHash(c), body.check))) return refusal(400, 'BAD_CHECK');
      }
      if (row.answer) return refusal(409, 'ALREADY_ANSWERED');
      row.answer = { confirmation: c, sig: body.sig, ...(body.check !== undefined ? { check: body.check } : {}) };
      return { status: 201, body: { status: 'answered' } };
    }
    return refusal(404, 'NOT_FOUND');
  }

  /** Like the network: what goes in and what comes out is JSON text, so no object is shared between the two sides. */
  /** While set, a chain append waits for it (the request is on its way). */
  appendGate: Promise<void> | null = null;
  /** The next chain append is stored, but its answer is lost (the phone sees no answer). */
  loseNextAppendAnswer = false;
  /** The next N chain reads fail with 503. */
  failChainReads = 0;

  async call(method: Method, path: string, opts: { body?: unknown; bearer?: string } = {}): Promise<Reply> {
    if (this.down) throw new UnreachableError();
    const wire = opts.body === undefined ? undefined : JSON.parse(JSON.stringify(opts.body));
    const isAppend = method === 'POST' && path === '/api/devices/chain' && (wire as { entry?: { op?: string } } | undefined)?.entry?.op !== 'genesis';
    if (isAppend && this.appendGate) await this.appendGate;
    if (method === 'GET' && path.startsWith('/api/devices/chain') && this.failChainReads > 0) { this.failChainReads--; return refusal(503, 'UNAVAILABLE'); }
    const r = await this.route(method, path, { body: wire, bearer: opts.bearer });
    if (isAppend && this.loseNextAppendAnswer) { this.loseNextAppendAnswer = false; throw new UnreachableError(); }
    return JSON.parse(JSON.stringify(r)) as Reply;
  }

  private async route(method: Method, path: string, opts: { body?: unknown; bearer?: string }): Promise<Reply> {
    const url = new URL(path, AS_URL);
    const p = url.pathname;
    const body = (opts.body ?? {}) as Json;
    this.calls.push({ method, path, body: opts.body, bearer: opts.bearer });
    const route = `${method} ${p}`;
    const mb = p.match(/^\/api\/devices\/pairings\/([^/]+)(\/messages|\/passkey)?$/);
    const pr = p.match(/^\/api\/proposals\/([^/]+)$/);

    const cf = p.match(/^\/api\/devices\/confirmations(?:\/([^/]+)(\/answer)?)?$/);
    if (cf) return this.confirmationRoute(method, cf[1], Boolean(cf[2]), body, opts.bearer);
    if (route === 'GET /api/as/pubkey') return { status: 200, body: { publicKey: this.keyHex } };
    if (route === 'POST /api/as/challenge') {
      const out: Json = { typ: 'hap-as-challenge', nonce: body.nonce, issuedAt: this.now() };
      out.signature = await this.signChallenge(out);
      return { status: 200, body: out };
    }
    if (route === 'POST /api/devices/challenge') {
      const nonce = b64uEncode(randomBytes(32));
      this.nonces.set(nonce, body.key_id);
      return { status: 200, body: { nonce, expires_at: this.now() + 60, aud: this.keyHex } };
    }
    if (route === 'POST /api/devices/session') {
      if (this.sessionRefusal) return refusal(this.sessionRefusal.status, this.sessionRefusal.code);
      const state = await this.state();
      let keyId: string;
      try {
        const s = this.acceptAnySignin
          ? (body.signin as { key_id: string; nonce: string })
          : await verifySignin({ signin: body.signin, sig: body.sig }, { aud: this.keyHex, now: this.now(), chain: state });
        keyId = s.key_id;
        if (this.nonces.get(s.nonce) !== keyId) return refusal(401, 'BAD_NONCE');
        this.nonces.delete(s.nonce);
      } catch (e) {
        return refusal(401, (e as { code?: string }).code ?? 'REFUSED');
      }
      const dev = state.devices[keyId];
      // A phone session opens only with a check over the sign-in (plan 6.2, DEC-47).
      if (dev?.kind === 'approve-app' && !(dev.check && (await verifyCheck(dev.check, await objectHash(body.signin), body.check)))) return refusal(403, 'CHECK_REQUIRED');
      const token = `tok-${++this.seq}`;
      this.sessions.set(token, keyId);
      return { status: 200, body: { token, expires_at: this.now() + 12 * 3600, user: { ...this.user, did: this.rootDid }, head: state.head } };
    }
    if (route === 'DELETE /api/devices/session') {
      if (opts.bearer) this.sessions.delete(opts.bearer);
      return { status: 200, body: { ended: true } };
    }
    if (route === 'GET /api/devices/chain') {
      if (!this.bearerKey(opts.bearer)) return refusal(401, 'DEVICE_SESSION_REQUIRED');
      const state = await this.state();
      return { status: 200, body: { root_did: this.rootDid, entries: this.entries, head: state.head } };
    }
    if (route === 'POST /api/devices/chain') return this.postChain(body, opts.bearer);
    if (route === 'POST /api/devices/recovery/handoffs') return this.stageHandoff(body);

    if (route === 'POST /api/devices/pairings') {
      if (!this.bearerKey(opts.bearer)) return refusal(401, 'DEVICE_SESSION_REQUIRED');
      this.mailboxes.set(body.pairing_id, { messages: [] });
      return { status: 201, body: {} };
    }
    if (mb) {
      const box = this.mailboxes.get(decodeURIComponent(mb[1]));
      if (!box) return refusal(404, 'NOT_FOUND');
      if (method === 'GET' && !mb[2]) {
        // The head is named without verifying the chain: the PHONE verifies it, and a test may have tampered with it.
        const chain = this.entries.length ? { root_did: this.rootDid, entries: this.entries, head: { seq: this.entries.length - 1, hash: await entryHash(this.entries[this.entries.length - 1]) } } : undefined;
        return { status: 200, body: { messages: box.messages, ...(chain ? { chain } : {}) } };
      }
      if (method === 'POST' && mb[2] === '/messages') {
        if (box.messages.some((m) => m.kind === body.kind) || box.messages.length >= 5) return refusal(409, 'KIND_TAKEN');
        box.messages.push(body);
        return { status: 201, body: {} };
      }
      if (method === 'POST' && mb[2] === '/passkey') {
        box.passkey = body;
        return { status: 201, body: {} };
      }
    }
    if (route === 'GET /api/proposals') {
      if (!this.bearerKey(opts.bearer)) return refusal(401, 'UNAUTHENTICATED');
      return { status: 200, body: { proposals: url.searchParams.get('approver') === 'me' ? this.approverPending : this.pending } };
    }
    const mand = p === '/api/mandates' && method === 'GET';
    if (mand) {
      if (!this.bearerKey(opts.bearer)) return refusal(401, 'UNAUTHENTICATED');
      const m = this.mandates.get(url.searchParams.get('authorization_id') ?? '');
      return m ? { status: 200, body: { mandates: m.blobs.map((blob) => ({ blob })), revoked: m.revoked === true } } : { status: 200, body: { mandates: [], revoked: false } };
    }
    const prof = p.match(/^\/api\/profiles\/(.+)$/);
    if (prof && method === 'GET') {
      const found = this.profiles.get(decodeURIComponent(prof[1]));
      return found ? { status: 200, body: found as Json } : refusal(404, 'NOT_FOUND');
    }
    const dec = p.match(/^\/api\/proposals\/([^/]+)\/(approve|reject|resolve|withdraw)$/);
    if (dec && method === 'POST') return this.decideRoute(dec[1], dec[2], body, opts.bearer);
    if (pr && method === 'GET') {
      if (!this.bearerKey(opts.bearer)) return refusal(401, 'UNAUTHENTICATED');
      const found = this.byId.get(pr[1]);
      return found ? { status: 200, body: { proposal: found } } : refusal(404, 'NOT_FOUND');
    }
    return refusal(404, 'NOT_FOUND');
  }

  /** The decision routes, verified the way the real server verifies a device decision (plan 4.2). */
  private async decideRoute(id: string, route: string, body: Json, bearer?: string): Promise<Reply> {
    const keyId = this.bearerKey(bearer);
    if (!keyId) return refusal(401, 'UNAUTHENTICATED');
    if (this.expireSessionOnDecision) { this.expireSessionOnDecision = false; if (bearer) this.sessions.delete(bearer); return refusal(401, 'SESSION_EXPIRED'); }
    if (this.refuseDecision) { const r = this.refuseDecision; this.refuseDecision = null; return refusal(r.status, r.code); }
    const prop = this.byId.get(id);
    if (!prop) return refusal(404, 'NOT_FOUND');
    if (prop.status !== 'pending') return refusal(409, 'PROPOSAL_ALREADY_DECIDED');
    const kind = route === 'approve' || (route === 'resolve' && body.action === 'commit') ? 'commit' : 'reject';
    if (route === 'resolve' && !(prop.pendingDomains as string[]).includes(body.domain)) return refusal(400, 'DOMAIN_NOT_PENDING');
    if (body.content_hash !== prop.contentHash || body.proposalContentHash !== prop.contentHash) return refusal(409, 'CONTENT_MISMATCH');
    if (!body.device_decision) return refusal(400, 'DEVICE_DECISION_REQUIRED');
    let decision: Decision;
    try {
      decision = await verifyDecision(body.device_decision, {
        chain: await this.state(),
        expect: { proposal_id: id, mandate_id: this.mandateOf.get(id) ?? '', action: prop.tool, action_type: prop.actionType, proposal_content_hash: prop.contentHash },
      });
    } catch (e) {
      return refusal(403, (e as { code?: string }).code ?? 'REFUSED');
    }
    if (decision.decision !== kind) return refusal(400, 'DECISION_KIND_MISMATCH');
    if (decision.key_id !== keyId) return refusal(403, 'DEVICE_MISMATCH');
    if (this.seenNonces.has(decision.nonce)) return refusal(409, 'DECISION_NONCE_REUSED');
    this.seenNonces.add(decision.nonce);
    prop.status = kind === 'commit' ? 'committed' : 'rejected';
    this.decisions.push({ id, route, body, decision });
    return { status: 200, body: kind === 'commit' ? { receipt: { id: `tk-${this.decisions.length}` }, status: 'committed' } : { status: 'rejected' } };
  }

  /** Staged root-signed entries (the recovery hand-off, `return: "app"`), waiting for the person's email confirmation. */
  staged: ChainEntry[] = [];
  /** Refuse the next stage with this code. */
  refuseStage: { status: number; code: string } | null = null;

  /** Like the real stage: only a phone's rotate-root, verified against the head; nothing appended. */
  private async stageHandoff(body: Json): Promise<Reply> {
    if (this.refuseStage) { const r = this.refuseStage; this.refuseStage = null; return refusal(r.status, r.code); }
    const entry = body.entry as ChainEntry;
    if (body.return !== 'app' || entry?.op !== 'rotate-root' || entry.signer !== 'root') return refusal(400, 'BAD_OP');
    if (entry.seq !== this.entries.length) return refusal(409, 'CHAIN_HEAD_MOVED');
    try {
      const state = await verifyChain({ expectedRootDid: this.rootDid, entries: [...this.entries, entry] });
      const co = entry.sigs.find((x) => x.by !== 'root');
      if (!co || state.devices[co.by]?.kind !== 'approve-app') return refusal(400, 'BAD_OP');
    } catch {
      return refusal(404, 'NO_CHAIN');
    }
    this.staged.push(entry);
    return { status: 201, body: { handoff_id: 'h'.repeat(32), expires_at: this.clock + 600 } };
  }

  /** The person confirmed the mailed link: the last staged entry is appended. */
  async confirmStaged(): Promise<void> {
    const e = this.staged.pop();
    if (!e) throw new Error('nothing staged');
    await this.appendDirect(e);
  }

  private async postChain(body: Json, bearer?: string): Promise<Reply> {
    const entry = body.entry as ChainEntry;
    if (entry?.op === 'genesis') {
      // The real server looks at the code first (invalid, then used), then at whether the account already has a chain.
      if (typeof body.enrolment_code !== 'string' || !this.codes.has(body.enrolment_code)) return refusal(403, 'ENROLMENT_CODE_INVALID');
      if (this.usedCodes.has(body.enrolment_code)) return refusal(409, 'ENROLMENT_CODE_USED');
      if (this.entries.length) return refusal(409, 'CHAIN_EXISTS');
      // Plan 3.2 rule 2a: a phone is admitted only with a passkey registration for the credential the entry names.
      if (entry.device?.kind === 'approve-app') {
        const pk = body.passkey as PasskeyRegistration | undefined;
        if (!pk || entry.device.check?.type !== 'webauthn' || pk.cred_id !== entry.device.check.cred_id) return refusal(400, 'PASSKEY_REQUIRED');
        const want = b64uEncode(await registrationChallenge(entry.device.key_id));
        if (JSON.parse(new TextDecoder().decode(b64uDecode(pk.client_data_json))).challenge !== want) return refusal(400, 'PASSKEY_REQUIRED');
      }
      try {
        await verifyChain({ expectedRootDid: entry.root_did, entries: [entry] });
      } catch (e) {
        return refusal(400, (e as { code?: string }).code ?? 'REFUSED');
      }
      this.usedCodes.add(body.enrolment_code);
      this.rootDid = entry.root_did;
      this.entries = [entry];
      return { status: 201, body: { head: { seq: 0, hash: await entryHash(entry) } } };
    }
    if (!this.bearerKey(bearer)) return refusal(401, 'DEVICE_SESSION_REQUIRED');
    return this.append(entry, body.pairing_id);
  }

  /** `add` and friends: verified like the real one, `409 CHAIN_HEAD_MOVED` when the head moved. */
  async append(entry: ChainEntry, pairingId?: string): Promise<Reply> {
    if (entry.seq !== this.entries.length) return refusal(409, 'CHAIN_HEAD_MOVED');
    if (entry.op === 'add' && entry.device?.kind === 'approve-app') {
      const pk = pairingId ? this.mailboxes.get(pairingId)?.passkey : undefined;
      if (!pk || entry.device.check?.type !== 'webauthn' || pk.cred_id !== entry.device.check.cred_id) return refusal(400, 'PASSKEY_REQUIRED');
    }
    try {
      await verifyChain({ expectedRootDid: this.rootDid, entries: [...this.entries, entry] });
    } catch (e) {
      return refusal(400, (e as { code?: string }).code ?? 'REFUSED');
    }
    this.entries.push(entry);
    return { status: 201, body: { head: { seq: entry.seq, hash: await entryHash(entry) } } };
  }
}

// ─── a fake passkey ───────────────────────────────────────────────────────────────────

/** The phone's passkey. `prove` makes the same assertion a real one makes, so hap-core's `verifyCheck` accepts it. */
export class FakePasskeys implements CheckDevice {
  private readonly keys = new Map<string, CryptoKeyPair>();
  readonly proved: string[] = [];
  /** Set to make the next call fail like the person cancelled. */
  cancelNext = false;
  /** Set to make `register` come back without user verification. */
  noScreenLock = false;
  /** While set, `prove` waits for it: the system window is open. */
  gate: Promise<void> | null = null;
  /** True while a `prove` waits on the gate. */
  waiting = false;
  constructor(private readonly rpId = APP_RP_ID, private readonly origin = `https://${APP_RP_ID}`) {}

  async register(keyId: string, _label: string): Promise<PasskeyRegistration> {
    void _label;
    if (this.cancelNext) { this.cancelNext = false; throw new CheckError('cancelled'); }
    if (this.noScreenLock) { throw new CheckError('no_user_verification'); }
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    const point = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const credId = b64uEncode(randomBytes(16));
    this.keys.set(credId, pair);
    const clientData = utf8(JSON.stringify({ type: 'webauthn.create', challenge: b64uEncode(await registrationChallenge(keyId)), origin: this.origin }));
    return {
      cred_id: credId,
      pub: b64uEncode(encodeCoseEc2(point.slice(1, 33), point.slice(33, 65))),
      rp_id: this.rpId,
      client_data_json: b64uEncode(clientData),
      attestation_object: b64uEncode(utf8('fake-attestation')),
    };
  }

  async prove(credId: string, objectHashText: string): Promise<WebauthnProof> {
    if (this.gate) { this.waiting = true; await this.gate; this.waiting = false; }
    if (this.cancelNext) { this.cancelNext = false; throw new CheckError('cancelled'); }
    const pair = this.keys.get(credId);
    if (!pair) throw new Error('unknown credential');
    this.proved.push(objectHashText);
    const authData = concat(await sha256(utf8(this.rpId)), Uint8Array.of(0x05), Uint8Array.of(0, 0, 0, 1));
    const clientData = utf8(JSON.stringify({ type: 'webauthn.get', challenge: b64uEncode(hashBytes(objectHashText)), origin: this.origin }));
    const sig = await p256Der(pair.privateKey, concat(authData, await sha256(clientData)));
    return { authenticatorData: b64uEncode(authData), clientDataJSON: b64uEncode(clientData), signature: b64uEncode(sig) };
  }
}

// ─── a fake computer (the other device) ──────────────────────────────────────────────

export class PeerComputer {
  private constructor(
    readonly seed: Uint8Array, readonly signPub: Uint8Array, readonly readPub: Uint8Array, readonly keyId: string, readonly label: string,
    private readonly check: CryptoKeyPair | null, readonly checkPub: Uint8Array | null,
  ) {}

  /** `withCheck: false` is a computer without Touch ID: it approves but does not grant. */
  static async create(label = 'Office Mac', withCheck = true): Promise<PeerComputer> {
    const seed = randomBytes(32);
    const signPub = await ed25519PublicKey(seed);
    const check = withCheck ? ((await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair) : null;
    const checkPub = check ? new Uint8Array(await crypto.subtle.exportKey('raw', check.publicKey)) : null;
    return new PeerComputer(seed, signPub, randomBytes(32), await keyIdOf(signPub), label, check, checkPub);
  }

  record(): Promise<DeviceRecord> {
    return buildDeviceRecord({
      sign_pub: b64uEncode(this.signPub), read_pub: b64uEncode(this.readPub), kind: 'gateway', label: this.label, keystore: 'software',
      check: this.checkPub ? { type: 'platform', pub: b64uEncode(this.checkPub) } : null,
    }, this.signPub);
  }

  async proof(hash: string): Promise<{ signature: string }> {
    if (!this.check) throw new Error('this computer has no check key');
    return { signature: b64uEncode(await p256Der(this.check.privateKey, hashBytes(hash))) };
  }

  sign(bytes: Uint8Array): Promise<Uint8Array> {
    return signEd25519(this.seed, bytes);
  }
}

/** A new account whose first device is `peer`: recovery code, root key, a `genesis` signed by root and the computer, stored in `as`. */
export async function seedAccount(as: FakeAs, peer: PeerComputer): Promise<{ root: RootKey; recoveryCode: string }> {
  const { seed, code } = await generateRecoveryCode();
  const root = await deriveRootKey(seed);
  const entry = buildEntry({ root_did: root.did, seq: 0, prev: null, op: 'genesis', created_at: as.now() - 3600, signer: 'root', device: await peer.record() });
  entry.sigs = [await signEntry(entry, 'root', root.privateSeed), { by: peer.keyId, sig: b64uEncode(await peer.sign(entrySignedBytes(entry))) }];
  const hash = await entryHash(entry);
  if (peer.checkPub) entry.checks = [{ by: peer.keyId, check: (await peer.proof(hash)) as never }];
  await as.appendDirect(entry);
  return { root, recoveryCode: code };
}

/** A root-signed `remove` of a device (what the recovery code can always do). */
export async function removeWithRoot(as: FakeAs, root: RootKey, target: string): Promise<void> {
  const state = await as.state();
  const entry = buildEntry({ root_did: as.rootDid, seq: state.head.seq + 1, prev: state.head.hash, op: 'remove', target, created_at: as.now(), signer: 'root' });
  entry.sigs = [await signEntry(entry, 'root', root.privateSeed)];
  await as.appendDirect(entry);
}

/** A root-signed `add` of a computer (what the recovery code can always do); stands in for a pairing where the test is about something else. */
export async function addWithRoot(as: FakeAs, root: RootKey, peer: PeerComputer): Promise<ChainEntry> {
  const state = await as.state();
  const entry = buildEntry({ root_did: as.rootDid, seq: state.head.seq + 1, prev: state.head.hash, op: 'add', created_at: as.now(), signer: 'root', device: await peer.record() });
  entry.sigs = [await signEntry(entry, 'root', root.privateSeed), { by: peer.keyId, sig: b64uEncode(await peer.sign(entrySignedBytes(entry))) }];
  if (peer.checkPub) entry.checks = [{ by: peer.keyId, check: (await peer.proof(await entryHash(entry))) as never }];
  await as.appendDirect(entry);
  return entry;
}

// ─── the computer's side of a pairing ────────────────────────────────────────────────

/** A computer that shows a QR (`shown_by: "admitter"`) and admits the phone that scans it. */
export class PeerAdmitter {
  qrText = '';
  code: string | null = null;
  pairing!: PairingKeys;
  private box!: Mailbox;
  private qr!: PairingQr;
  private challenged: Uint8Array | null = null;
  private commit: string | null = null;
  private opened: { entry: ChainEntry; sig: string; rJ: Uint8Array } | null = null;
  result: 'admitted' | 'refused' | null = null;

  constructor(private readonly as: FakeAs, private readonly peer: PeerComputer, private readonly asUrl = AS_URL) {}

  /** Make the QR and open the mailbox. `over` replaces members of the QR (for the cases a test wants to break). */
  async open(over: Partial<PairingQr> = {}): Promise<void> {
    const state = await this.as.state();
    const secret = randomBytes(32);
    this.qr = {
      v: 1, as_url: this.asUrl, as_key: this.as.keyHex, shown_by: 'admitter', secret: b64uEncode(secret), root_did: this.as.rootDid,
      head: state.head, key_id: this.peer.keyId, expires_at: this.as.now() + 600, ...over,
    } as PairingQr;
    this.qrText = encodePairingQr(this.qr);
    this.pairing = await pairingKeysOf(this.qr);
    this.as.mailboxes.set(this.pairing.pairingId, { messages: [] });
    this.box = new Mailbox(new AsApi(this.as), this.pairing);
  }

  /** One look at the mailbox: answer `commit` with `challenge`, read `open`, work out the code. */
  async step(): Promise<void> {
    const r = await this.box.poll();
    if (!r.ok) throw new Error(`peer cannot poll: ${r.code}`);
    const m = r.messages;
    if (m.commit && !this.challenged) {
      this.commit = m.commit.body.c as string;
      this.challenged = randomBytes(32);
      await this.box.send('challenge', { r_a: b64uEncode(this.challenged) });
    }
    if (m.open && this.challenged && !this.opened) {
      const b = m.open.body as { entry: ChainEntry; sig: string; r_j: string };
      const rJ = b64uDecode(b.r_j);
      if ((await pairingCommitment(b.entry, b64uDecode(b.sig), rJ)) !== this.commit) throw new Error('commitment does not match');
      this.opened = { entry: b.entry, sig: b.sig, rJ };
      this.code = await comparisonCode(this.pairing.macKey, b.entry, rJ, this.challenged);
    }
  }

  /** The person compared the codes on this computer and confirmed: sign, append, say `done`. */
  async confirm(): Promise<void> {
    if (!this.opened) throw new Error('nothing opened');
    const { entry, sig } = this.opened;
    const hash = await entryHash(entry);
    const final: ChainEntry = {
      ...entry,
      sigs: [{ by: this.peer.keyId, sig: b64uEncode(await this.peer.sign(entrySignedBytes(entry))) }, { by: entry.device!.key_id, sig }],
      checks: [...entry.checks, { by: this.peer.keyId, check: (await this.peer.proof(hash)) as never }],
    };
    const res = await this.as.append(final, this.pairing.pairingId);
    if (res.status !== 201) {
      await this.box.send('done', { refused: ((res.body as Json).errors?.[0]?.code as string) ?? 'REFUSED' });
      this.result = 'refused';
      return;
    }
    await this.box.send('done', { entry_hash: hash });
    this.result = 'admitted';
  }

  async refuse(code: string): Promise<void> {
    await this.box.send('done', { refused: code });
    this.result = 'refused';
  }
}

/** A new computer that shows a QR (`shown_by: "joiner"`) and is admitted by the phone that scans it. */
export class PeerJoiner {
  qrText = '';
  code: string | null = null;
  pairing!: PairingKeys;
  doneMessage: PairingMessage | null = null;
  private box!: Mailbox;
  private qr!: PairingQr;
  private entry: ChainEntry | null = null;
  private sig: Uint8Array | null = null;
  private rJ: Uint8Array | null = null;
  private sentOpen = false;
  /** Send a different entry in `open` than the one committed to (the case the commitment exists for). */
  swapEntryInOpen = false;

  constructor(private readonly as: FakeAs, private readonly peer: PeerComputer, private readonly asUrl = AS_URL) {}

  async open(over: Partial<PairingQr> = {}): Promise<void> {
    this.qr = {
      v: 1, as_url: this.asUrl, as_key: this.as.keyHex, shown_by: 'joiner', secret: b64uEncode(randomBytes(32)), root_did: null, head: null, key_id: null,
      expires_at: this.as.now() + 600, ...over,
    } as PairingQr;
    this.qrText = encodePairingQr(this.qr);
    this.pairing = await pairingKeysOf(this.qr);
    this.box = new Mailbox(new AsApi(this.as), this.pairing);
  }

  async step(): Promise<void> {
    const r = await this.box.poll();
    if (!r.ok) return; // the phone has not opened the mailbox yet
    const m = r.messages;
    if (m.hello && !this.entry) {
      const h = m.hello.body as { root_did: string; head: { seq: number; hash: string }; key_id: string };
      const entry = buildEntry({
        root_did: h.root_did, seq: h.head.seq + 1, prev: h.head.hash, op: 'add', created_at: this.as.now(), signer: h.key_id, device: await this.peer.record(),
      });
      this.sig = await this.peer.sign(entrySignedBytes(entry));
      if (this.peer.checkPub) entry.checks = [{ by: this.peer.keyId, check: (await this.peer.proof(await entryHash(entry))) as never }];
      this.entry = entry;
      this.rJ = randomBytes(32);
      await this.box.send('commit', { c: await pairingCommitment(entry, this.sig, this.rJ) });
    }
    if (m.challenge && this.entry && this.sig && this.rJ && !this.sentOpen) {
      this.sentOpen = true;
      // A different entry with a VALID signature of the computer: only the commitment of message 2 can tell it from the one committed to.
      const sent = this.swapEntryInOpen ? { ...this.entry, created_at: this.entry.created_at + 1 } : this.entry;
      const sentSig = this.swapEntryInOpen ? await this.peer.sign(entrySignedBytes(sent)) : this.sig;
      await this.box.send('open', { entry: sent, sig: b64uEncode(sentSig), r_j: b64uEncode(this.rJ) });
      this.code = await comparisonCode(this.pairing.macKey, this.entry, this.rJ, b64uDecode(m.challenge.body.r_a as string));
    }
    if (m.done) this.doneMessage = m.done;
  }
}

// ─── a phone's runtime made of fakes ─────────────────────────────────────────────────

export function testRuntime(as: FakeAs, over: { passkeys?: FakePasskeys; kv?: MemoryKv } = {}) {
  const kv = over.kv ?? new MemoryKv();
  const keys = new DeviceKeyStore(kv, crypto.subtle, as.now);
  const accounts = new AccountStore(kv);
  const check = over.passkeys ?? new FakePasskeys();
  const api = new AsApi(as);
  const session = new DeviceSession({ accounts, keys, check, api, transport: as, now: as.now });
  const reader = new ProposalReader(api, session, () => session.current()?.user.id ?? '');
  const checks: CheckDeps = { api, session, keys, accounts, now: as.now };
  const decider = new PhoneDecider({ api, session, keys, accounts, reader, now: as.now });
  return { kv, keys, accounts, check, api, session, reader, checks, decider, transport: as as Transport, now: as.now, asUrl: AS_URL, rpId: APP_RP_ID };
}
export type TestRuntime = ReturnType<typeof testRuntime>;

/** Run the register flow to the end with a fresh enrolment code. Returns the driver (state `done`) and the recovery code the phone showed. */
export async function registerPhone(rt: TestRuntime, as: FakeAs, label = 'My iPhone'): Promise<{ driver: RegisterDriver; recoveryCode: string }> {
  const driver = new RegisterDriver({
    keys: rt.keys, check: rt.check, transport: rt.transport, api: rt.api, accounts: rt.accounts, asUrl: rt.asUrl, rpId: rt.rpId, now: rt.now,
  });
  await driver.submitCode(as.issueCode());
  await driver.submitName(label);
  const recoveryCode = driver.recoveryCode() as string;
  driver.codeSeen();
  driver.toggleKept(true);
  await driver.finish();
  return { driver, recoveryCode };
}
