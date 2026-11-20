/**
 * A computer's change to a connector login, confirmed on the person's phone (device-keys plan section 7 "new confirmation for
 * sensitive changes", phone path; 20.4; DEC-29 as revised by DEC-44 and DEC-47; stage D3). ONE implementation of the formats and
 * the checks for both ends: the gateway's control plane (it builds, seals and signs the request, and verifies the answer before
 * it runs the change) and the phone app (it verifies the request before it shows it, and signs the answer).
 *
 * Under DEC-47 this path is used only by a computer WITHOUT its own check key; the gateway decides that.
 *
 *   view          what the phone shows, sealed: `{ typ: "suveren-change-request", v: 1, request, connector, fields, issued_at }`.
 *                 `request` is the gateway's change request (plan 7) `{ request_id, kind, name, change_hash, gateway_key_id,
 *                 expires_at }`; `fields` names what a replacement changes and carries a value only for a field the connector's
 *                 manifest declares `text` (never a secret, 20.4: "the old value and the new one, where the old one is not a secret").
 *   sealing       AES-256-GCM under a fresh 32-byte content key, IV (12) || ct || tag, associated data
 *                 "suveren-change-request" || 0x00 || request_id (a sealed view cannot be moved to another request). The content
 *                 key is HPKE-wrapped to each phone's reading key, exactly like proposal content (plan 5).
 *   envelope      the gateway's signed `suveren-gateway-envelope` (20.4) `{ typ, v, kind: "change-request", gateway_key_id,
 *                 chain_seq, chain_head, content_hash, issued_at }` with `content_hash` = objectHash(view). The phone refuses an
 *                 unsigned one, one whose signer is not an active gateway of the person's chain, and one whose hash does not
 *                 match what it opened.
 *   confirmation  the phone's signed answer `{ typ: "suveren-change-confirmation", v, root_did, key_id, chain_seq, chain_head,
 *                 request_id, change_hash, gateway_key_id, decision, confirmed_at }` (plan 7), signed with its device key under
 *                 section 2 (signObject), with its check (WebAuthn) over objectHash(confirmation) for an `allow`.
 *
 * The gateway accepts an answer only if (plan 7): it is exactly this shape; it names this gateway's own identity, request, change
 * hash and gateway key; `key_id` is an ACTIVE GRANTING device of the gateway's OWN verified chain (not the gateway itself); the head
 * check of 3.3 rule 3 passes; the signature verifies; for an allow, the check verifies under the device's check key in force at
 * `chain_seq`; and its time lies inside the request. The request is used once (the gateway's ChangeConfirmations).
 *
 * No error here carries a key, a value or a ciphertext.
 */
import {
  b64uBytes, b64uDecode, b64uEncode, checkKeyAt, checkNamedHead, concat, isActive, objectHash, signedBytes, utf8, utf8Decode,
  verifyCheck, verifyEd25519, type ChainState,
} from '@hap/core/device-keys';

export const CHANGE_VIEW_TYP = 'suveren-change-request';
export const GATEWAY_ENVELOPE_TYP = 'suveren-gateway-envelope';
export const CHANGE_CONFIRMATION_TYP = 'suveren-change-confirmation';
const AAD_LABEL = 'suveren-change-request';
/** How far a confirmation's time may run ahead of the verifier's clock, or before the request was made. */
export const CONFIRMATION_SKEW_SECONDS = 60;

export type ChangeKind = 'replace' | 'remove';

export interface ChangeRequestFields {
  request_id: string;
  kind: ChangeKind;
  /** The connector login the change is for (its id). */
  name: string;
  /** Hex SHA-256 of the canonical JSON of the exact change (the gateway's changeHash). */
  change_hash: string;
  gateway_key_id: string;
  /** Epoch seconds, the gateway's clock. */
  expires_at: number;
}

export interface ChangeField {
  key: string;
  /** The manifest's label for the field, when it has one. */
  label?: string;
  /** True for every field the manifest does not declare `text`: no value travels for it. */
  secret: boolean;
  /** Only for a `text` field. */
  old?: string;
  new?: string;
}

export interface ChangeView {
  typ: typeof CHANGE_VIEW_TYP;
  v: 1;
  request: ChangeRequestFields;
  /** The connector's display name, from the manifest. */
  connector: string;
  fields: ChangeField[];
  issued_at: number;
}

