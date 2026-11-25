/**
 * What the phone checks of a signed mandate and its profile before it offers a decision (device-keys plan 8, "Showing a proposal").
 *
 * Every rule is hap-core's own, from its browser-safe entry (`@hap/core/browser`, hap-core 0.17.0): nothing here re-implements one.
 *
 *   - `verifyMandate` with the Authority Server key the phone PINNED as the only trusted issuer: the blob's shape, the version, the
 *     signature over the JCS of the payload, a present `kid` naming the same key, the time (`expires_at` plus hap-core's skew), and
 *     exactly one owner. The server's word about its own key decides nothing.
 *   - `computeProfileHash`: `"sha256:" + sha256(JCS(profile))`.
 *   - `wireExecutionContext`: only the fields a bound reads, no `_`-key, no null.
 *
 * The owner's grant of the mandate (4.4) is checked in `grant-check.ts`, with hap-core's projection and `deviceKeys.verifyGrant`.
 */
import { verifyMandate, encodeDidKey, computeProfileHash, wireExecutionContext, type AgentProfile } from '@hap/core/browser';
import { hexDecode } from '@hap/core/device-keys';
import type { MandatePayload } from '@hap/core/browser';

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

/** `crypto_unavailable`: this browser has no WebCrypto, so nothing was checked either way (never read as a forged signature). */
export type MandateCode = 'mandate_invalid' | 'mandate_signature' | 'mandate_expired' | 'crypto_unavailable';
export type MandateVerdict = { ok: true; payload: MandatePayloadView; full: MandatePayload } | { ok: false; code: MandateCode };

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** `did:key:z…` of an Ed25519 public key (hap-core `encodeDidKey`). */
export function didKeyOf(publicKey: Uint8Array): string {
  return encodeDidKey(publicKey);
}

/** hap-core's mandate verification under the pinned key, and the fields the phone reads present. Never throws. */
export async function verifyMandateBlob(blob: string, pinnedKeyHex: string, now: number): Promise<MandateVerdict> {
  if (typeof blob !== 'string' || !/^[0-9a-f]{64}$/.test(pinnedKeyHex)) return { ok: false, code: 'mandate_invalid' };
  let p: MandatePayload;
  try {
    p = await verifyMandate(blob, { trustedIssuers: [encodeDidKey(hexDecode(pinnedKeyHex))], now });
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (code === 'CRYPTO_UNAVAILABLE') return { ok: false, code: 'crypto_unavailable' };
    if (code === 'INVALID_SIGNATURE') return { ok: false, code: 'mandate_signature' };
    if (code === 'TTL_EXPIRED') return { ok: false, code: 'mandate_expired' };
    return { ok: false, code: 'mandate_invalid' };
  }
  // hap-core verified it; what the phone then reads must be there (a verified payload without them names nothing to decide on).
  const v = p as unknown as Record<string, unknown>;
  if (!str(v.mandate_id) || !str(v.profile_id) || !str(v.profile_hash) || typeof v.issued_at !== 'number' || typeof v.expires_at !== 'number'
    || !str(p.mandate_owners?.[0]?.did)) return { ok: false, code: 'mandate_invalid' };
  return { ok: true, payload: p as unknown as MandatePayloadView, full: p };
}

/** `profile_hash` (hap-core `computeProfileHash`). Async for the callers that awaited the earlier WebCrypto version. */
export async function profileHashOf(profile: unknown): Promise<string> {
  return computeProfileHash(profile);
}

/** hap-core `wireExecutionContext`: only what a bound reads travels; no `_`-key, no null. */
export function wireFilter(execution: Record<string, unknown>, profile: unknown): Record<string, unknown> {
  return wireExecutionContext(execution, (profile ?? {}) as AgentProfile);
}
