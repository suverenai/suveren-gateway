/**
 * Sign-in by device key (device-keys plan 4.1, step 6).
 *
 *   challenge  → the AS gives a single-use nonce for this key id and its own key (`aud`)
 *   sign-in    → this computer signs { aud, root_did, key_id, nonce, chain_seq, chain_head, issued_at }
 *   session    → the AS answers a bearer token, 1 hour
 *   then       → the whole chain is fetched with that token and verified with hap-core
 *
 * After set-up this is how the gateway talks to the Authority Server: with the
 * bearer token, never the account key. The token is renewed by a fresh sign-in
 * before it ends. A restart signs in again after unlock (routes/password.ts
 * calls {@link DeviceSignin.signInInBackground}).
 *
 * What the gateway does not take on trust from the AS:
 *  - `aud`: it must be the key the gateway verified the AS holds (the challenge
 *    of as-challenge.ts), never the key the answer names;
 *  - the head: the chain is fetched and verified from the genesis on, against the
 *    head this gateway stored. A lower head is a rollback, another hash at the
 *    same number a fork; either refuses the session;
 *  - that this computer is still active in that chain.
 *
 * Codes are neutral; the words the person reads are the maintainer's (O19).
 */

import type { ChainState } from '@hap/core/device-keys';
import { deviceKeys, isDeviceKeysError } from './device-keys-lazy';
import type { Vault } from './vault';
import { loadDeviceSigningKey } from './e2e-key-manager';
import { type DeviceChainStore, type ChainHeadRef, ChainHeadRefusedError } from './device-chain-store';
import { type DeviceAsClient, AsUnreachableError, asErrorCode } from './device-as-client';
import { AsTlsMismatchError } from './as-tls-pin';
import { bearerCredential } from './as-credential';
import type { PendingIdentityReset } from './identity-reset-alarm';

/** What the gateway learned about the Authority Server before it signs anything for it. */
export type AsKeyCheck =
  | { ok: true; publicKeyHex: string }
  | { ok: false; code: 'as_unreachable' | 'as_unverified' | 'as_key_mismatch' | 'as_tls_mismatch'; message?: string };

/** The chain a sign-in is made against. */
export interface ChainRef {
  rootDid: string;
  keyId: string;
  head: ChainHeadRef;
}

export interface DeviceSession {
  token: string;
  /** Epoch seconds. */
  expiresAt: number;
  user: { id: string; did: string };
  head: ChainHeadRef;
}

export type SignInResult =
  | { ok: true; session: Omit<DeviceSession, 'token'> }
  | { ok: false; code: string; asCode?: string; transient: boolean; retryAfterSeconds?: number };

export interface DeviceSigninDeps {
  vault: Vault;
  store: DeviceChainStore;
  client: DeviceAsClient;
  /** Prove the AS holds its key (as-challenge.ts) before this computer signs anything for it. */
  checkAs: () => Promise<AsKeyCheck>;
  /**
   * Put the session where the rest of the gateway reads it: the vault's AS
   * credential, the MCP server. `first` is the sign-in that opened this unlock;
   * a renewal only swaps the token.
   */
  establish: (session: DeviceSession, first: boolean) => Promise<void>;
  /**
   * Drop the Authority Server credential everywhere it is held (the vault, the MCP
   * server) so calls fail visibly until the next sign-in succeeds. Never a stale
   * fallback. It does NOT lock the vault.
   */
  discard?: () => void | Promise<void>;
  /** A chain alarm (rollback, fork, device removed): the seam for session-lock reasons of step 14. */
  onAlarm?: (code: 'chain_rollback' | 'chain_fork' | 'device_removed') => void;
  /**
   * What the Authority Server said about a request for a new root DID at a sign-in whose chain this
   * gateway verified: the open request, or null (plan 6.2: `pending_identity_reset` in the sign-in
   * answer and in the chain answer). Not called for a probe, a failed sign-in or a locked gateway.
   */
  onPendingReset?: (p: PendingIdentityReset | null) => void;
  /** Epoch seconds. */
  now?: () => number;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
  log?: (m: string) => void;
}

