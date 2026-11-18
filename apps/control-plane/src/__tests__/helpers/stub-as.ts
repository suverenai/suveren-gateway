/**
 * A local HTTP server standing in for the Authority Server, for the device-key
 * set-up and sign-in tests. Only the NETWORK is a stand-in: it answers with the
 * request and response shapes of the real routes (suveren-as
 * app/api/{devices/chain,devices/challenge,devices/session,connect/token,as/pubkey,as/challenge}),
 * and it verifies what it is sent with the real hap-core device-keys module
 * (verifyChain, verifySignin), so a gateway that signs the wrong thing is refused
 * the way the real one refuses it.
 *
 * It records every request (method, path, headers, raw body) so a test can search
 * what the gateway sent for what it must never send.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { canonicalize } from '@hap/core';
import {
  verifyChain, verifySignin, validateSignin, validateEntryShape, b64uBytes, b64uEncode, keyIdOf, DeviceKeysError,
  verifyEd25519, signedBytes, b64uDecode, entryHash, verifyIdentityCancel,
  type ChainState, type ChainEntry,
} from '@hap/core/device-keys';

export interface Recorded { method: string; path: string; headers: IncomingMessage['headers']; body: string }

interface Code { userId: string; expiresAt: number; used: boolean; boundKeyId: string | null }

export interface StubOptions {
  /** Epoch seconds. Move it to move the Authority Server's clock. */
  now?: () => number;
}

const hex = (b: Buffer): string => b.toString('hex');

export class StubAs {
  readonly requests: Recorded[] = [];
  private server!: Server;
  url = '';
  port = 0;
  readonly pubkeyHex: string;
  private readonly priv: KeyObject;
  private readonly now: () => number;

  // behaviour switches, read live
  /** Store the next genesis and then drop the connection instead of answering. */
  dropNextGenesisAnswer = false;
  /** Answer 500 to the next N chain GETs / session POSTs. */
  failChainGets = 0;
  /** A rollback on the Authority Server: it knows the chain without its last N entries (sign-in too). */
  truncateStateBy = 0;
  /** It signs in against the full chain but SERVES a shorter one on `GET /api/devices/chain`. */
  truncateServedBy = 0;
  /** What to answer for `head` in a session. */
  headOverride: { seq: number; hash: string } | null = null;
  /** Answer the device challenge with another key as `aud`. */
  audOverride: string | null = null;
  /** Only the session answer names this head (the chain GET stays honest). */
  sessionHeadOverride: { seq: number; hash: string } | null = null;
  /** Answer `GET /api/devices/chain` with a redirect to this URL. */
  redirectChainTo: string | null = null;
  /** Answer the genesis with a head that is not the entry's. */
  lieAboutGenesisHead = false;
  /** Issue a session without checking the sign-in or the device (a lying Authority Server). */
  skipSigninChecks = false;
  /** Issue a token that is not a UUID (a header-injection attempt) / a user with another DID. */
  badToken = false;
  wrongUserDid = false;
  /** The browser step of Connect refuses (today's real behaviour: no Connect sign-in session exists). */
  connectAuthorizeRefuses = true;
  /**
   * A request for a new root DID is open (plan 6.2): the sign-in answer and the chain answer of a device session carry
   * `pending_identity_reset: { id, effective_at }`. `pendingRaw` replaces what is sent, for an answer that is not the real shape.
   */
  pendingReset: { id: string; effective_at: number } | null = null;
  pendingRaw: unknown = undefined;
  /** Which answer carries it. */
  pendingWhere: 'both' | 'session' | 'chain' = 'both';
  /** Answer an accepted cancel with this instead of the real shape (a lying Authority Server). */
  cancelAnswer: unknown = undefined;
  /** Every signed cancel the stub accepted. */
  readonly cancelled: Array<{ request_id: string; key_id: string; check: boolean }> = [];

