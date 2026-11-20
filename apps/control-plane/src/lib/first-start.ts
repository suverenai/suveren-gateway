/**
 * One-time start access (DEC-93): a gateway that nobody has used yet starts its set-up at Connect, with no copied
 * account key. Logic only; routes/first-start.ts is the API.
 *
 * Who may use it: only a gateway that is UNCLAIMED — its vault is pristine (locked, no password, no account-key
 * verifier, no credential, no slot, nothing sealed) and no Connect ever bound it to an account (a marker file beside
 * the vault). While it is unclaimed, the page may open a START SESSION: its own cookie and header token (never the
 * page session's), loopback only, Origin and Host checked, and it reaches nothing but the routes in this file.
 *
 * Order (DEC-91): Connect → unlock password → recovery code → done.
 *   connect   makes this computer's device signing key IN MEMORY (there is no vault yet), state and a PKCE verifier,
 *             and the address to open in the system browser. The browser comes back to /connect/callback; the code
 *             is redeemed with the verifier and that signing key for an enrolment code bound to it, and the account
 *             (id, name, email). From that moment the gateway is CLAIMED: the marker is written, and no new start
 *             session can be opened again, also after a restart.
 *   password  creates the vault, bound to the account Connect named (the account the vault belongs to is known now:
 *             the problem that made Connect-first impossible), stores the signing key in it and opens the first page
 *             session. The start sessions end. The enrolment code and the account wait in memory for set-up's finish,
 *             which posts the genesis with them; nothing else is kept.
 *
 * A restart after Connect and before the password loses what is in memory (the signing key, the enrolment code):
 * the gateway is claimed and the start access is gone for good, so the person signs in the ordinary way (account key)
 * and sets up from there. Never a second start access for a gateway that was bound once.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Vault } from './vault';
import { PageSessions } from './page-session';
import { generateDeviceSigningKey, storeDeviceSigningKey, type DeviceSigningKey } from './e2e-key-manager';
import { DeviceAsClient, AsUnreachableError, asErrorCode } from './device-as-client';
import { AsTlsMismatchError } from './as-tls-pin';
import type { AsKeyCheck } from './device-signin';
import { CONNECT_TTL_MS, SetupRefusal, type ConnectAccount } from './device-setup';

export const START_COOKIE = 'suveren_start_session';
export const START_HEADER = 'x-suveren-start';
export const CLAIMED_MARKER = 'first-start-claimed.json';

/** The account Connect named: its id binds the vault (DEC-93). */
export interface ConnectedAccount extends ConnectAccount { id: string }

interface StartConnect {
  state: Buffer;
  verifier: string;
  port: number;
  sessionId: string;
  expiresAt: number;
  used: boolean;
  status: 'waiting' | 'ready' | 'failed';
  failure?: { code: string; asCode?: string };
  result?: { enrolmentCode: string; account: ConnectedAccount };
}

export interface FirstStartDeps {
  vault: Vault;
  client: DeviceAsClient;
  checkAs: () => Promise<AsKeyCheck>;
  /** Epoch ms. */
  now?: () => number;
  /** Tests: a session store with a controlled clock. */
  sessions?: PageSessions;
}