/** A new sign-in this long before the token ends. */
export const RENEW_BEFORE_SECONDS = 5 * 60;
/**
 * The clock is looked at this often. A timer that waits the whole hour is late by
 * a whole sleep (the monotonic clock stops while the computer sleeps), so the wall
 * clock is compared on every look, and a wake finds the token due.
 */
export const CHECK_EVERY_MS = 30_000;
const RETRY_DELAYS_SECONDS = [30, 60, 120, 300];
/** Never worth trying again by themselves: nothing about them changes with time. */
const NO_RETRY = new Set(['locked', 'not_set_up', 'as_url_mismatch', 'chain_unreadable', 'key_missing', 'key_mismatch']);
const TOKEN_SHAPE = /^[A-Za-z0-9-]{1,128}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * The token's end never locks the vault. It only means "sign in again": when it is
 * near, when the computer wakes after it, and after the Authority Server answers
 * 401. While that fails the credential is dropped (calls fail visibly) and it is
 * tried again with backoff, for as long as the vault is unlocked. Only the page
 * session rules and explicit locks lock the vault.
 */
export class DeviceSignin {
  private inflight: Promise<SignInResult> | null = null;
  private timer: unknown = null;
  private retries = 0;
  /** Epoch seconds at which the next sign-in is due; null: none planned. */
  private nextAt: number | null = null;
  private current: { expiresAt: number; head: ChainHeadRef } | null = null;
  /** Counts locks. A sign-in that began before a lock never hands anything over after it. */
  private gen = 0;
  private readonly now: () => number;
  private readonly timers: NonNullable<DeviceSigninDeps['timers']>;
  private readonly log: (m: string) => void;

