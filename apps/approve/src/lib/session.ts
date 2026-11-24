/**
 * The phone's session with the Authority Server (device-keys plan 4.1, 6.2, 8; DEC-47).
 *
 *   1. prove the server holds the pinned key (as-key.ts), before anything is signed
 *   2. challenge: a single-use nonce for this key id, and the server's key as `aud`
 *   3. the phone signs { aud, root_did, key_id, nonce, chain_seq, chain_head, issued_at } with its device key
 *   4. a check over that sign-in (the app's passkey: Face ID, fingerprint or PIN): a phone session opens only with one
 *   5. the server answers a bearer token; the whole chain is fetched with it and verified from the genesis on, against the
 *      head this phone stored (a lower head is a rollback, the same number with another hash a fork)
 *   6. this phone must still be active in that chain
 *
 * The token is kept in memory only (plan 6.2): a closed app signs in again. A session ends, on the phone's side, after an
 * hour without use, 12 hours after the last check and when the app was in the background more than 5 minutes (the 5 minutes
 * are a proposed number); the server enforces its own limits and refuses with `SESSION_EXPIRED`, which the phone treats as an
 * end. Only a request made on a person's action counts as use: polling never does ({@link DeviceSession.noteUse}).
 *
 * What the phone never takes on the server's word: `aud` (it must be the pinned key), the head, and whether this phone is active.
 */
import {
  buildSignin, isActive, objectHash, signedBytes, b64uEncode, verifyChain,
  type ChainEntry, type ChainState,
} from '@hap/core/device-keys';
import type { AccountStore, HeadRef } from './account-store';
import { HeadRefusedError } from './account-store';
import type { DeviceKeyStore } from './key-store';
import type { CheckDevice } from './check';
import { CheckError } from './check';
import type { AsApi } from './as-api';
import type { Transport } from './transport';
import { proveAsKey } from './as-key';

export type SessionCode =
  | 'not_paired' | 'keys_missing'
  | 'as_unreachable' | 'as_unverified' | 'as_key_mismatch' | 'as_answer_invalid' | 'aud_mismatch' | 'as_error'
  | 'signin_refused' | 'rate_limited'
  | 'chain_invalid' | 'chain_rollback' | 'chain_fork' | 'head_mismatch' | 'device_removed'
  | 'cancelled' | 'unsupported' | 'no_user_verification' | 'check_failed';

export interface OpenSession {
  token: string;
  /** Epoch seconds, as the server said. */
  expiresAt: number;
  user: { id: string; name?: string; email?: string; did: string };
  /** The verified chain at the head the server named. */
  chain: ChainState;
  entries: ChainEntry[];
  /** Epoch seconds. */
  openedAt: number;
}

export type OpenResult = { ok: true; session: OpenSession } | { ok: false; code: SessionCode; asCode?: string };

export interface SessionDeps {
  accounts: AccountStore;
  keys: DeviceKeyStore;
  check: CheckDevice;
  api: AsApi;
  transport: Transport;
  /** Epoch seconds. */
  now: () => number;
}

/** The phone's own limits (plan 8, 6.2). Seconds. */
export const IDLE_LIMIT = 60 * 60;
export const CHECK_LIMIT = 12 * 60 * 60;
/** Proposed number. */
export const BACKGROUND_LIMIT = 5 * 60;

/** A refused call, as the code the screens know. */
function failureCode(r: { status: number; code: string }): SessionCode {
  if (r.status === 0) return 'as_unreachable';
  if (r.code === 'RATE_LIMITED') return 'rate_limited';
  if (r.status >= 500) return 'as_error';
  return 'signin_refused';
}

/** How long a challenge fetched ahead is used (seconds); older, a fresh one is asked for. The server's own limit stays in force. */
export const PREPARED_FOR = 60;