  readonly accounts = new Map<string, { id: string; name: string; email: string; rootDid: string | null }>();
  private entries: unknown[] = [];
  private chainUser: string | null = null;
  private readonly removed = new Set<string>();
  private readonly codes = new Map<string, Code>();
  private readonly nonces = new Map<string, { keyId: string; expiresAt: number; used: boolean }>();
  private readonly sessions = new Map<string, { keyId: string; userId: string; expiresAt: number }>();
  private readonly connectCodes = new Map<string, { userId: string; challenge: string; expiresAt: number; used: boolean }>();
  // THE CONTRACT OF lib/device-recovery-contract.ts: none of these routes exists on the real Authority Server yet.
  private readonly handoffs = new Map<string, { entry: ChainEntry; challenge: string; expiresAt: number; used: boolean; userId: string }>();
  private readonly handoffCodes = new Map<string, { handoffId: string; expiresAt: number; used: boolean }>();
  /** Answer the stage with something that is not the contract's shape. */
  badStageAnswer = false;
  /** The redeem names another entry than the one stored (a lying Authority Server). */
  lieAboutRedeem = false;
  /** The lookup answers the chain whatever root key signed the request (a lying Authority Server), and may change it first. */
  lookupIgnoresRoot = false;
  lookupMutate: ((r: { root_did: string; entries: unknown[]; head: unknown }) => unknown) | null = null;

  constructor(opts: StubOptions = {}) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    this.priv = privateKey;
    this.pubkeyHex = hex(Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url'));
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.accounts.set('u1', { id: 'u1', name: 'Test Person', email: 'person@example.test', rootDid: null });
  }

  async listen(): Promise<this> {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>(r => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as { port: number }).port;
    this.url = `http://127.0.0.1:${this.port}`;
    return this;
  }

  close(): Promise<void> {
    return new Promise(r => { this.server.closeAllConnections?.(); this.server.close(() => r()); });
  }

  // ─── what the dashboard / the browser would do ──────────────────────────

  /** `POST /api/enrolment-codes` (an email-link session in the real AS). */
  issueEnrolmentCode(userId = 'u1', boundKeyId: string | null = null, ttl = 900): string {
    const code = b64(randomBytes(16));
    this.codes.set(code, { userId, expiresAt: this.now() + ttl, used: false, boundKeyId });
    return code;
  }