export interface GatewayEnvelope {
  typ: typeof GATEWAY_ENVELOPE_TYP;
  v: 1;
  kind: 'change-request';
  gateway_key_id: string;
  chain_seq: number;
  chain_head: string;
  content_hash: string;
  issued_at: number;
}

export type ChangeDecision = 'allow' | 'deny';

export interface ChangeConfirmation {
  typ: typeof CHANGE_CONFIRMATION_TYP;
  v: 1;
  root_did: string;
  key_id: string;
  chain_seq: number;
  chain_head: string;
  request_id: string;
  change_hash: string;
  gateway_key_id: string;
  decision: ChangeDecision;
  confirmed_at: number;
}

/** What went wrong, as a code. `chain_ahead`: the other side named a head this side has not seen yet; read the chain again. */
export type ChangeCheckCode =
  | 'malformed' | 'wrong_request' | 'wrong_root' | 'wrong_gateway' | 'not_a_gateway' | 'not_granting' | 'bad_signature'
  | 'bad_check' | 'check_required' | 'chain_fork' | 'chain_ahead' | 'content_mismatch' | 'unreadable' | 'expired' | 'bad_time';

export class ChangeCheckError extends Error {
  constructor(readonly code: ChangeCheckCode) {
    super(code);
    this.name = 'ChangeCheckError';
  }
}

function fail(code: ChangeCheckCode): never { throw new ChangeCheckError(code); }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isUint = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const KEY_ID = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{22}$/;
const B64U = /^[A-Za-z0-9_-]+$/;
const MAX_TEXT = 500;
const MAX_FIELDS = 40;

function exact(o: Record<string, unknown>, names: readonly string[]): void {
  const got = Object.keys(o).sort();
  const want = [...names].sort();
  if (got.length !== want.length || got.some((k, i) => k !== want[i])) fail('malformed');
}

const shortText = (v: unknown, max = MAX_TEXT): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\u0000');

export function validateRequestFields(o: unknown): ChangeRequestFields {
  if (!isObj(o)) return fail('malformed');
  exact(o, ['request_id', 'kind', 'name', 'change_hash', 'gateway_key_id', 'expires_at']);
  if (typeof o.request_id !== 'string' || !REQUEST_ID.test(o.request_id)) fail('malformed');
  if (o.kind !== 'replace' && o.kind !== 'remove') fail('malformed');
  if (!shortText(o.name, 128)) fail('malformed');
  if (typeof o.change_hash !== 'string' || !HEX64.test(o.change_hash)) fail('malformed');
  if (typeof o.gateway_key_id !== 'string' || !KEY_ID.test(o.gateway_key_id)) fail('malformed');
  if (!isUint(o.expires_at)) fail('malformed');
  return o as unknown as ChangeRequestFields;
}

export function validateView(o: unknown): ChangeView {
  if (!isObj(o)) return fail('malformed');
  exact(o, ['typ', 'v', 'request', 'connector', 'fields', 'issued_at']);
  if (o.typ !== CHANGE_VIEW_TYP || o.v !== 1) fail('malformed');
  validateRequestFields(o.request);
  if (!shortText(o.connector, 128)) fail('malformed');
  if (!isUint(o.issued_at)) fail('malformed');
  if (!Array.isArray(o.fields) || o.fields.length > MAX_FIELDS) fail('malformed');
  const seen = new Set<string>();
  for (const f of o.fields as unknown[]) {
    if (!isObj(f)) fail('malformed');
    const fo = f as Record<string, unknown>;
    const allowed = ['key', 'label', 'secret', 'old', 'new'];
    if (Object.keys(fo).some((k) => !allowed.includes(k))) fail('malformed');
    if (!shortText(fo.key, 128) || seen.has(fo.key as string)) fail('malformed');
    seen.add(fo.key as string);
    if (fo.label !== undefined && !shortText(fo.label, 128)) fail('malformed');
    if (typeof fo.secret !== 'boolean') fail('malformed');
    // A secret field never carries a value, in either direction.
    if (fo.secret && (fo.old !== undefined || fo.new !== undefined)) fail('malformed');
    if (fo.old !== undefined && (typeof fo.old !== 'string' || fo.old.length > MAX_TEXT)) fail('malformed');
    if (fo.new !== undefined && (typeof fo.new !== 'string' || fo.new.length > MAX_TEXT)) fail('malformed');
  }
  if ((o.request as ChangeRequestFields).kind === 'remove' && (o.fields as unknown[]).length > 0) fail('malformed');
  return o as unknown as ChangeView;
}

