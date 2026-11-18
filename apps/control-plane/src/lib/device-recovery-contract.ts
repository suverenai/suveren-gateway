/**
 * THE AUTHORITY SERVER CONTRACT for root-signed chain entries made from the gateway
 * (device-keys plan 10 "Everything lost, code kept" and "Recovery code exposed", DEC-15,
 * DEC-37, DEC-56; build step 7, gateway side).
 *
 * WHY A CONTRACT: a root-signed entry (`reset`, `rotate-root`) needs two things at the
 * Authority Server: the entry, signed with the recovery code's root key, AND an email-link
 * session of the account (DEC-15). The gateway must NOT carry that session: the email-link
 * cookie belongs to the person's browser, and a gateway (or the AI that can reach it) that
 * held it could append root-signed entries alone. Today the Authority Server accepts a
 * root-signed entry only on `POST /api/devices/chain` WITH the cookie, and a fresh gateway
 * has no way to read the chain it must extend. So the hand-off below is specified here, in
 * the shape of Connect (RFC 8252 loopback, PKCE S256, `state` bound to the page session),
 * and the gateway is built against it. NOTHING IN THIS FILE EXISTS ON THE AUTHORITY SERVER
 * YET; until it does, only the test stand-in (`__tests__/helpers/stub-as.ts`) answers it.
 *
 * The flow, end to end (as the Authority Server was built from it, 2026-11-18):
 *
 *   1. LOOKUP (fresh gateway only). The gateway derives the root key from the typed code and
 *      asks for the chain with a request signed by that root key: possession of the code is
 *      the authorisation, the code itself never travels. The signed object has EXACTLY the
 *      members of {@link RecoveryLookup}. A signed request is answered ONCE: the same signed
 *      bytes again give the same `404 NO_CHAIN` as an unknown key, so the gateway builds a
 *      fresh lookup for every call (its `issued_at` strictly rises) and never retries a body.
 *      Rate limits: 30 per minute per address, 10 per minute per root key. No session.
 *      The gateway verifies the chain with hap-core from the genesis on and refuses it unless
 *      the root key in force at its head is the key the code derives.
 *   2. STAGE. The gateway builds the entry, signs it (root key, this computer's key, this
 *      computer's check where it has one) and posts `{entry, code_challenge, port,
 *      state_hash}`: port 1024 to 65535, `state_hash` = base64url(sha256(utf8(state))); both
 *      are fixed here like an OAuth redirect_uri, and the redirect uses the stored port.
 *      No session: the entry carries its own proof. The AS verifies it as `POST
 *      /api/devices/chain` would, appends nothing, EMAILS the account a single-use 10-minute
 *      link `{AS}/recover/link?token=...`, and tells every device of the old chain. ONE open
 *      hand-off per account: a new stage marks the old one replaced. Rate limits: 30 per
 *      minute per address, 5 per minute per account. Answer `201 {handoff_id, expires_at}`.
 *      A staged entry is SPENT by any refused append: stage again.
 *   3. AUTHORISE (browser). The gateway answers "check your email" and an address
 *      `{AS}/recover?handoff&port&state`. The person MUST open the emailed link in the SAME
 *      browser, press its button (POST /api/devices/recovery/link sets the HttpOnly cookie
 *      `hap-recovery` (`__Host-hap-recovery` over https; the gateway never handles it), bound to that one handoff), and come back to the tab the address
 *      opened (it reloads itself every 15 seconds). Only that cookie authorises: no
 *      hap-session, API key or device token does. The page then shows the effect (the devices
 *      that will be removed, or "the recovery code is replaced") and the confirmation code. The
 *      button POSTs `/api/devices/recovery/authorize` (form: handoff, port, state, csrf).
 *      Refusals the person can fix are HTML pages and are not redirected (401
 *      EMAIL_LINK_SESSION_REQUIRED, 403 HANDOFF_OTHER); CSRF_INVALID, CROSS_SITE and a
 *      port or state that is not the staged one are JSON. Later refusals redirect with
 *      `?error=<CODE>&state=<s>`: HANDOFF_EXPIRED, HANDOFF_USED, CHAIN_HEAD_MOVED and hap-core
 *      codes such as NOT_AUTHORISED, plus ACCOUNT_SUSPENDED. Success is a plain 302 to
 *      `http://127.0.0.1:<stored port>/recover/callback?code=<one-time>&state=<s>`. The append
 *      also closes an open request for a new identity of the account.
 *   4. REDEEM. The gateway sends the one-time code and its PKCE verifier over its own HTTPS
 *      connection, no cookie. Answer: the head the append made and the entry hash. Any attempt
 *      uses the code up; it lives 60 seconds after the append.
 *   5. VERIFY. The gateway signs in and fetches the chain by device session, verifies it with
 *      hap-core, checks that its own entry is in it at that place, and only then stores it.
 *      It believes neither the redirect nor the redeem answer on their own.
 *
 * The 6-digit confirmation code is a CONSISTENCY CHECK, NOT A SECURITY CONTROL: whoever builds an
 * entry can grind six digits. The single-use emailed link, the notices to every device and the
 * email, and the root key itself are what protect the account.
 *
 * Stage: a bad signature or an unknown root DID answers 404 NO_CHAIN, and no head is returned before the signature
 * verifies. ROOT_KEY_TAKEN (409, stage and chain): "this recovery code is already in use; make another" (a
 * rotate-root to a root key another account holds). ROOT_ENTRY_VIA_HANDOFF: `POST /api/devices/chain` refuses
 * EVERY root-signed entry; the gateway never sends one there (its only POST to that route is a first-device `genesis`).
 *
 * Refusal codes beyond the ones above: LINK_INVALID 410 (link used, expired or replaced), MAIL_FAILED
 * 502 (stage: the email could not be sent), BAD_OP 400, PASSKEY_REQUIRED 400, NO_CHAIN 404 (stage:
 * unknown root DID or a suspended account), HANDOFF_UNKNOWN 404 / HANDOFF_USED 409 / HANDOFF_EXPIRED
 * 410 / PKCE_MISMATCH 403 (redeem).
 */