  constructor(private readonly d: DeviceSigninDeps) {
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
    this.timers = d.timers ?? {
      set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
      clear: h => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.log = d.log ?? (m => console.error(m));
    // A lock ends the session in memory, forgets a sign-in that is running, and stops the clock.
    d.vault.onLocked(() => this.stop());
  }

  /** Signed in now, and until when. No secrets. */
  status(): { signedIn: boolean; expiresAt?: number } {
    if (!this.current || this.current.expiresAt <= this.now() || !this.d.vault.isUnlocked()) return { signedIn: false };
    return { signedIn: true, expiresAt: this.current.expiresAt };
  }

  /** The vault locked: forget everything, including a sign-in still waiting for the Authority Server. */
  stop(): void {
    this.gen++;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.nextAt = null;
    this.retries = 0;
    this.current = null;
    this.inflight = null;
  }

  /** Sign in with the chain this gateway stored. One at a time: a second call shares the first. */
  signIn(): Promise<SignInResult> {
    if (this.inflight) return this.inflight;
    const run = this.run();
    this.inflight = run;
    void run.finally(() => { if (this.inflight === run) this.inflight = null; });
    return run;
  }

  /** After unlock: sign in without making the unlock wait for the Authority Server. */
  signInInBackground(): void {
    this.signIn().then(r => {
      if (!r.ok) this.log(`[Control Plane] Device sign-in did not succeed: ${r.code}${r.asCode ? ` (${r.asCode})` : ''}`);
    }).catch(() => { /* signIn never rejects */ });
  }

  /**
   * The Authority Server answered 401 to the token (or the token is known to be
   * gone). The vault stays unlocked: the credential is dropped and a new sign-in
   * starts now, then retries with backoff.
   */
  sessionLost(): void {
    if (!this.d.vault.isUnlocked() || this.inflight) return;
    this.current = null;
    void Promise.resolve(this.d.discard?.()).catch(() => {});
    this.signInInBackground();
  }

  private async run(): Promise<SignInResult> {
    const gen = this.gen;
    if (!this.d.vault.isUnlocked()) return { ok: false, code: 'locked', transient: false };
    let stored;
    try {
      stored = this.d.store.read();
    } catch {
      return { ok: false, code: 'chain_unreadable', transient: false };
    }
    if (!stored) return { ok: false, code: 'not_set_up', transient: false };
    // A chain belongs to the Authority Server it was made on.
    if (stored.asUrl !== this.d.client.asUrl) return { ok: false, code: 'as_url_mismatch', transient: false };
    const r = await this.performSignIn({ rootDid: stored.rootDid, keyId: stored.keyId, head: stored.head }, { storeHead: true });
    if (gen !== this.gen) return r; // locked meanwhile: the unlock plans its own
    if (r.ok) {
      this.retries = 0;
      this.nextAt = r.session.expiresAt - RENEW_BEFORE_SECONDS;
    } else if (!NO_RETRY.has(r.code)) {
      const delay = RETRY_DELAYS_SECONDS[Math.min(this.retries, RETRY_DELAYS_SECONDS.length - 1)];
      this.retries++;
      this.nextAt = this.now() + delay;
    } else {
      this.nextAt = null;
    }
    this.arm();
    return r;
  }

  private arm(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    if (this.nextAt === null || !this.d.vault.isUnlocked()) return;
    const ms = Math.min(CHECK_EVERY_MS, Math.max(1000, (this.nextAt - this.now()) * 1000));
    this.timer = this.timers.set(() => { this.timer = null; void this.tick(); }, ms);
  }

  /** One look at the clock. */
  private async tick(): Promise<void> {
    if (!this.d.vault.isUnlocked()) return;
    const t = this.now();
    // The token ended while nothing could renew it (an outage, a sleep): drop it, visibly.
    if (this.current && t >= this.current.expiresAt) {
      this.current = null;
      try { await this.d.discard?.(); } catch { /* the next sign-in replaces it anyway */ }
    }
    if (this.nextAt !== null && t >= this.nextAt) {
      const r = await this.signIn();
      if (!r.ok) this.log(`[Control Plane] Device sign-in renewal did not succeed: ${r.code}${r.asCode ? ` (${r.asCode})` : ''}`);
      return;
    }
    this.arm();
  }

  /**
   * One sign-in against `ref`. Set-up calls this with the genesis it just
   * stored, before anything is in the vault (`storeHead: false`); `probe` closes the
   * session again after the chain was verified, and hands nothing over.
   */
  async performSignIn(ref: ChainRef, o: { storeHead: boolean; probe?: boolean }): Promise<SignInResult> {
    const d = this.d;
    const gen = this.gen;
    const locked = (): SignInResult => ({ ok: false, code: 'locked', transient: false });
    try {
      const dk = await deviceKeys();
      const key = await d.checkAs();
      if (!key.ok) return { ok: false, code: key.code, transient: key.code === 'as_unreachable' || key.code === 'as_unverified' };

      // Never makes a key: a vault without one cannot be this computer.
      let signing;
      try { signing = loadDeviceSigningKey(d.vault); } catch { return locked(); }
      if (!signing) return { ok: false, code: 'key_missing', transient: false };
      if ((await dk.keyIdOf(signing.publicKey)) !== ref.keyId) return { ok: false, code: 'key_mismatch', transient: false };

      // 1. challenge
      const ch = await d.client.call('POST', '/api/devices/challenge', { body: { key_id: ref.keyId } });
      if (gen !== this.gen) return locked();
      if (ch.status === 429) return { ok: false, code: 'rate_limited', asCode: asErrorCode(ch.body), transient: true, retryAfterSeconds: retryAfter(ch.body) };
      if (ch.status >= 500) return { ok: false, code: 'as_error', transient: true };
      if (ch.status !== 200 || !isObj(ch.body)) return { ok: false, code: 'signin_refused', asCode: asErrorCode(ch.body), transient: false };
      const { nonce, aud } = ch.body;
      if (typeof nonce !== 'string' || !nonce || nonce.length > 256 || typeof aud !== 'string') return { ok: false, code: 'as_answer_invalid', transient: false };
      // The audience is the key we verified the AS holds, never what it says about itself.
      if (aud !== key.publicKeyHex) return { ok: false, code: 'aud_mismatch', transient: false };

      // 2. sign and open the session
      const signin = dk.buildSignin({
        aud, root_did: ref.rootDid, key_id: ref.keyId, nonce,
        chain_seq: ref.head.seq, chain_head: ref.head.hash, issued_at: this.now(),
      });
      const sig = await dk.signObject(signin, signing.privateSeed);
      const ses = await d.client.call('POST', '/api/devices/session', { body: { signin, sig } });
      if (ses.status === 429) return { ok: false, code: 'rate_limited', asCode: asErrorCode(ses.body), transient: true, retryAfterSeconds: retryAfter(ses.body) };
      if (ses.status >= 500) return { ok: false, code: 'as_error', transient: true };
      if (ses.status !== 200) {
        const asCode = asErrorCode(ses.body);
        if (asCode === 'FORK') return this.alarm('chain_fork', asCode);
        // The AS is BEHIND the head this gateway verified: it was rolled back.
        if (asCode === 'CHAIN_AHEAD') return this.alarm('chain_rollback', asCode);
        return { ok: false, code: 'signin_refused', asCode, transient: false };
      }
      const session = readSession(ses.body, this.now());
      if (!session) return { ok: false, code: 'as_answer_invalid', transient: false };
      if (gen !== this.gen) { await this.endQuietly(session.token); return locked(); }
      if (session.user.did !== ref.rootDid) {
        await this.endQuietly(session.token);
        return { ok: false, code: 'as_answer_invalid', transient: false };
      }
      // A request for a new root DID is said in the session answer; one that is there but unreadable is no answer at all.
      const pendingSession = readPendingReset(ses.body);
      if (pendingSession === 'invalid') {
        await this.endQuietly(session.token);
        return { ok: false, code: 'as_answer_invalid', transient: false };
      }

      // 3. the chain, verified from the genesis on
      const verified = await this.verifyChainOf(dk, ref, session);
      if (!verified.ok) {
        await this.endQuietly(session.token);
        return verified.result;
      }
      if (gen !== this.gen) { await this.endQuietly(session.token); return locked(); }
      if (o.storeHead) {
        try {
          d.store.advance(verified.state.head);
        } catch (e) {
          await this.endQuietly(session.token);
          if (e instanceof ChainHeadRefusedError) return this.alarm(e.reason === 'rollback' ? 'chain_rollback' : 'chain_fork');
          return { ok: false, code: 'chain_unreadable', transient: false };
        }
      }

      // 4. hand the session over
      session.head = verified.state.head;
      if (!o.probe) {
        // Either answer may carry it (they are two reads); one is enough to raise the alarm.
        try { d.onPendingReset?.(pendingSession ?? verified.pending); } catch { /* an alarm that fails to show never fails a sign-in */ }
      }
      if (o.probe) {
        // Set-up only asks "does the Authority Server hold my genesis?": the session is not kept.
        await this.endQuietly(session.token);
        return { ok: true, session: { expiresAt: session.expiresAt, user: session.user, head: session.head } };
      }
      // Whether this opens an unlock is decided HERE, from what is held now, not from what was held when the sign-in began.
      const first = this.current === null;
      try {
        await d.establish(session, first);
      } catch (e) {
        await this.endQuietly(session.token);
        return { ok: false, code: e instanceof Error && e.message === 'rekey_incomplete' ? 'rekey_incomplete' : 'establish_failed', transient: false };
      }
      if (gen !== this.gen) {
        // Locked while handing over: nothing of this session may stay anywhere.
        await this.endQuietly(session.token);
        try { await d.discard?.(); } catch { /* the lock already cleared what it holds */ }
        return locked();
      }
      this.current = { expiresAt: session.expiresAt, head: session.head };
      return { ok: true, session: { expiresAt: session.expiresAt, user: session.user, head: session.head } };
    } catch (err) {
      if (err instanceof AsTlsMismatchError) return { ok: false, code: 'as_tls_mismatch', transient: false };
      if (err instanceof AsUnreachableError) return { ok: false, code: 'as_unreachable', transient: true };
      if (gen !== this.gen) return locked();
      this.log(`[Control Plane] Device sign-in failed unexpectedly: ${err instanceof Error ? err.name : 'error'}`);
      return { ok: false, code: 'signin_failed', transient: false };
    }
  }

  private async verifyChainOf(dk: Awaited<ReturnType<typeof deviceKeys>>, ref: ChainRef, session: DeviceSession): Promise<{ ok: true; state: ChainState; pending: PendingIdentityReset | null } | { ok: false; result: SignInResult }> {
    const got = await this.d.client.call('GET', `/api/devices/chain?did=${encodeURIComponent(ref.rootDid)}`, { bearer: bearerCredential(session.token) });
    if (got.status >= 500) return { ok: false, result: { ok: false, code: 'as_error', transient: true } };
    if (got.status !== 200 || !isObj(got.body) || !Array.isArray(got.body.entries)) {
      return { ok: false, result: { ok: false, code: 'as_answer_invalid', asCode: asErrorCode(got.body), transient: false } };
    }
    let state: ChainState;
    try {
      state = await dk.verifyChain({ expectedRootDid: ref.rootDid, entries: got.body.entries, storedHead: ref.head });
    } catch (e) {
      if (isDeviceKeysError(e)) {
        if (e.code === 'ROLLBACK') return { ok: false, result: this.alarm('chain_rollback', e.code) };
        if (e.code === 'FORK') return { ok: false, result: this.alarm('chain_fork', e.code) };
        return { ok: false, result: { ok: false, code: 'chain_invalid', asCode: e.code, transient: false } };
      }
      throw e;
    }
    // The head the AS names must be the head the verified entries end in.
    const named = isObj(got.body.head) ? got.body.head : null;
    if (!named || named.seq !== state.head.seq || named.hash !== state.head.hash
      || session.head.seq !== state.head.seq || session.head.hash !== state.head.hash) {
      return { ok: false, result: { ok: false, code: 'head_mismatch', transient: false } };
    }
    if (!dk.isActive(state, ref.keyId)) return { ok: false, result: this.alarm('device_removed') };
    const pending = readPendingReset(got.body);
    if (pending === 'invalid') return { ok: false, result: { ok: false, code: 'as_answer_invalid', transient: false } };
    return { ok: true, state, pending };
  }

  private alarm(code: 'chain_rollback' | 'chain_fork' | 'device_removed', asCode?: string): SignInResult {
    this.d.onAlarm?.(code);
    return { ok: false, code, ...(asCode ? { asCode } : {}), transient: false };
  }

  /** Best effort: a session that was opened and then refused is closed again. */
  private async endQuietly(token: string): Promise<void> {
    try {
      await this.d.client.call('DELETE', '/api/devices/session', { bearer: bearerCredential(token) });
    } catch { /* it ends by itself within the hour */ }
  }
}

function retryAfter(body: unknown): number | undefined {
  const e = (body as { errors?: unknown })?.errors;
  const v = Array.isArray(e) ? (e[0] as { retry_after?: unknown } | undefined)?.retry_after : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.ceil(v) : undefined;
}

/**
 * `pending_identity_reset: { id, effective_at }` of a sign-in or chain answer: absent means none, a
 * well-formed member is the open request, anything else is `'invalid'` (never silently "none").
 */
export function readPendingReset(body: unknown): PendingIdentityReset | null | 'invalid' {
  if (!isObj(body) || !('pending_identity_reset' in body)) return null;
  const p = body.pending_identity_reset;
  // The Authority Server omits it when there is none; a null is read as "none" too, for robustness.
  if (p === null) return null;
  if (!isObj(p) || typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(p.id) || !isInt(p.effective_at)) return 'invalid';
  return { id: p.id, effectiveAt: p.effective_at };
}

/** The AS's `{ token, expires_at, user, head }`, or null when any member is not what the plan says. */
function readSession(body: unknown, now: number): DeviceSession | null {
  if (!isObj(body)) return null;
  const { token, expires_at: expiresAt, user, head } = body;
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return null;
  if (!isInt(expiresAt) || expiresAt <= now) return null;
  if (!isObj(user) || typeof user.id !== 'string' || !user.id || typeof user.did !== 'string') return null;
  if (!isObj(head) || !isInt(head.seq) || typeof head.hash !== 'string') return null;
  return { token, expiresAt, user: { id: user.id, did: user.did }, head: { seq: head.seq, hash: head.hash } };
}