export function buildEnvelope(f: Omit<GatewayEnvelope, 'typ' | 'v' | 'kind'>): GatewayEnvelope {
  return { typ: GATEWAY_ENVELOPE_TYP, v: 1, kind: 'change-request', gateway_key_id: f.gateway_key_id, chain_seq: f.chain_seq, chain_head: f.chain_head, content_hash: f.content_hash, issued_at: f.issued_at };
}

export function validateEnvelope(o: unknown): GatewayEnvelope {
  if (!isObj(o)) return fail('malformed');
  exact(o, ['typ', 'v', 'kind', 'gateway_key_id', 'chain_seq', 'chain_head', 'content_hash', 'issued_at']);
  if (o.typ !== GATEWAY_ENVELOPE_TYP || o.v !== 1 || o.kind !== 'change-request') fail('malformed');
  if (typeof o.gateway_key_id !== 'string' || !KEY_ID.test(o.gateway_key_id)) fail('malformed');
  if (!isUint(o.chain_seq) || typeof o.chain_head !== 'string' || !HASH.test(o.chain_head)) fail('malformed');
  if (typeof o.content_hash !== 'string' || !HASH.test(o.content_hash)) fail('malformed');
  if (!isUint(o.issued_at)) fail('malformed');
  return o as unknown as GatewayEnvelope;
}

export function buildConfirmation(f: Omit<ChangeConfirmation, 'typ' | 'v'>): ChangeConfirmation {
  return {
    typ: CHANGE_CONFIRMATION_TYP, v: 1, root_did: f.root_did, key_id: f.key_id, chain_seq: f.chain_seq, chain_head: f.chain_head,
    request_id: f.request_id, change_hash: f.change_hash, gateway_key_id: f.gateway_key_id, decision: f.decision, confirmed_at: f.confirmed_at,
  };
}

export function validateConfirmation(o: unknown): ChangeConfirmation {
  if (!isObj(o)) return fail('malformed');
  exact(o, ['typ', 'v', 'root_did', 'key_id', 'chain_seq', 'chain_head', 'request_id', 'change_hash', 'gateway_key_id', 'decision', 'confirmed_at']);
  if (o.typ !== CHANGE_CONFIRMATION_TYP || o.v !== 1) fail('malformed');
  if (typeof o.root_did !== 'string' || !o.root_did.startsWith('did:key:') || o.root_did.length > 128) fail('malformed');
  if (typeof o.key_id !== 'string' || !KEY_ID.test(o.key_id)) fail('malformed');
  if (!isUint(o.chain_seq) || typeof o.chain_head !== 'string' || !HASH.test(o.chain_head)) fail('malformed');
  if (typeof o.request_id !== 'string' || !REQUEST_ID.test(o.request_id)) fail('malformed');
  if (typeof o.change_hash !== 'string' || !HEX64.test(o.change_hash)) fail('malformed');
  if (typeof o.gateway_key_id !== 'string' || !KEY_ID.test(o.gateway_key_id)) fail('malformed');
  if (o.decision !== 'allow' && o.decision !== 'deny') fail('malformed');
  if (!isUint(o.confirmed_at)) fail('malformed');
  return o as unknown as ChangeConfirmation;
}

// ─── sealing ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The associated data: "suveren-change-request" || 0x00 || request_id. */
export function changeAad(requestId: string): Uint8Array {
  return concat(utf8(AAD_LABEL), Uint8Array.of(0), utf8(requestId));
}

const own = (u: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(u);

async function aesKey(cek: Uint8Array, use: 'encrypt' | 'decrypt') {
  if (cek.length !== 32) throw new Error('content key has the wrong length');
  return globalThis.crypto.subtle.importKey('raw', own(cek), { name: 'AES-GCM', length: 256 }, false, [use]);
}

/** Seal a view under a content key: base64url(IV || ct || tag). The caller wraps the key to each phone. */
export async function sealView(view: ChangeView, cek: Uint8Array): Promise<string> {
  validateView(view);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: own(changeAad(view.request.request_id)) }, await aesKey(cek, 'encrypt'), own(utf8(JSON.stringify(view))),
  ));
  return b64uEncode(concat(iv, ct));
}