import { createHash } from 'node:crypto';

// ─── paths ───────────────────────────────────────────────────────────────────

export const RECOVERY_PATHS = {
  /** POST, no session. Body {@link RecoveryLookupRequest}. */
  lookup: '/api/devices/recovery/chain',
  /** POST, no session. Body {@link StageRequest}. */
  stage: '/api/devices/recovery/handoffs',
  /** POST, no session. Body {@link RedeemRequest}. */
  redeem: '/api/devices/recovery/redeem',
  /** The page the gateway's address opens: `/recover?handoff&port&state`. GET shows, never changes anything. */
  page: '/recover',
  /** The emailed link: `{AS}/recover/link?token=<single use>`; its button POSTs `/api/devices/recovery/link`. Not built by the gateway. */
  link: '/recover/link',
  /** The form post of that page (browser, email-link cookie, CSRF). Not called by the gateway. */
  authorize: '/api/devices/recovery/authorize',
  /** On the gateway: the loopback redirect. */
  callback: '/recover/callback',
} as const;

export const HANDOFF_TTL_SECONDS = 10 * 60;

// ─── 1. lookup ───────────────────────────────────────────────────────────────

export const LOOKUP_TYP = 'suveren-recovery-lookup';

/**
 * Signed by the root key (hap-core `signObject`, so the signed bytes are `utf8(JCS(object))`
 * with `typ` inside, rule 3 of plan section 2). The Authority Server accepts it only if:
 * `aud` is its own public key; `issued_at` is within 300 seconds of its clock; `root_pub`
 * is the root key IN FORCE at the head of some account's chain (after any `rotate-root`);
 * the signature verifies strictly. Anything else answers the same `404 NO_CHAIN`, so the
 * request does not tell anyone whether a key has a chain.
 */
export interface RecoveryLookup {
  typ: typeof LOOKUP_TYP;
  v: 1;
  /** The Authority Server's Ed25519 public key, hex, as `GET /api/as/pubkey` returns it. */
  aud: string;
  /** The root public key, 32 raw bytes, base64url. */
  root_pub: string;
  /** Epoch seconds. */
  issued_at: number;
}

export interface RecoveryLookupRequest { lookup: RecoveryLookup; sig: string }

/** `200`: the whole chain of the account whose root key in force is `root_pub`. Same shape as `GET /api/devices/chain`. */
export interface RecoveryLookupResponse {
  root_did: string;
  entries: unknown[];
  head: { seq: number; hash: string };
  /** Present only while a request for a new identity is open; never null. A reset or rotation closes it. */
  pending_identity_reset?: { id: string; effective_at: number };
}

// ─── 2. stage ────────────────────────────────────────────────────────────────

/**
 * `entry`: a chain entry, `signer: "root"`, `op` `reset` or `rotate-root` (the only two the
 * gateway makes). `code_challenge`: base64url SHA-256 of the PKCE verifier (S256 only).
 * `port`: the gateway's loopback port (1024 to 65535). `state_hash`: base64url SHA-256 of the
 * 32-byte state the gateway keeps. Both are fixed here; the redirect uses the stored port.
 */
export interface StageRequest { entry: unknown; code_challenge: string; port: number; state_hash: string }

