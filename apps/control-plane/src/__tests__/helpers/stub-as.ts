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
import { canonicalize, encodeDidKey } from '@hap/core';
import { confirmCodeOf } from '../../lib/device-recovery-contract';
import {
  verifyChain, verifySignin, validateSignin, validateEntryShape, b64uBytes, b64uEncode, keyIdOf, DeviceKeysError,
  verifyEd25519, signedBytes, b64uDecode, entryHash, verifyIdentityCancel,
  type ChainState, type ChainEntry,
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
  /** The Authority Server's signing key as hap-core takes it (raw seed), and its `did:key` (what a mandate names as `issuer`). */
  readonly signingSeed: Uint8Array;
  readonly issuerDid: string;
  /** Chains of OTHER people (an approver's), served by `GET /api/devices/chain?did=` like the account's own. */
  readonly otherChains = new Map<string, unknown[]>();
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
  // THE CONTRACT OF lib/device-recovery-contract.ts: none of these routes exists on the real Authority Server yet.
  private readonly handoffs = new Map<string, { entry: ChainEntry; challenge: string; port: number; stateHash: string; expiresAt: number; used: boolean; replaced: boolean; userId: string; session: string | null }>();
  /** The emails the Authority Server sent (contract step 2): the link is the only way to the page that can authorise. */
  readonly emails: Array<{ to: string; handoff: string; link: string }> = [];
  private readonly linkTokens = new Map<string, { handoff: string; used: boolean }>();
  /** The `hap-recovery` sessions the mailed links minted: cookie value to the ONE handoff it is bound to. */
  private readonly recoverySessions = new Map<string, string>();
  /** Signed lookups already answered (the same bytes again are an unknown key). */
  private readonly lookupSeen = new Set<string>();
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
    this.signingSeed = new Uint8Array(Buffer.from((privateKey.export({ format: 'jwk' }) as { d: string }).d, 'base64url'));
    this.issuerDid = encodeDidKey(Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url'));
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

  /** The hand-off ends (its time is over) without anything having been appended. */
  expireHandoffs(): void { for (const h of this.handoffs.values()) h.expiresAt = 0; }
  /** Undo `expireHandoffs` for the ones not yet used or replaced. */
  reopenHandoffs(): void { for (const h of this.handoffs.values()) if (!h.used && !h.replaced) h.expiresAt = this.now() + 600; }
  /** Test only: a hand-off that was replaced or used is open again (to show what the real one does with a chain that moved meanwhile). */
  revive(handoffId: string): void { const h = this.handoffs.get(handoffId)!; h.replaced = false; h.used = false; h.expiresAt = this.now() + 600; }
  /** Hold the answer to a stage this long (a slow Authority Server). */
  stageDelayMs = 0;
  /** The account is suspended: stage answers 404 NO_CHAIN, and an append that was staged earlier is refused ?error=ACCOUNT_SUSPENDED. */
  suspended = false;
  /** Root keys another account holds: a rotate-root to one is refused 409 ROOT_KEY_TAKEN. */
  readonly takenRootKeys = new Set<string>();
  /** The email cannot be sent (stage answers 502 MAIL_FAILED). */
  mailFails = false;

  private csrfOf(session: string, handoff: string): string { return sha256Hex(`suveren-recovery-csrf:${session}:${handoff}`); }

  /** The page the gateway opens: `/recover?handoff&port&state`. Shows the entry only in the browser the mailed link bound to THIS handoff. */
  private async recoverPage(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const html = (status: number, text: string): void => { res.writeHead(status, { 'Content-Type': 'text/html' }); res.end(text); };
    const id = url.searchParams.get('handoff') ?? '';
    const h = this.handoffs.get(id);
    if (!h) return html(404, 'This link does not work');
    if (String(h.port) !== url.searchParams.get('port') || sha256B64(url.searchParams.get('state') ?? '') !== h.stateHash) return html(400, 'This link does not work');
    const cookie = /(?:^|;\s*)(?:__Host-)?hap-recovery=([^;]+)/.exec(String(req.headers.cookie ?? ''))?.[1];
    const bound = cookie ? this.recoverySessions.get(cookie) : undefined;
    if (h.replaced) return html(410, 'Replaced');
    if (h.used) return html(409, 'Already used');
    if (h.expiresAt <= this.now()) return html(410, 'Expired');
    if (bound && bound !== id) return html(403, 'Wrong recovery (HANDOFF_OTHER)');
    if (!bound) return html(401, 'Check your email (EMAIL_LINK_SESSION_REQUIRED) <meta http-equiv="refresh" content="15">');
    const before = await verifyChain({ expectedRootDid: this.accounts.get(h.userId)!.rootDid!, entries: this.entries });
    const removes = h.entry.op === 'reset' ? Object.values(before.devices).filter(d => d.removed_seq === null).map(d => `<li>${d.label} (${d.kind})</li>`).join('') : '';
    const code = confirmCodeOf(await entryHash(h.entry));
    html(200, `<p data-op="${h.entry.op}">effect</p><ul>${removes}</ul><p class="code">${code}</p>`
      + `<form method="post" action="/api/devices/recovery/authorize"><input type="hidden" name="handoff" value="${id}"><input type="hidden" name="port" value="${h.port}">`
      + `<input type="hidden" name="state" value="${url.searchParams.get('state')}"><input type="hidden" name="csrf" value="${this.csrfOf(cookie!, id)}"></form>`);
  }

  /** `GET /recover/link?token`: shows a button, uses nothing up (a mail scanner's GET must not spend the link). */
  private linkButtonPage(url: URL, res: ServerResponse): void {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<form method="post" action="/api/devices/recovery/link"><input type="hidden" name="token" value="${url.searchParams.get('token') ?? ''}"></form>`);
  }

  /** `POST /api/devices/recovery/link`: the button. Uses the link up and sets `hap-recovery`, bound to that one handoff. */
  private consumeLink(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>, refuse: Refuse): void {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') return refuse(403, 'CROSS_SITE', 'this must be sent from suveren.ai itself');
    const t = typeof body.token === 'string' ? this.linkTokens.get(body.token) : undefined;
    const h = t ? this.handoffs.get(t.handoff) : undefined;
    if (!t || !h || t.used || h.replaced || h.used || h.expiresAt <= this.now()) return refuse(410, 'LINK_INVALID', 'this link does not work');
    t.used = true;
    const session = b64(randomBytes(32));
    h.session = session;
    this.recoverySessions.set(session, t.handoff);
    res.setHeader('Referrer-Policy', 'no-referrer');
    // `__Host-` over https (Secure, no Domain, Path=/), plain over http
    res.setHeader('Set-Cookie', this.url.startsWith('https:') ? `__Host-hap-recovery=${session}; HttpOnly; Secure; SameSite=Lax; Path=/` : `hap-recovery=${session}; HttpOnly; SameSite=Lax; Path=/`);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('Go back to the tab your computer opened and reload it.');
  }

  /** `POST /api/devices/recovery/authorize`: the order and the answers of the real route (contract step 3). */
  private async authorizeRecovery(req: IncomingMessage, res: ServerResponse, form: Record<string, unknown>, refuse: Refuse): Promise<void> {
    res.setHeader('Referrer-Policy', 'no-referrer');
    const page = (status: number, code: string): void => { res.writeHead(status, { 'Content-Type': 'text/html', 'x-code': code }); res.end(code); };
    const cookie = /(?:^|;\s*)(?:__Host-)?hap-recovery=([^;]+)/.exec(String(req.headers.cookie ?? ''))?.[1];
    const bound = cookie ? this.recoverySessions.get(cookie) : undefined;
    // 1. only the session a mailed link minted for exactly this handoff (a hap-session, an API key, a device token: none counts)
    if (!bound) return page(401, 'EMAIL_LINK_SESSION_REQUIRED');
    if (bound !== form.handoff) return page(403, 'HANDOFF_OTHER');
    // 2. same origin, 3. csrf, 4. port and state as staged
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') return refuse(403, 'CROSS_SITE', 'this must be sent from suveren.ai itself');
    const origin = req.headers.origin;
    if (origin && origin !== this.url) return refuse(403, 'CROSS_SITE', 'this must be sent from suveren.ai itself');
    if (form.csrf !== this.csrfOf(cookie!, bound)) return refuse(403, 'CSRF_INVALID', 'missing token');
    const h = this.handoffs.get(bound)!;
    if (String(h.port) !== form.port || typeof form.state !== 'string' || sha256B64(form.state) !== h.stateHash) return refuse(400, 'MALFORMED', 'port and state are not the ones this recovery was started with');
    const back = (q: Record<string, string>): void => {
      res.writeHead(302, { Location: `http://127.0.0.1:${h.port}/recover/callback?${new URLSearchParams({ ...q, state: String(form.state) })}`, 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
      res.end();
    };
    // from here every refusal is a redirect carrying its code
    if (h.replaced || h.expiresAt <= this.now()) return back({ error: 'HANDOFF_EXPIRED' });
    if (h.used) return back({ error: 'HANDOFF_USED' });
    h.used = true; // a staged entry is spent by any refused append
    if (this.suspended) return back({ error: 'ACCOUNT_SUSPENDED' });
    const before = await verifyChain({ expectedRootDid: this.accounts.get(h.userId)!.rootDid!, entries: this.entries });
    try {
      await this.appendEntry(h.entry);
    } catch (e) {
      return back({ error: e instanceof DeviceKeysError ? (e.code === 'BAD_SEQ' || e.code === 'BAD_PREV' ? 'CHAIN_HEAD_MOVED' : e.code) : 'REFUSED' });
    }
    if (h.entry.op === 'reset') for (const [id, d] of Object.entries(before.devices)) if (d.removed_seq === null) this.removed.add(id);
    this.pendingReset = null; // a root-signed entry closes an open request for a new identity
    const code = b64(randomBytes(32));
    this.handoffCodes.set(sha256Hex(code), { handoffId: bound, expiresAt: this.now() + 60, used: false });
    back({ code });
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
    if (raw && String(req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(raw));
    else if (raw) { try { body = JSON.parse(raw); } catch { return refuse(400, 'MALFORMED', 'body must be JSON'); } }
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
        const other = this.otherChains.get(url.searchParams.get('did') ?? '');
        if (other) {
          const head = (await verifyChain({ expectedRootDid: url.searchParams.get('did')!, entries: other })).head;
          return json(200, { root_did: url.searchParams.get('did'), entries: other, head });
        }
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
      if (m === 'GET' && p === '/recover') return await this.recoverPage(url, req, res);
      if (m === 'GET' && p === '/recover/link') return this.linkButtonPage(url, res);
      if (m === 'POST' && p === '/api/devices/recovery/link') return this.consumeLink(req, res, body, refuse);
      if (m === 'POST' && p === '/api/devices/recovery/authorize') return await this.authorizeRecovery(req, res, body, refuse);
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
    json(200, { token, expires_at: expiresAt, user: { id: acc.id, name: acc.name, email: acc.email, did: this.wrongUserDid ? 'did:key:z6MkOtherPerson' : acc.rootDid }, head: this.sessionHeadOverride ?? this.headOverride ?? state.head, ...this.pendingMember('session') });
  }

  private async genesis(body: Record<string, unknown>, res: ServerResponse, json: Json, refuse: Refuse): Promise<void> {
    const entry = validateEntryShape(body.entry);
    if (entry.signer === 'root' && entry.op !== 'genesis') return refuse(403, 'ROOT_ENTRY_VIA_HANDOFF', 'a root-signed entry is appended through the recovery hand-off only');
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
    if (Object.keys(l).sort().join(',') !== 'aud,issued_at,root_pub,typ,v') return none(); // exactly the members of the contract
    let ok = false;
    try { ok = await verifyEd25519(b64uBytes(l.root_pub, 32, 'root_pub'), signedBytes(l as object), b64uDecode(body.sig)); } catch { ok = false; }
    if (!ok || !this.chainUser) return none();
    if (this.lookupSeen.has(body.sig as string)) return none(); // a signed request is answered once
    this.lookupSeen.add(body.sig as string);
    const rootDid = this.accounts.get(this.chainUser)!.rootDid!;
    const state = await verifyChain({ expectedRootDid: rootDid, entries: this.entries });
    if (state.root_pub !== l.root_pub && !this.lookupIgnoresRoot) return none();
    const answer = { root_did: rootDid, entries: this.entries, head: state.head, ...(this.pendingReset ? { pending_identity_reset: this.pendingReset } : {}) };
    json(200, this.lookupMutate ? this.lookupMutate(answer) : answer);
  }

  private async stage(body: Record<string, unknown>, json: Json, refuse: Refuse): Promise<void> {
    if (typeof body.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.code_challenge)) return refuse(400, 'MALFORMED', 'code_challenge must be a base64url SHA-256');
    const entry = validateEntryShape(body.entry);
    if (entry.signer !== 'root' || (entry.op !== 'reset' && entry.op !== 'rotate-root' && entry.op !== 'set')) return refuse(400, 'BAD_OP', 'only a root-signed reset, rotate-root or set is staged');
    // As the real AS: a root-signed `set` only ADDS a computer's platform check key.
    if (entry.op === 'set' && (!entry.check || entry.check.type !== 'platform')) return refuse(400, 'BAD_OP', 'a root-signed set only adds a platform check key');
    // an unknown root DID, a suspended account: the same 404 as no chain at all
    if (!this.chainUser || this.suspended || entry.root_did !== this.accounts.get(this.chainUser)!.rootDid) return refuse(404, 'NO_CHAIN', 'no device chain');
    const rootDid = this.accounts.get(this.chainUser)!.rootDid!;
    if (entry.op === 'rotate-root' && entry.new_root && this.takenRootKeys.has(entry.new_root)) return refuse(409, 'ROOT_KEY_TAKEN', 'this recovery code is already in use; make another');
    try {
      await verifyChain({ expectedRootDid: rootDid, entries: [...this.entries, entry] }); // a dry run: nothing is appended
    } catch (e) {
      // a bad signature is not told apart from an unknown chain, and no head is returned before it verifies
      if (e instanceof DeviceKeysError && ['NOT_AUTHORISED', 'NO_POSSESSION', 'CHECK_REQUIRED', 'WRONG_ROOT'].includes(e.code)) return refuse(404, 'NO_CHAIN', 'no device chain');
      if (e instanceof DeviceKeysError) return refuse(409, e.code, e.message);
      throw e;
    }
    if (typeof body.port !== 'number' || !Number.isInteger(body.port) || body.port < 1024 || body.port > 65535) return refuse(400, 'MALFORMED', 'port');
    if (typeof body.state_hash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.state_hash)) return refuse(400, 'MALFORMED', 'state_hash');
    // one open hand-off per account: a new stage marks the old one replaced
    for (const h of this.handoffs.values()) if (h.userId === this.chainUser && !h.used) h.replaced = true;
    if (this.mailFails) return refuse(502, 'MAIL_FAILED', 'the confirmation email could not be sent; try again');
    if (this.stageDelayMs) await new Promise(r => setTimeout(r, this.stageDelayMs));
    if (this.badStageAnswer) return json(201, { handoff_id: 'x', expires_at: 1 });
    const id = b64(randomBytes(24));
    const expiresAt = this.now() + 600;
    this.handoffs.set(id, { entry, challenge: body.code_challenge, port: body.port, stateHash: body.state_hash, expiresAt, used: false, replaced: false, userId: this.chainUser, session: null });
    // the email: a single-use link that names the hand-off (contract step 2)
    const token = b64(randomBytes(24));
    this.linkTokens.set(token, { handoff: id, used: false });
    this.emails.push({ to: this.accounts.get(this.chainUser)!.email, handoff: id, link: `${this.url}/recover/link?token=${token}` });
    json(201, { handoff_id: id, expires_at: expiresAt });
  }

  private redeem(body: Record<string, unknown>, json: Json, refuse: Refuse): void {
    if (typeof body.code !== 'string' || !body.code || body.code.length > 128) return refuse(403, 'HANDOFF_UNKNOWN', 'code missing');
    const v = body.code_verifier;
    if (typeof v !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(v)) return refuse(400, 'MALFORMED', 'code_verifier must be 43 to 128 characters');
    const c = this.handoffCodes.get(sha256Hex(body.code));
    if (!c) return refuse(404, 'HANDOFF_UNKNOWN', 'unknown code');
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
    json(201, { enrolment_code: enrolment, expires_at: this.now() + 900, account: { id: row.userId, name: acc.name, email: acc.email } });
  }
}

type Json = (status: number, body: unknown) => void;
type Refuse = (status: number, code: string, message?: string, extra?: Record<string, unknown>) => void;

function b64(b: Uint8Array): string { return b64uEncode(new Uint8Array(b)); }
function sha256B64(s: string): string { return createHash('sha256').update(s, 'utf8').digest('base64url'); }
function sha256Hex(s: string): string { return createHash('sha256').update(s, 'utf8').digest('hex'); }