const sha256Ascii = (s: string): Buffer => createHash('sha256').update(s, 'ascii').digest();
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export class FirstStart {
  readonly sessions: PageSessions;
  private readonly now: () => number;
  /** The start sessions that may carry on after the gateway is claimed: the one that started Connect. */
  private readonly flow = new Set<string>();
  private connect: StartConnect | null = null;
  private signing: DeviceSigningKey | null = null;
  /** After the password: what set-up's finish posts. Memory only. */
  private handover: { enrolmentCode: string; account: ConnectAccount } | null = null;

  constructor(private readonly d: FirstStartDeps) {
    this.sessions = d.sessions ?? new PageSessions();
    this.now = d.now ?? Date.now;
  }

  private markerPath(): string { return join(this.d.vault.directory(), CLAIMED_MARKER); }

  /** Bound to an account once, by a Connect that worked. Kept on disk: a restart never reopens the start access. */
  claimed(): boolean { return existsSync(this.markerPath()); }

  /** May a NEW start session be opened? Only on a gateway nobody has used and nobody has claimed. */
  available(): boolean {
    return !this.claimed() && this.d.vault.isPristine();
  }

  /** Open a start session (the route sets its cookie and hands the token to the page). */
  open(): { cookie: string; token: string; id: string } {
    if (!this.available()) throw new SetupRefusal(409, 'start_unavailable');
    const s = this.sessions.open();
    const id = this.sessions.idOf(s.cookie)!;
    this.flow.add(id);
    return { ...s, id };
  }

  /**
   * Is this request inside a start session that may still act? The session must be valid AND either the gateway is
   * still unclaimed or this is the session whose Connect claimed it (it goes on to the password).
   */
  sessionIdFor(cookie: string | undefined, token: string | undefined): string | null {
    const r = this.sessions.validate(cookie, token, true);
    if (!r.ok) return null;
    const id = this.sessions.idOf(cookie);
    if (!id || !this.flow.has(id)) return null;
    if (this.available()) return id;
    // Claimed: only the session that holds the claiming Connect goes on, and only until the password.
    return this.connect?.sessionId === id && !this.d.vault.hasPassword() ? id : null;
  }

  /** Begin Connect. `port` is the port THIS server answers on (the Authority Server builds the redirect from it). */
  async connectStart(port: number, sessionId: string, localAddress?: string): Promise<{ authorizeUrl: string; expiresAt: number }> {
    if (!this.available()) throw new SetupRefusal(409, 'start_unavailable');
    if (!sessionId) throw new SetupRefusal(401, 'unauthorized');
    if (localAddress !== '127.0.0.1' && localAddress !== '::ffff:127.0.0.1') throw new SetupRefusal(409, 'connect_loopback_unsupported');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new SetupRefusal(409, 'connect_port_unsupported');
    this.signing ??= await generateDeviceSigningKey();
    const state = randomBytes(32);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = sha256Ascii(verifier).toString('base64url');
    const expiresAt = this.now() + CONNECT_TTL_MS;
    this.connect = { state, verifier, port, sessionId, expiresAt, used: false, status: 'waiting' };
    const q = new URLSearchParams({ port: String(port), state: state.toString('base64url'), code_challenge: challenge });
    return { authorizeUrl: `${this.d.client.asUrl}/connect?${q.toString()}`, expiresAt };
  }

  /**
   * The system browser came back (no session: a cross-site redirect carries no SameSite=Strict cookie). `state`
   * authorises it: random, kept only here, single use. 'unknown' when it is not ours (set-up's Connect may own it).
   */
  async connectCallback(query: { state?: unknown; code?: unknown; error?: unknown }): Promise<'accepted' | 'unknown'> {
    const c = this.connect;
    if (!c || typeof query.state !== 'string') return 'unknown';
    let given: Buffer;
    try { given = Buffer.from(query.state, 'base64url'); } catch { return 'unknown'; }
    if (given.length !== c.state.length || !timingSafeEqual(given, c.state)) return 'unknown';
    if (c.used || c.expiresAt <= this.now()) return 'unknown';
    c.used = true;
    if (typeof query.error === 'string') {
      c.status = 'failed';
      c.failure = { code: 'connect_refused', ...(SAFE_CODE.test(query.error) ? { asCode: query.error } : {}) };
      return 'accepted';
    }
    if (typeof query.code !== 'string' || !query.code || query.code.length > 128 || !this.signing) {
      c.status = 'failed';
      c.failure = { code: 'connect_refused' };
      return 'accepted';
    }
    // A second gateway may have been claimed in between (another start session's Connect): the first one wins.
    if (this.claimed()) { c.status = 'failed'; c.failure = { code: 'start_unavailable' }; return 'accepted'; }
    try {
      const key = await this.d.checkAs();
      if (!key.ok) { c.status = 'failed'; c.failure = { code: key.code }; return 'accepted'; }
      const r = await this.d.client.call('POST', '/api/connect/token', {
        body: { code: query.code, code_verifier: c.verifier, gateway_key: Buffer.from(this.signing.publicKey).toString('base64url') },
      });
      const body = r.body as { enrolment_code?: unknown; account?: { id?: unknown; name?: unknown; email?: unknown } } | null;
      const a = body?.account;
      if (r.status === 201 && typeof body?.enrolment_code === 'string' && body.enrolment_code.length > 0 && body.enrolment_code.length <= 128
        && typeof a?.id === 'string' && a.id.length > 0 && typeof a.name === 'string' && typeof a.email === 'string') {
        this.writeMarker(a.id);
        c.status = 'ready';
        c.result = { enrolmentCode: body.enrolment_code, account: { id: a.id, name: a.name, email: a.email } };
      } else {
        c.status = 'failed';
        c.failure = r.status === 201
          ? { code: 'as_answer_invalid' }
          : { code: 'connect_refused', ...(asErrorCode(r.body) ? { asCode: asErrorCode(r.body) } : {}) };
      }
    } catch (err) {
      c.status = 'failed';
      c.failure = { code: err instanceof AsTlsMismatchError ? 'as_tls_mismatch' : err instanceof AsUnreachableError ? 'as_unreachable' : 'connect_failed' };
    }
    return 'accepted';
  }

  /** The start session that began Connect asks how it went. The enrolment code never leaves this process. */
  connectStatus(sessionId: string): { state: 'waiting' | 'ready' | 'failed' | 'expired'; code?: string; asCode?: string; account?: ConnectAccount } {
    const c = this.connect;
    if (!c) throw new SetupRefusal(404, 'connect_not_started');
    if (c.sessionId !== sessionId) throw new SetupRefusal(403, 'connect_other_session');
    if (c.status === 'waiting' && c.expiresAt <= this.now()) return { state: 'expired', code: 'connect_timeout' };
    if (c.status === 'ready') return { state: 'ready', account: { name: c.result!.account.name, email: c.result!.account.email } };
    if (c.status === 'failed') return { state: 'failed', code: c.failure!.code, ...(c.failure!.asCode ? { asCode: c.failure!.asCode } : {}) };
    return { state: 'waiting' };
  }

  /**
   * The unlock password, after Connect: the vault is created bound to the connected account, the signing key the
   * enrolment code is bound to goes into it, and the start access ends. The caller opens the first page session.
   */
  async setPassword(password: string, sessionId: string): Promise<{ account: ConnectAccount }> {
    const c = this.connect;
    if (!c || c.sessionId !== sessionId || c.status !== 'ready' || !c.result) throw new SetupRefusal(409, 'connect_not_ready');
    if (this.d.vault.hasPassword()) throw new SetupRefusal(409, 'password_exists');
    if (!this.signing) throw new SetupRefusal(409, 'connect_not_ready');
    try {
      await this.d.vault.createWithPassword(password, c.result.account.id);
    } catch {
      throw new SetupRefusal(409, 'start_unavailable');
    }
    storeDeviceSigningKey(this.d.vault, this.signing);
    const { enrolmentCode, account } = c.result;
    this.handover = { enrolmentCode, account: { name: account.name, email: account.email } };
    this.connect = null;
    this.signing.privateSeed.fill(0);
    this.signing = null;
    this.flow.clear();
    this.sessions.endAll();
    return { account: { name: account.name, email: account.email } };
  }

  /** For set-up (lib/device-setup.ts): the Connect done before the vault existed, if there is one. */
  pending(): { enrolmentCode: string; account: ConnectAccount } | null { return this.handover; }
  /** Set-up's finish stored the chain: what Connect left is no longer needed. */
  clear(): void { this.handover = null; }

  private writeMarker(accountId: string): void {
    const dir = this.d.vault.directory();
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `${CLAIMED_MARKER}.tmp`);
    writeFileSync(tmp, JSON.stringify({ v: 1, accountId, claimedAt: Math.floor(this.now() / 1000) }), { mode: 0o600 });
    renameSync(tmp, this.markerPath());
  }
}