/** `201`, after the email was sent. `expires_at`: epoch seconds, at most {@link HANDOFF_TTL_SECONDS} ahead. */
export interface StageResponse { handoff_id: string; expires_at: number }

// ─── 4. redeem ───────────────────────────────────────────────────────────────

export interface RedeemRequest { code: string; code_verifier: string }

/** `200`. `entry_hash` is the hash of the entry the append stored: the gateway compares it with its own. */
export interface RedeemResponse { head: { seq: number; hash: string }; entry_hash: string }

/** The refusal codes the gateway knows by name. Any other code is passed on as it is when it is code-shaped. */
export const RECOVERY_AS_CODES = [
  'NO_CHAIN', 'HANDOFF_EXPIRED', 'HANDOFF_USED', 'HANDOFF_UNKNOWN', 'HANDOFF_OTHER',
  'EMAIL_LINK_SESSION_REQUIRED', 'CROSS_SITE', 'CSRF_INVALID', 'CHAIN_HEAD_MOVED',
  'PKCE_MISMATCH', 'RATE_LIMITED', 'LINK_INVALID', 'MAIL_FAILED', 'BAD_OP', 'PASSKEY_REQUIRED',
  'ROOT_KEY_TAKEN', 'ROOT_ENTRY_VIA_HANDOFF', 'ACCOUNT_SUSPENDED',
] as const;

// ─── the confirmation code ───────────────────────────────────────────────────

/**
 * A six-digit code, computed from the entry hash by BOTH sides: the gateway page shows it,
 * and suveren.ai shows the one it computes from the staged entry. A CONSISTENCY CHECK, NOT A
 * SECURITY CONTROL: whoever builds an entry can grind the code in about a million tries. The
 * single-use emailed link, the notices and the root key are what protect the account.
 */
export function confirmCodeOf(entryHash: string): string {
  const d = createHash('sha256').update('suveren-recovery-confirm-v1\u0000', 'utf8').update(entryHash, 'ascii').digest();
  const n = d.readUInt32BE(0) % 1_000_000;
  return String(n).padStart(6, '0');
}

// ─── the browser address ─────────────────────────────────────────────────────

/** The address the person opens in the browser that will also open the emailed link. */
export function pageUrl(asUrl: string, p: { handoffId: string; port: number; state: string }): string {
  return `${asUrl}${RECOVERY_PATHS.page}?${new URLSearchParams({ handoff: p.handoffId, port: String(p.port), state: p.state }).toString()}`;
}

// ─── reading the Authority Server's answers (never believed unread) ─────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const HASH = /^sha256:[0-9a-f]{64}$/;
const HANDOFF_ID = /^[A-Za-z0-9_-]{16,128}$/;

export function readStageResponse(body: unknown, nowSeconds: number): StageResponse | null {
  if (!isObj(body) || typeof body.handoff_id !== 'string' || !HANDOFF_ID.test(body.handoff_id) || !isInt(body.expires_at)) return null;
  // A handoff that is already over, or that outlives the contract, is not one this gateway waits for.
  if (body.expires_at <= nowSeconds || body.expires_at > nowSeconds + HANDOFF_TTL_SECONDS + 60) return null;
  return { handoff_id: body.handoff_id, expires_at: body.expires_at };
}

export function readRedeemResponse(body: unknown): RedeemResponse | null {
  if (!isObj(body) || !isObj(body.head) || !isInt(body.head.seq) || typeof body.head.hash !== 'string' || !HASH.test(body.head.hash)) return null;
  if (typeof body.entry_hash !== 'string' || !HASH.test(body.entry_hash)) return null;
  return { head: { seq: body.head.seq, hash: body.head.hash }, entry_hash: body.entry_hash };
}

export function readLookupResponse(body: unknown): RecoveryLookupResponse | null {
  if (!isObj(body) || typeof body.root_did !== 'string' || !body.root_did.startsWith('did:key:') || !Array.isArray(body.entries) || body.entries.length === 0) return null;
  if (!isObj(body.head) || !isInt(body.head.seq) || typeof body.head.hash !== 'string' || !HASH.test(body.head.hash)) return null;
  let pending: RecoveryLookupResponse['pending_identity_reset'];
  if ('pending_identity_reset' in body) {
    const p = body.pending_identity_reset;
    // never null: a null or a member of another shape is not this contract's answer
    if (!isObj(p) || typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(p.id) || !isInt(p.effective_at)) return null;
    pending = { id: p.id, effective_at: p.effective_at };
  }
  return { root_did: body.root_did, entries: body.entries, head: { seq: body.head.seq, hash: body.head.hash }, ...(pending ? { pending_identity_reset: pending } : {}) };
}
