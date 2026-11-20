/**
 * What the phone checks of a signed mandate and its profile before it offers a decision (device-keys plan 8, "Showing a proposal").
 *
 * The published hap-core's main entry imports Node's `crypto` and cannot load in a browser (plan step 2 names that as an open item), so the
 * four small rules the phone needs are written here again, from the browser-safe `@hap/core/device-keys` primitives, and
 * `mandate-check.test.ts` runs every one of them against hap-core's own function so the two cannot drift unseen:
 *
 *   - the mandate blob is base64url JSON `{ header, payload, signature }`; the signature is Ed25519 over the JCS of the payload
 *   - the signer is the Authority Server key the phone PINNED (`issuer` must be that key's `did:key`; the server's word about
 *     its own key decides nothing)
 *   - the profile hash is `"sha256:" + sha256(JCS(profile))`
 *   - the wire execution context holds only the fields a bound reads (`per_transaction`, `cumulative_sum`), no `_`-key, no null
 *
 * What is NOT here: the owner's grant of the mandate (4.4), which needs hap-core's mandate projection and so a browser-safe hap-core.
 * The gateway that runs the action checks it (step 13); the phone does not yet (hand-over: open question).
 */
import { b64uDecode, hexDecode, jcs, sha256Hash, utf8, utf8Decode, verifyEd25519 } from '@hap/core/device-keys';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** `did:key:z…` of an Ed25519 public key: multicodec 0xed01 + the key, base58btc (hap-core `encodeDidKey`). */
export function didKeyOf(publicKey: Uint8Array): string {
  const bytes = new Uint8Array(2 + publicKey.length);
  bytes[0] = 0xed;
  bytes[1] = 0x01;
  bytes.set(publicKey, 2);
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return `did:key:z${out}`;
}

/** The parts of a mandate payload the phone reads. */
export interface MandatePayloadView {
  mandate_id: string;
  version: string;
  profile_id: string;
  profile_hash: string;
  issuer: string;
  mandate_owners: Array<{ did: string }>;
  commitment_mode?: string;
  above_cap_approvers?: string[];
  issued_at: number;
  expires_at: number;
}

export type MandateCode = 'mandate_invalid' | 'mandate_signature' | 'mandate_expired';
export type MandateVerdict = { ok: true; payload: MandatePayloadView } | { ok: false; code: MandateCode };

/** hap-core `CLOCK_SKEW_SECONDS`: a mandate lives to `expires_at` plus this. */
export const CLOCK_SKEW_SECONDS = 300;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Decode, check the signer against the pinned key and the signature, and the time. Never throws. */
export async function verifyMandateBlob(blob: string, pinnedKeyHex: string, now: number): Promise<MandateVerdict> {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(blob) || !/^[0-9a-f]{64}$/.test(pinnedKeyHex)) return { ok: false, code: 'mandate_invalid' };
    const m: unknown = JSON.parse(utf8Decode(b64uDecode(blob)));
    if (!isObj(m) || !isObj(m.header) || !isObj(m.payload) || typeof m.signature !== 'string') return { ok: false, code: 'mandate_invalid' };
    const p = m.payload;
    const owners = p.mandate_owners;
    if (!str(p.mandate_id) || !str(p.version) || !str(p.profile_id) || !str(p.profile_hash) || !str(p.issuer)
      || !Array.isArray(owners) || owners.length !== 1 || !isObj(owners[0]) || !str(owners[0].did)
      || typeof p.issued_at !== 'number' || typeof p.expires_at !== 'number') return { ok: false, code: 'mandate_invalid' };
    const key = hexDecode(pinnedKeyHex);
    // The signer is the key this phone pinned, whatever the mandate says about itself.
    if (p.issuer !== didKeyOf(key)) return { ok: false, code: 'mandate_signature' };
    if (m.header.kid !== undefined && m.header.kid !== p.issuer.slice('did:key:'.length)) return { ok: false, code: 'mandate_signature' };
    if (!(await verifyEd25519(key, utf8(jcs(p)), b64uDecode(m.signature)))) return { ok: false, code: 'mandate_signature' };
    if (now > p.expires_at + CLOCK_SKEW_SECONDS) return { ok: false, code: 'mandate_expired' };
    return { ok: true, payload: p as unknown as MandatePayloadView };
  } catch {
    return { ok: false, code: 'mandate_invalid' };
  }
}

/** `profile_hash`: `"sha256:" + sha256(JCS(parsed profile))`. */
export function profileHashOf(profile: unknown): Promise<string> {
  return sha256Hash(utf8(jcs(profile)));
}

/** The execution-context fields some bound reads (hap-core `boundReadFields`). */
export function boundReadFields(profile: unknown): Set<string> {
  const out = new Set<string>();
  const fields = ((profile as { boundsSchema?: { fields?: Record<string, { boundType?: { kind?: string; of?: string } }> } } | null)?.boundsSchema?.fields) ?? {};
  for (const def of Object.values(fields)) {
    const bt = def?.boundType;
    if (bt && (bt.kind === 'per_transaction' || bt.kind === 'cumulative_sum') && typeof bt.of === 'string') out.add(bt.of);
  }
  return out;
}

/** hap-core `wireExecutionContext`: only what a bound reads travels; no `_`-key, no null. */
export function wireFilter(execution: Record<string, unknown>, profile: unknown): Record<string, unknown> {
  const allowed = boundReadFields(profile);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(execution)) {
    if (!allowed.has(k) || k.startsWith('_') || v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}