  /**
   * The browser step of Connect (`POST /api/connect/authorize`). Returns the loopback
   * redirect the browser follows, or null when the real AS refuses (CONNECT_SIGNIN_REQUIRED).
   */
  authorize(q: { port: string; state: string; code_challenge: string }, userId = 'u1'): string | null {
    if (this.connectAuthorizeRefuses) return null;
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(q.state)) throw new Error('state not accepted by the AS');
    const code = b64(randomBytes(32));
    this.connectCodes.set(sha256Hex(code), { userId, challenge: q.code_challenge, expiresAt: this.now() + 60, used: false });
    return `http://127.0.0.1:${q.port}/connect/callback?${new URLSearchParams({ code, state: q.state }).toString()}`;
  }

  /** Remove a device from the chain on the AS side (what a later `remove` entry would do). */
  removeDevice(keyId: string): void { this.removed.add(keyId); }

  chainEntries(): unknown[] { return this.entries; }

  /** Append an entry the way the real route would, after checking the whole chain with hap-core. */
  async appendEntry(entry: unknown): Promise<void> {
    const rootDid = this.accounts.get(this.chainUser!)!.rootDid!;
    await verifyChain({ expectedRootDid: rootDid, entries: [...this.entries, entry] });
    this.entries = [...this.entries, entry];
  }

  /** Replace the stored chain (a rewrite in the database), after checking it is a valid chain of the same root. */
  async setEntries(entries: unknown[]): Promise<void> {
    const rootDid = this.accounts.get(this.chainUser!)!.rootDid!;
    await verifyChain({ expectedRootDid: rootDid, entries });
    this.entries = entries;
  }

  /** What a browser with an email-link session does at `{AS}/recover` and on the form post (contract step 3). */
  async authorizeHandoff(q: { handoff: string; port: string; state: string }, o: { userId?: string; emailLinkSession?: boolean; crossSite?: boolean; csrf?: boolean } = {}): Promise<{ redirect: string } | { refused: string }> {
    const h = this.handoffs.get(q.handoff);
    if (!h) return { refused: 'HANDOFF_UNKNOWN' };
    if (o.emailLinkSession === false) return { refused: 'EMAIL_LINK_SESSION_REQUIRED' };
    if (o.crossSite) return { refused: 'CROSS_SITE' };
    if (o.csrf === false) return { refused: 'CSRF_INVALID' };
    if ((o.userId ?? 'u1') !== h.userId) return { refused: 'HANDOFF_OTHER_ACCOUNT' };
    if (h.used) return { refused: 'HANDOFF_USED' };
    if (h.expiresAt <= this.now()) return { refused: 'HANDOFF_EXPIRED' };
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(q.state)) throw new Error('state not accepted by the AS');
    h.used = true;
    const before = await verifyChain({ expectedRootDid: this.accounts.get(h.userId)!.rootDid!, entries: this.entries });
    try {
      await this.appendEntry(h.entry);
    } catch (e) {
      const code = e instanceof DeviceKeysError ? e.code : 'REFUSED';
      return { redirect: `http://127.0.0.1:${q.port}/recover/callback?${new URLSearchParams({ error: code, state: q.state })}` };
    }
    if (h.entry.op === 'reset') for (const [id, d] of Object.entries(before.devices)) if (d.removed_seq === null) this.removed.add(id);
    const code = b64(randomBytes(32));
    this.handoffCodes.set(sha256Hex(code), { handoffId: q.handoff, expiresAt: this.now() + 60, used: false });
    return { redirect: `http://127.0.0.1:${q.port}/recover/callback?${new URLSearchParams({ code, state: q.state })}` };
  }

  /** A request for a new root DID is open: what the sign-in and chain answers carry. */
  openReset(id = b64(randomBytes(16)), effectiveInSeconds = 72 * 3600): { id: string; effective_at: number } {
    this.pendingReset = { id, effective_at: this.now() + effectiveInSeconds };
    return this.pendingReset;
  }

  private pendingMember(where: 'session' | 'chain'): Record<string, unknown> {
    if (this.pendingWhere !== 'both' && this.pendingWhere !== where) return {};
    if (this.pendingRaw !== undefined) return { pending_identity_reset: this.pendingRaw };
    return this.pendingReset ? { pending_identity_reset: this.pendingReset } : {};
  }

  // ─── the routes ──────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await new Promise<string>(r => { let d = ''; req.on('data', c => (d += c)); req.on('end', () => r(d)); });
    const url = new URL(req.url ?? '/', 'http://x');
    this.requests.push({ method: req.method ?? '', path: url.pathname + url.search, headers: req.headers, body: raw });
    const json = (status: number, body: unknown): void => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const refuse = (status: number, code: string, message = code, extra: Record<string, unknown> = {}): void =>
      json(status, { approved: false, errors: [{ code, message, ...extra }] });
    let body: Record<string, unknown> = {};
    if (raw) { try { body = JSON.parse(raw); } catch { return refuse(400, 'MALFORMED', 'body must be JSON'); } }
    const p = url.pathname;
    const m = req.method;
    try {
      if (m === 'GET' && p === '/api/as/pubkey') return json(200, { publicKey: this.pubkeyHex });
      if (m === 'POST' && p === '/api/as/challenge') {
        // the gateway's own challenge check reads the real clock, so this one does too
        const unsigned = { typ: 'hap-as-challenge', nonce: body.nonce as string, issuedAt: Math.floor(Date.now() / 1000) };
        const bytes = Buffer.concat([Buffer.from('hap-as-challenge\u0000', 'utf-8'), Buffer.from(canonicalize(unsigned), 'utf-8')]);
        return json(200, { ...unsigned, signature: cryptoSign(null, bytes, this.priv).toString('base64url') });
      }
      if (m === 'POST' && p === '/api/devices/challenge') return this.challenge(body, json, refuse);
      if (m === 'POST' && p === '/api/devices/session') return await this.session(body, json, refuse);
      if (m === 'DELETE' && p === '/api/devices/session') {
        const s = this.bearer(req);
        if (!s) return refuse(401, 'DEVICE_SESSION_REQUIRED', 'no device session');
        this.sessions.delete(s.token);
        return json(200, { ended: true });
      }
      if (m === 'GET' && p === '/api/devices/chain') {
        if (!this.bearer(req)) return refuse(401, 'UNAUTHENTICATED', 'Authentication required');
        if (this.redirectChainTo) { res.writeHead(302, { Location: this.redirectChainTo }); res.end(); return; }
        if (this.failChainGets > 0) { this.failChainGets--; return json(500, { error: 'boom' }); }
        if (!this.chainUser || url.searchParams.get('did') !== this.accounts.get(this.chainUser)?.rootDid) return refuse(404, 'NO_CHAIN', 'no device chain for this DID');
        const entries = this.entries.slice(0, Math.max(0, this.entries.length - this.truncateStateBy - this.truncateServedBy));
        if (entries.length === 0) return json(200, { root_did: url.searchParams.get('did'), entries, head: null });
        const head = (await verifyChain({ expectedRootDid: url.searchParams.get('did')!, entries })).head;
        return json(200, { root_did: url.searchParams.get('did'), entries, head: this.headOverride ?? head, ...this.pendingMember('chain') });
      }
      if (m === 'POST' && p === '/api/devices/chain') return await this.genesis(body, res, json, refuse);
      if (m === 'POST' && p === '/api/connect/token') return await this.connectToken(body, json, refuse);
      if (m === 'POST' && p === '/api/devices/recovery/chain') return await this.recoveryLookup(body, json, refuse);
      if (m === 'POST' && p === '/api/devices/recovery/handoffs') return await this.stage(body, json, refuse);
      if (m === 'POST' && p === '/api/devices/recovery/redeem') return this.redeem(body, json, refuse);
      if (m === 'POST' && p === '/api/identity/reset/cancel') return await this.cancelReset(body, json, refuse);
      if (m === 'GET' && (p === '/api/tickets/export' || p === '/api/groups/me')) {
        // reachable with a device session or a session cookie: what the proxy-less callers send
        if (!this.bearer(req) && !req.headers.cookie) return refuse(401, 'UNAUTHENTICATED');
        return json(200, p === '/api/groups/me' ? { group: { id: 'team-1' } } : { tickets: [] });
      }
      if (m === 'GET' && p === '/api/proposals') {
        if (!this.bearer(req)) return refuse(401, 'UNAUTHENTICATED');
        return json(200, { proposals: [] });
      }
      json(404, { error: 'not found' });
    } catch (e) {
      if (e instanceof DeviceKeysError) return refuse(400, e.code, e.message);
      throw e;
    }
  }

  private bearer(req: IncomingMessage): { token: string; keyId: string; userId: string } | null {
    const m = /^Bearer ([A-Za-z0-9-]{1,128})$/.exec(String(req.headers.authorization ?? '').trim());
    if (!m) return null;
    const s = this.sessions.get(m[1]);
    if (!s || s.expiresAt <= this.now() || this.removed.has(s.keyId)) return null;
    return { token: m[1], keyId: s.keyId, userId: s.userId };
  }

  private challenge(body: Record<string, unknown>, json: Json, refuse: Refuse): void {
    try { b64uBytes(body.key_id, 32, 'key_id'); } catch { return refuse(400, 'MALFORMED', 'key_id must be 32 bytes, base64url'); }
    const nonce = b64(randomBytes(32));
    const expiresAt = this.now() + 60;
    this.nonces.set(nonce, { keyId: body.key_id as string, expiresAt, used: false });
    json(200, { nonce, expires_at: expiresAt, aud: this.audOverride ?? this.pubkeyHex });
  }

  private async state(): Promise<ChainState | null> {
    if (!this.chainUser) return null;
    const rootDid = this.accounts.get(this.chainUser)!.rootDid!;
    const entries = this.entries.slice(0, Math.max(1, this.entries.length - this.truncateStateBy));
    return verifyChain({ expectedRootDid: rootDid, entries });
  }

  private async session(body: Record<string, unknown>, json: Json, refuse: Refuse): Promise<void> {
    let keyId: string;
    try { keyId = validateSignin(body.signin).key_id; } catch (e) { return refuse(401, (e as DeviceKeysError).code ?? 'MALFORMED'); }
    const state = await this.state();
    const dev = state?.devices[keyId];
    if (!state || !dev) return refuse(401, 'NOT_ACTIVE', 'unknown device');
    if (this.removed.has(keyId) && !this.skipSigninChecks) return refuse(401, 'NOT_ACTIVE', 'this device was removed');
    if (!this.skipSigninChecks) {
      let signin;
      try {
        signin = await verifySignin({ signin: body.signin, sig: body.sig }, { aud: this.pubkeyHex, now: this.now(), chain: state });
      } catch (e) {
        if (e instanceof DeviceKeysError) return refuse(401, e.code, `sign-in refused: ${e.code}`);
        throw e;
      }
      const n = this.nonces.get(signin.nonce);
      if (!n || n.keyId !== keyId || n.used || n.expiresAt <= this.now()) return refuse(401, 'BAD_NONCE', 'nonce unknown, expired, used, or issued for another key');
      n.used = true;
    }
    const token = this.badToken ? 'abc\r\nX-Evil: 1' : randomUUID();
    const userId = this.chainUser!;
    const expiresAt = this.now() + 3600;
    this.sessions.set(token, { keyId, userId, expiresAt });
    const acc = this.accounts.get(userId)!;
    json(200, { token, expires_at: expiresAt, user: { id: acc.id, name: acc.name, email: acc.email, did: this.wrongUserDid ? 'did:key:z6MkOtherPerson' : acc.rootDid }, head: this.sessionHeadOverride ?? this.headOverride ?? state.head, ...this.pendingMember('session') });
  }

  private async genesis(body: Record<string, unknown>, res: ServerResponse, json: Json, refuse: Refuse): Promise<void> {
    const entry = validateEntryShape(body.entry);
    if (entry.op !== 'genesis') return refuse(400, 'BAD_OP', 'only a genesis entry is stored with an enrolment code');
    if (typeof body.enrolment_code !== 'string' || !body.enrolment_code || body.enrolment_code.length > 128) return refuse(403, 'ENROLMENT_CODE_INVALID', 'enrolment code missing or malformed');
    const code = this.codes.get(body.enrolment_code);
    if (!code) return refuse(403, 'ENROLMENT_CODE_INVALID', 'unknown enrolment code');
    if (code.used) return refuse(409, 'ENROLMENT_CODE_USED', 'this enrolment code was already used');
    if (code.expiresAt <= this.now()) return refuse(403, 'ENROLMENT_CODE_EXPIRED', 'this enrolment code has expired');
    if (code.boundKeyId !== null && entry.device?.key_id !== code.boundKeyId) return refuse(403, 'ENROLMENT_KEY_MISMATCH', 'this enrolment code is bound to another device key');
    const acc = this.accounts.get(code.userId)!;
    if (acc.rootDid || this.entries.length > 0) return refuse(409, 'CHAIN_EXISTS', 'this account already has a device chain');
    const state = await verifyChain({ expectedRootDid: entry.root_did, entries: [entry] });
    code.used = true;
    acc.rootDid = entry.root_did;
    this.entries = [entry];
    this.chainUser = code.userId;
    if (this.dropNextGenesisAnswer) { this.dropNextGenesisAnswer = false; res.socket?.destroy(); return; }
    json(201, { head: { seq: 0, hash: this.lieAboutGenesisHead ? `sha256:${'0'.repeat(64)}` : state.hashes[0] } });
  }

  private async recoveryLookup(body: Record<string, unknown>, json: Json, refuse: Refuse): Promise<void> {
    const l = body.lookup as Record<string, unknown> | undefined;
    const none = (): void => refuse(404, 'NO_CHAIN', 'no device chain for this key');
    if (!l || l.typ !== 'suveren-recovery-lookup' || l.v !== 1 || l.aud !== this.pubkeyHex || typeof l.root_pub !== 'string' || typeof l.issued_at !== 'number' || typeof body.sig !== 'string') return none();
    if (Math.abs(this.now() - l.issued_at) > 300) return none();
    let ok = false;
    try { ok = await verifyEd25519(b64uBytes(l.root_pub, 32, 'root_pub'), signedBytes(l as object), b64uDecode(body.sig)); } catch { ok = false; }
    if (!ok || !this.chainUser) return none();
    const rootDid = this.accounts.get(this.chainUser)!.rootDid!;
    const state = await verifyChain({ expectedRootDid: rootDid, entries: this.entries });
    if (state.root_pub !== l.root_pub && !this.lookupIgnoresRoot) return none();
    const answer = { root_did: rootDid, entries: this.entries, head: state.head };
    json(200, this.lookupMutate ? this.lookupMutate(answer) : answer);
  }

  private async stage(body: Record<string, unknown>, json: Json, refuse: Refuse): Promise<void> {
    if (typeof body.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.code_challenge)) return refuse(400, 'MALFORMED', 'code_challenge must be a base64url SHA-256');
    const entry = validateEntryShape(body.entry);
    if (entry.signer !== 'root' || (entry.op !== 'reset' && entry.op !== 'rotate-root')) return refuse(400, 'BAD_OP', 'only a root-signed reset or rotate-root is staged');
    if (!this.chainUser) return refuse(404, 'NO_CHAIN', 'no device chain');
    const rootDid = this.accounts.get(this.chainUser)!.rootDid!;
    try {
      await verifyChain({ expectedRootDid: rootDid, entries: [...this.entries, entry] }); // a dry run: nothing is appended
    } catch (e) {
      if (e instanceof DeviceKeysError) return refuse(409, e.code, e.message);
      throw e;
    }
    if (this.badStageAnswer) return json(201, { handoff_id: 'x', expires_at: 1 });
    const id = b64(randomBytes(24));
    const expiresAt = this.now() + 600;
    this.handoffs.set(id, { entry, challenge: body.code_challenge, expiresAt, used: false, userId: this.chainUser });
    json(201, { handoff_id: id, expires_at: expiresAt });
  }

  private redeem(body: Record<string, unknown>, json: Json, refuse: Refuse): void {
    if (typeof body.code !== 'string' || !body.code || body.code.length > 128) return refuse(403, 'HANDOFF_UNKNOWN', 'code missing');
    const v = body.code_verifier;
    if (typeof v !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(v)) return refuse(400, 'MALFORMED', 'code_verifier must be 43 to 128 characters');
    const c = this.handoffCodes.get(sha256Hex(body.code));
    if (!c) return refuse(403, 'HANDOFF_UNKNOWN', 'unknown code');
    const was = c.used;
    c.used = true; // any attempt uses it up
    if (was) return refuse(409, 'HANDOFF_USED', 'used');
    if (c.expiresAt <= this.now()) return refuse(403, 'HANDOFF_EXPIRED', 'expired');
    const h = this.handoffs.get(c.handoffId)!;
    if (createHash('sha256').update(v, 'ascii').digest('base64url') !== h.challenge) return refuse(403, 'PKCE_MISMATCH', 'pkce');
    void entryHash(h.entry).then(hash => {
      const lie = this.lieAboutRedeem ? `sha256:${'1'.repeat(64)}` : hash;
      json(200, { head: { seq: h.entry.seq, hash: lie }, entry_hash: lie });
    });
  }

  /** The real route's behaviour (identity-cancel.ts, hap-core's verifyIdentityCancel), answering the real shape. */
  private async cancelReset(body: Record<string, unknown>, json: Json, refuse: Refuse): Promise<void> {
    const open = this.pendingReset;
    if (!open || body.request_id !== open.id) return refuse(404, 'REQUEST_UNKNOWN', 'no such open request');
    const state = await this.state();
    if (!state) return refuse(404, 'NO_CHAIN', 'no chain');
    const signed = body.cancel === undefined ? undefined : { cancel: body.cancel, sig: body.sig, ...(body.check === undefined ? {} : { check: body.check }) };
    if (!signed) return refuse(400, 'MALFORMED', 'cancel is required');
    const c = await verifyIdentityCancel(signed, { chain: state, aud: this.pubkeyHex, requestId: open.id, now: this.now() });
    this.cancelled.push({ request_id: open.id, key_id: c.key_id, check: body.check !== undefined });
    this.pendingReset = null;
    if (this.cancelAnswer !== undefined) return json(200, this.cancelAnswer);
    json(200, { request: { id: open.id, state: 'cancelled', requested_at: open.effective_at - 72 * 3600, effective_at: open.effective_at, overridden: false } });
  }

  private async connectToken(body: Record<string, unknown>, json: Json, refuse: Refuse): Promise<void> {
    if (typeof body.code !== 'string' || !body.code || body.code.length > 128) return refuse(403, 'CONNECT_CODE_INVALID', 'connect code missing or malformed');
    const verifier = body.code_verifier;
    if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return refuse(400, 'MALFORMED', 'code_verifier must be 43 to 128 characters (RFC 7636)');
    let signPub: Uint8Array;
    try { signPub = b64uBytes(body.gateway_key, 32, 'gateway_key'); } catch { return refuse(400, 'MALFORMED', 'gateway_key must be the gateway signing public key'); }
    const row = this.connectCodes.get(sha256Hex(body.code));
    if (!row) return refuse(403, 'CONNECT_CODE_INVALID', 'connect refused: CONNECT_CODE_INVALID');
    const wasUsed = row.used;
    row.used = true; // any attempt uses the code up
    if (wasUsed) return refuse(409, 'CONNECT_CODE_USED', 'connect refused: CONNECT_CODE_USED');
    if (row.expiresAt <= this.now()) return refuse(403, 'CONNECT_CODE_EXPIRED', 'connect refused: CONNECT_CODE_EXPIRED');
    if (createHash('sha256').update(verifier, 'ascii').digest('base64url') !== row.challenge) return refuse(403, 'PKCE_MISMATCH', 'connect refused: PKCE_MISMATCH');
    const acc = this.accounts.get(row.userId)!;
    if (acc.rootDid) return refuse(409, 'CHAIN_EXISTS', 'connect refused: CHAIN_EXISTS');
    const enrolment = this.issueEnrolmentCode(row.userId, await keyIdOf(signPub));
    json(201, { enrolment_code: enrolment, expires_at: this.now() + 900, account: { name: acc.name, email: acc.email } });
  }
}

type Json = (status: number, body: unknown) => void;
type Refuse = (status: number, code: string, message?: string, extra?: Record<string, unknown>) => void;

function b64(b: Uint8Array): string { return b64uEncode(new Uint8Array(b)); }
function sha256Hex(s: string): string { return createHash('sha256').update(s, 'utf8').digest('hex'); }
