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
  type ChainState,
} from '@hap/core/device-keys';

export interface Recorded { method: string; path: string; headers: IncomingMessage['headers']; body: string }

interface Code { userId: string; expiresAt: number; used: boolean; boundKeyId: string | null }

/** What a route added with {@link StubAs.extraRoutes} is given. */
export interface ExtraRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  body: Record<string, unknown>;
  /** The device session of the call, as the real routes read it (`Authorization: Bearer`). */
  session: { token: string; keyId: string; userId: string } | null;
  json: (status: number, body: unknown) => void;
  refuse: (status: number, code: string, message?: string, extra?: Record<string, unknown>) => void;
}

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
  /** More routes of the real Authority Server (the proposal routes of step 12 live in helpers/stub-as-proposals.ts). Return true when answered. */
  extraRoutes: ((c: ExtraRouteContext) => Promise<boolean>) | null = null;

  readonly accounts = new Map<string, { id: string; name: string; email: string; rootDid: string | null }>();
  private entries: unknown[] = [];
  private chainUser: string | null = null;
  private readonly removed = new Set<string>();
  private readonly codes = new Map<string, Code>();
  private readonly nonces = new Map<string, { keyId: string; expiresAt: number; used: boolean }>();
  private readonly sessions = new Map<string, { keyId: string; userId: string; expiresAt: number }>();
  private readonly connectCodes = new Map<string, { userId: string; challenge: string; expiresAt: number; used: boolean }>();

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
        return json(200, { root_did: url.searchParams.get('did'), entries, head: this.headOverride ?? head });
      }
      if (m === 'POST' && p === '/api/devices/chain') return await this.genesis(body, res, json, refuse);
      if (m === 'POST' && p === '/api/connect/token') return await this.connectToken(body, json, refuse);
      if (m === 'GET' && (p === '/api/tickets/export' || p === '/api/groups/me')) {
        // reachable with a device session or a session cookie: what the proxy-less callers send
        if (!this.bearer(req) && !req.headers.cookie) return refuse(401, 'UNAUTHENTICATED');
        return json(200, p === '/api/groups/me' ? { group: { id: 'team-1' } } : { tickets: [] });
      }
      if (m === 'GET' && p === '/api/proposals') {
        if (!this.bearer(req)) return refuse(401, 'UNAUTHENTICATED');
        return json(200, { proposals: [] });
      }
      if (this.extraRoutes && await this.extraRoutes({ req, res, method: m ?? '', path: p, body, session: this.bearer(req), json, refuse })) return;
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
    json(200, { token, expires_at: expiresAt, user: { id: acc.id, name: acc.name, email: acc.email, did: this.wrongUserDid ? 'did:key:z6MkOtherPerson' : acc.rootDid }, head: this.sessionHeadOverride ?? this.headOverride ?? state.head });
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
