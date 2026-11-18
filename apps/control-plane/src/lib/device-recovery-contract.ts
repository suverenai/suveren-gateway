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
 * The flow, end to end:
 *
 *   1. LOOKUP (fresh gateway only). The gateway derives the root key from the typed code and
 *      asks for the chain with a request signed by that root key: possession of the code is
 *      the authorisation, the code itself never travels. No session. Answer: the chain.
 *      The gateway verifies it with hap-core from the genesis on and refuses it unless the
 *      root key in force at its head is the key the code derives.
 *   2. STAGE. The gateway builds the entry, signs it (root key, this computer's key, this
 *      computer's check where it has one) and posts it with the PKCE challenge. No session:
 *      the entry carries its own proof, and the Authority Server verifies it exactly as it
 *      would on `POST /api/devices/chain`, against the current head, but appends nothing.
 *      Answer: a handoff id.
 *   3. AUTHORISE (browser). The gateway opens the person's SYSTEM BROWSER on
 *      `{AS}/recover?handoff=<id>&port=<n>&state=<s>`. suveren.ai shows what the entry will
 *      do (taken from the staged entry, never from the URL) and the confirmation code
 *      (below). With the browser's own email-link session, a form POST with a CSRF token,
 *      same-origin only, a GET never authorises, the Authority Server appends the staged
 *      entry as `appendEntry(entry, { emailLink: { userId } })` and redirects (plain 302)
 *      to `http://127.0.0.1:<port>/recover/callback?code=<one-time>&state=<s>`. The redirect is
 *      built from a port number only. The cookie never leaves the browser.
 *   4. REDEEM. The gateway sends the one-time code and its PKCE verifier over its own HTTPS
 *      connection, no cookie. Answer: the head the append made.
 *   5. VERIFY. The gateway signs in and fetches the chain by device session, verifies it with
 *      hap-core, checks that its own entry is in it at that place, and only then stores it.
 *      It believes neither the redirect nor the redeem answer on their own.
 *
 * What the Authority Server must refuse in 3, each with its own code:
 *   - no email-link session of the account the entry belongs to       401 EMAIL_LINK_SESSION_REQUIRED
 *   - a session of another account than the staged entry's            403 HANDOFF_OTHER_ACCOUNT
 *   - a cross-site post (Origin / Sec-Fetch-Site)                      403 CROSS_SITE
 *   - a missing or wrong CSRF token                                    403 CSRF_INVALID
 *   - an expired, used or unknown handoff                              409/410 HANDOFF_EXPIRED | HANDOFF_USED | HANDOFF_UNKNOWN
 *   - the chain moved since the entry was built                        409 CHAIN_HEAD_MOVED (and the entry's own refusals)
 * A refusal that the browser can redirect (it has a valid `port` and `state`) is redirected
 * with `?error=<CODE>&state=<s>` instead of `code`, so the gateway can say what happened.
 *
 * Open on the Authority Server side, for its owner to decide (not decided here): whether
 * the staged entry may be used once only (this contract says once), and how long a handoff
 * lives (this contract says 10 minutes, the code of step 3 lives 60 seconds).
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
  /** The page on suveren.ai the system browser opens. GET shows, never changes anything. */
  page: '/recover',
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
}

// ─── 2. stage ────────────────────────────────────────────────────────────────

/**
 * `entry`: a chain entry, `signer: "root"`, `op` `reset` or `rotate-root` (the only two the
 * gateway makes). `code_challenge`: base64url SHA-256 of the PKCE verifier (S256 only).
 */
export interface StageRequest { entry: unknown; code_challenge: string }

/** `201`. `expires_at`: epoch seconds, at most {@link HANDOFF_TTL_SECONDS} ahead. */
export interface StageResponse { handoff_id: string; expires_at: number }

// ─── 4. redeem ───────────────────────────────────────────────────────────────

export interface RedeemRequest { code: string; code_verifier: string }

/** `200`. `entry_hash` is the hash of the entry the append stored: the gateway compares it with its own. */
export interface RedeemResponse { head: { seq: number; hash: string }; entry_hash: string }

/** The refusal codes the gateway knows by name. Any other code is passed on as it is when it is code-shaped. */
export const RECOVERY_AS_CODES = [
  'NO_CHAIN', 'HANDOFF_EXPIRED', 'HANDOFF_USED', 'HANDOFF_UNKNOWN', 'HANDOFF_OTHER_ACCOUNT',
  'EMAIL_LINK_SESSION_REQUIRED', 'CROSS_SITE', 'CSRF_INVALID', 'CHAIN_HEAD_MOVED',
  'PKCE_MISMATCH', 'RATE_LIMITED',
] as const;

// ─── the confirmation code ───────────────────────────────────────────────────

/**
 * A six-digit code, computed from the entry hash by BOTH sides: the gateway page shows it,
 * and suveren.ai shows the one it computes from the staged entry. The person compares them
 * before pressing the button on suveren.ai. It stops the one thing the hand-off could
 * otherwise be used for: someone who holds the recovery code (but not the email account)
 * sends the person a link to a staged entry of their own, and the person presses the
 * button with an email-link session of their own browser. That person's gateway shows no
 * matching code, because it staged nothing.
 */
export function confirmCodeOf(entryHash: string): string {
  const d = createHash('sha256').update('suveren-recovery-confirm-v1\u0000', 'utf8').update(entryHash, 'ascii').digest();
  const n = d.readUInt32BE(0) % 1_000_000;
  return String(n).padStart(6, '0');
}

// ─── the browser address ─────────────────────────────────────────────────────

export function authorizeUrl(asUrl: string, p: { handoffId: string; port: number; state: string }): string {
  const q = new URLSearchParams({ handoff: p.handoffId, port: String(p.port), state: p.state });
  return `${asUrl}${RECOVERY_PATHS.page}?${q.toString()}`;
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
  return { root_did: body.root_did, entries: body.entries, head: { seq: body.head.seq, hash: body.head.hash } };
}