/** Open a sealed view for ONE request. Anything that does not open, or opens to something else, is `unreadable`. */
export async function openView(cek: Uint8Array, ciphertext: string, requestId: string): Promise<ChangeView> {
  let view: ChangeView;
  try {
    if (typeof ciphertext !== 'string' || !B64U.test(ciphertext)) throw new Error('shape');
    const bytes = b64uDecode(ciphertext);
    if (bytes.length < 12 + 16) throw new Error('short');
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: own(bytes.subarray(0, 12)), additionalData: own(changeAad(requestId)) }, await aesKey(cek, 'decrypt'), own(bytes.subarray(12)),
    );
    view = validateView(JSON.parse(utf8Decode(new Uint8Array(plain))));
  } catch {
    return fail('unreadable');
  }
  if (view.request.request_id !== requestId) fail('wrong_request');
  return view;
}

// ─── checks ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

function namedHead(chain: ChainState, seq: number, head: string): void {
  try {
    checkNamedHead(chain, seq, head);
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    fail(code === 'CHAIN_AHEAD' ? 'chain_ahead' : 'chain_fork');
  }
}

async function sigOk(signPub: string, obj: object, sig: unknown): Promise<boolean> {
  if (typeof sig !== 'string' || !B64U.test(sig) || sig.length > 128) return false;
  try {
    return await verifyEd25519(b64uBytes(signPub, 32, 'sign_pub'), signedBytes(obj), b64uBytes(sig, 64, 'sig'));
  } catch {
    return false;
  }
}

/**
 * The phone's check of a request before it shows it (20.4). Returns the label of the computer that asks. `now` in epoch seconds.
 */
export async function verifyRequest(r: { requestId: string; envelope: unknown; senderSig: unknown; view: ChangeView }, ctx: { chain: ChainState; now: number }): Promise<{ gatewayLabel: string; envelope: GatewayEnvelope }> {
  const env = validateEnvelope(r.envelope);
  const gw = ctx.chain.devices[env.gateway_key_id];
  if (!gw || !isActive(ctx.chain, env.gateway_key_id) || gw.kind !== 'gateway') fail('not_a_gateway');
  if (!(await sigOk(gw.sign_pub, env, r.senderSig))) fail('bad_signature');
  namedHead(ctx.chain, env.chain_seq, env.chain_head);
  if ((await objectHash(r.view)) !== env.content_hash) fail('content_mismatch');
  if (r.view.request.request_id !== r.requestId) fail('wrong_request');
  if (r.view.request.gateway_key_id !== env.gateway_key_id) fail('wrong_gateway');
  if (r.view.request.expires_at <= ctx.now) fail('expired');
  return { gatewayLabel: gw.label, envelope: env };
}

export interface AnswerExpectation {
  rootDid: string;
  requestId: string;
  changeHash: string;
  gatewayKeyId: string;
  /** Epoch seconds: when the request was made, and when it runs out. */
  createdAt: number;
  expiresAt: number;
}

/**
 * The gateway's check of an answer, against its OWN verified chain (plan 7). Returns the confirmation; a `deny` verifies the same
 * way (its signature), without a check. `now` in epoch seconds.
 */
export async function verifyAnswer(a: { confirmation: unknown; sig: unknown; check?: unknown }, ctx: { chain: ChainState; expect: AnswerExpectation; now: number }): Promise<ChangeConfirmation> {
  const c = validateConfirmation(a.confirmation);
  const x = ctx.expect;
  if (c.root_did !== x.rootDid || c.root_did !== ctx.chain.root_did) fail('wrong_root');
  if (c.request_id !== x.requestId || c.change_hash !== x.changeHash) fail('wrong_request');
  if (c.gateway_key_id !== x.gatewayKeyId) fail('wrong_gateway');
  namedHead(ctx.chain, c.chain_seq, c.chain_head);
  const dev = ctx.chain.devices[c.key_id];
  // An active granting device of this chain, and not the asking computer itself.
  if (!dev || c.key_id === x.gatewayKeyId || !isActive(ctx.chain, c.key_id) || !dev.check) fail('not_granting');
  if (!(await sigOk(dev!.sign_pub, c, a.sig))) fail('bad_signature');
  if (c.decision === 'allow') {
    if (a.check === undefined) fail('check_required');
    const key = checkKeyAt(ctx.chain, c.key_id, c.chain_seq);
    if (!key || !(await verifyCheck(key, await objectHash(c), a.check))) fail('bad_check');
  }
  if (c.confirmed_at > ctx.now + CONFIRMATION_SKEW_SECONDS || c.confirmed_at < x.createdAt - CONFIRMATION_SKEW_SECONDS) fail('bad_time');
  if (ctx.now >= x.expiresAt) fail('expired');
  return c;
}