type Prepared = { ok: true; nonce: string; aud: string } | { ok: false; code: SessionCode; asCode?: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const TOKEN_SHAPE = /^[A-Za-z0-9-]{1,128}$/;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export class DeviceSession {
  private cur: OpenSession | null = null;
  private lastUse = 0;
  private checkedAt = 0;
  private hiddenAt: number | null = null;
  private inflight: Promise<OpenResult> | null = null;
  /** The sign-in's first steps fetched ahead ({@link DeviceSession.prepare}): used once, within {@link PREPARED_FOR} seconds. */
  private prepared: { keyId: string; at: number; result: Promise<Prepared> } | null = null;

  constructor(private readonly d: SessionDeps) {}

  current(): OpenSession | null { return this.cur; }

  /** The bearer token while the session stands by the phone's own limits; null otherwise (the screen then asks for the check). */
  bearer(): string | null {
    if (!this.cur) return null;
    const t = this.d.now();
    if (t - this.lastUse > IDLE_LIMIT || t - this.checkedAt > CHECK_LIMIT || t >= this.cur.expiresAt) {
      this.drop();
      return null;
    }
    return this.cur.token;
  }

  /** A request the person made counts as use. Polling and background reads never call this. */
  noteUse(): void { this.lastUse = this.d.now(); }

  /** The server said the session is over (401, SESSION_EXPIRED): forget it. */
  lost(): void { this.drop(); }

  /** The app went to the background (`visibilitychange`). */
  noteBackground(): void { this.hiddenAt = this.d.now(); }

  /** The app came back. After more than 5 minutes away the session is over and the screen asks for the check again. */
  noteForeground(): void {
    const away = this.hiddenAt === null ? 0 : this.d.now() - this.hiddenAt;
    this.hiddenAt = null;
    if (away > BACKGROUND_LIMIT) this.drop();
  }

  private drop(): void {
    const had = this.cur;
    this.cur = null;
    if (had) void this.d.api.endSession(had.token).catch(() => { /* it ends by itself */ });
  }

  /** End the session on purpose. */
  async end(): Promise<void> {
    this.drop();
  }

  /**
   * Fetch the sign-in's first steps ahead (prove the server's key, ask for a challenge) while the open screen waits for the tap, so
   * the check prompt follows the tap at once. Nothing is signed and no check is asked for here. Used by the next {@link open}
   * within {@link PREPARED_FOR} seconds, once; a failure here just means {@link open} asks again.
   */
  prepare(): void {
    if (this.cur || this.inflight) return;
    if (this.prepared && this.d.now() - this.prepared.at < PREPARED_FOR) return;
    void (async () => {
      const account = await this.d.accounts.read().catch(() => null);
      if (!account) return;
      this.prepared = { keyId: account.key_id, at: this.d.now(), result: this.firstSteps(account.as_key, account.key_id) };
    })();
  }

  private async firstSteps(asKeyPinned: string, keyId: string): Promise<Prepared> {
    try {
      const asKey = await proveAsKey(this.d.transport, asKeyPinned, this.d.now);
      if (!asKey.ok) return { ok: false, code: asKey.code };
      const ch = await this.d.api.challenge(keyId);
      if (!ch.ok) return { ok: false, code: failureCode(ch), asCode: ch.code };
      const { nonce, aud } = ch.data;
      if (typeof nonce !== 'string' || !nonce || nonce.length > 256 || typeof aud !== 'string') return { ok: false, code: 'as_answer_invalid' };
      return { ok: true, nonce, aud };
    } catch {
      return { ok: false, code: 'as_error' };
    }
  }

  /** Open a session. One at a time: a second call shares the first. Asks the person for the check. */
  open(): Promise<OpenResult> {
    if (this.inflight) return this.inflight;
    const run = this.run();
    this.inflight = run;
    void run.finally(() => { if (this.inflight === run) this.inflight = null; });
    return run;
  }

  /**
   * Fetch the chain again with the open session and verify it against the stored head (the device list screen and every
   * pairing start from this). Moves the stored head forward.
   */
  async refreshChain(): Promise<OpenResult> {
    const s = this.cur;
    if (!s || !this.bearer()) return { ok: false, code: 'signin_refused' };
    const account = await this.d.accounts.read();
    if (!account) return { ok: false, code: 'not_paired' };
    const r = await this.verifyChainOf(account.root_did, account.key_id, s.token);
    if (!r.ok) return r;
    this.cur = { ...s, chain: r.state, entries: r.entries };
    return { ok: true, session: this.cur };
  }

  private async run(): Promise<OpenResult> {
    const d = this.d;
    try {
      const account = await d.accounts.read();
      if (!account) return { ok: false, code: 'not_paired' };
      const keys = await d.keys.publicKeys();
      if (!keys || keys.keyId !== account.key_id) return { ok: false, code: 'keys_missing' };

      // The steps fetched ahead are used once, if fresh and for this key; a failed or old one is asked for again (never trusted more).
      const ahead = this.prepared;
      this.prepared = null;
      let first: Prepared | null = null;
      if (ahead && ahead.keyId === account.key_id && d.now() - ahead.at < PREPARED_FOR) {
        const got = await ahead.result;
        if (got.ok) first = got;
      }
      if (!first) first = await this.firstSteps(account.as_key, account.key_id);
      if (!first.ok) return first;
      const { nonce, aud } = first;
      // The audience is the key the phone verified the server holds, never what the answer says about itself.
      if (aud !== account.as_key) return { ok: false, code: 'aud_mismatch' };

      const signin = buildSignin({
        aud, root_did: account.root_did, key_id: account.key_id, nonce,
        chain_seq: account.head.seq, chain_head: account.head.hash, issued_at: d.now(),
      });
      const sig = b64uEncode(await d.keys.sign(signedBytes(signin)));
      const proof = await d.check.prove(account.check.cred_id, await objectHash(signin));

      const ses = await d.api.openSession(signin, sig, proof);
      if (!ses.ok) {
        if (ses.code === 'FORK') return { ok: false, code: 'chain_fork', asCode: ses.code };
        // The server is BEHIND the head this phone verified: it was rolled back.
        if (ses.code === 'CHAIN_AHEAD') return { ok: false, code: 'chain_rollback', asCode: ses.code };
        return { ok: false, code: failureCode(ses), asCode: ses.code };
      }
      const a = ses.data as unknown;
      if (!isObj(a) || typeof a.token !== 'string' || !TOKEN_SHAPE.test(a.token) || !isInt(a.expires_at) || a.expires_at <= d.now()
        || !isObj(a.user) || typeof a.user.id !== 'string' || typeof a.user.did !== 'string' || !isObj(a.head) || !isInt(a.head.seq) || typeof a.head.hash !== 'string') {
        return { ok: false, code: 'as_answer_invalid' };
      }
      const token = a.token;
      const user = a.user as { id: string; name?: unknown; email?: unknown; did: string };
      const named = a.head as unknown as HeadRef;
      if (user.did !== account.root_did) { await d.api.endSession(token).catch(() => {}); return { ok: false, code: 'as_answer_invalid' }; }

      const v = await this.verifyChainOf(account.root_did, account.key_id, token, named);
      if (!v.ok) { await d.api.endSession(token).catch(() => {}); return v; }

      const t = d.now();
      this.cur = {
        token, expiresAt: a.expires_at,
        user: { id: user.id, did: user.did, ...(typeof user.name === 'string' ? { name: user.name } : {}), ...(typeof user.email === 'string' ? { email: user.email } : {}) },
        chain: v.state, entries: v.entries, openedAt: t,
      };
      this.lastUse = t;
      this.checkedAt = t;
      return { ok: true, session: this.cur };
    } catch (e) {
      if (e instanceof CheckError) return { ok: false, code: e.code === 'failed' ? 'check_failed' : e.code };
      return { ok: false, code: 'as_error' };
    }
  }

  /** Fetch and verify the chain; the head the server named (if any) must be the head the verified entries end in. */
  private async verifyChainOf(rootDid: string, keyId: string, token: string, named?: HeadRef): Promise<{ ok: true; state: ChainState; entries: ChainEntry[] } | { ok: false; code: SessionCode; asCode?: string }> {
    const d = this.d;
    const account = await d.accounts.read();
    if (!account) return { ok: false, code: 'not_paired' };
    const got = await d.api.chain(rootDid, token);
    if (!got.ok) return { ok: false, code: got.status === 0 ? 'as_unreachable' : got.status >= 500 ? 'as_error' : 'as_answer_invalid', asCode: got.code };
    if (!Array.isArray(got.data.entries)) return { ok: false, code: 'as_answer_invalid' };
    let state: ChainState;
    try {
      state = await verifyChain({ expectedRootDid: rootDid, entries: got.data.entries, storedHead: account.head });
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      if (code === 'ROLLBACK') return { ok: false, code: 'chain_rollback', asCode: 'ROLLBACK' };
      if (code === 'FORK') return { ok: false, code: 'chain_fork', asCode: 'FORK' };
      if (typeof code === 'string') return { ok: false, code: 'chain_invalid', asCode: code };
      throw e;
    }
    const said = got.data.head;
    if (!said || said.seq !== state.head.seq || said.hash !== state.head.hash) return { ok: false, code: 'head_mismatch' };
    if (named && (named.seq !== state.head.seq || named.hash !== state.head.hash)) return { ok: false, code: 'head_mismatch' };
    if (!isActive(state, keyId)) return { ok: false, code: 'device_removed' };
    try {
      await d.accounts.advance(state.head);
    } catch (e) {
      if (e instanceof HeadRefusedError) return { ok: false, code: e.reason === 'rollback' ? 'chain_rollback' : 'chain_fork' };
      throw e;
    }
    return { ok: true, state, entries: got.data.entries as ChainEntry[] };
  }
}
