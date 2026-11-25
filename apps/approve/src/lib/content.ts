/**
 * Opening a proposal's sealed content on this phone (device-keys plan 5; v0.8 *Proposals* rules 3 and 8).
 *
 *   wrap      this phone's own entry of `content.device_keys` (the Authority Server serves a device session ONLY its own,
 *             plan 5 "Wire shape"); the phone holds no wrap by DID or by account id
 *   content   AES-256-GCM, `ciphertext` = IV (12) || ct || tag, no associated data, under the content key the wrap opens
 *   check     the fingerprint over JCS(arguments) must equal `proposalContentHash`; a mismatch is never shown (rule 8)
 *   context   a second ciphertext under HKDF(content key, info "suveren-context"), associated data
 *             "context" || 0x00 || fingerprint, so it cannot be moved to another proposal
 *
 * The content key and the plaintext live in memory for the call and are dropped; nothing here writes to IndexedDB or any cache
 * (plan 8: "The app never writes decrypted content to IndexedDB or the service-worker cache"). No error text carries content.
 */
import { b64uDecode, hkdfSha256, jcs, sha256Hash, utf8, utf8Decode, concat } from '@hap/core/device-keys';
import type { DeviceKeyStore } from './key-store';
import { own } from './bytes';

export type Wrap = { ct: string; enc: string };

/** The parts of a proposal's `content` this module reads (what the card passes to the host). */
export interface ContentWire {
  ciphertext: string;
  device_keys?: Record<string, Wrap>;
  context?: string;
  hash?: string;
  proposalContentHash?: string;
}

export class NoWrapError extends Error {
  readonly code = 'no_wrap_for_this_device';
  constructor() {
    super('No key wrap for this device in this content.');
    this.name = 'NoWrapError';
  }
}

/** The content opened, but is not the content its fingerprint names (rule 8). Never shown; a decision on it is never offered. */
export class ContentMismatchError extends Error {
  readonly code = 'content_mismatch';
  constructor() {
    super('Decrypted proposal content does not match its fingerprint.');
    this.name = 'ContentMismatchError';
  }
}

const STRICT_B64URL = /^[A-Za-z0-9_-]+$/;
export const CONTEXT_INFO = 'suveren-context';

/** This phone's wrap: its own key id's entry, else the single entry a device session is served. Never a guess among several. */
export function pickWrap(wire: ContentWire, ownKeyId: string): Wrap | undefined {
  const dev = wire.device_keys;
  if (!dev || typeof dev !== 'object') return undefined;
  const mine = dev[ownKeyId];
  if (mine) return mine;
  const all = Object.values(dev);
  return all.length === 1 ? all[0] : undefined;
}

function fingerprintOf(wire: ContentWire): string | undefined {
  return wire.proposalContentHash ?? wire.hash;
}

/** `ciphertext` = IV (12) || sealed; AES-256-GCM with the content key. */
async function aesOpen(cek: Uint8Array, bytes: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 12 + 16) throw new Error('short');
  const key = await globalThis.crypto.subtle.importKey('raw', own(cek), { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const params: AesGcmParams = { name: 'AES-GCM', iv: own(bytes.subarray(0, 12)), ...(aad ? { additionalData: own(aad) } : {}) };
  return new Uint8Array(await globalThis.crypto.subtle.decrypt(params, key, own(bytes.subarray(12))));
}

/**
 * Open the content. Throws {@link NoWrapError} when this phone holds no wrap (a device added after the proposal was made holds
 * none until another device of the person passes it on, plan 5 "Re-wrap"), and an `Error` for anything that does not open or
 * does not match its fingerprint: the card then says it cannot be shown, never shows part of it.
 */
export async function openContent(wire: ContentWire, ownKeyId: string, keys: DeviceKeyStore): Promise<{ plaintext: string; fingerprint: string }> {
  const wrap = pickWrap(wire, ownKeyId);
  if (!wrap) throw new NoWrapError();
  const fingerprint = fingerprintOf(wire);
  if (!fingerprint || ![wire.ciphertext, wrap.ct, wrap.enc].every((x) => typeof x === 'string' && STRICT_B64URL.test(x))) {
    throw new Error('This content could not be opened on this device.');
  }
  let cek: Uint8Array | null = null;
  try {
    cek = await keys.openContentKey(wrap);
    const plaintext = utf8Decode(await aesOpen(cek, b64uDecode(wire.ciphertext)));
    let args: unknown;
    try { args = JSON.parse(plaintext); } catch { throw new Error('not JSON'); }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('not an object');
    // Rule 8: never show content whose fingerprint does not match.
    if ((await sha256Hash(utf8(jcs(args)))) !== fingerprint) throw new ContentMismatchError();
    return { plaintext, fingerprint };
  } catch (e) {
    if (e instanceof NoWrapError || e instanceof ContentMismatchError) throw e;
    throw new Error('This content could not be opened on this device.');
  } finally {
    cek?.fill(0);
  }
}

/** What the card needs beyond the arguments: the gateway's own data, never the AI's text (plan 5). */
export interface CardContext {
  display: unknown;
  execution_mapping: unknown;
  linked_record: unknown;
  gateway_version: string;
}

export type ContextResult = { context: CardContext } | { contextError: 'context_unreadable' } | null;

/**
 * Open the card context of ONE proposal. A context sealed for another proposal (its fingerprint is in the associated data), a
 * tampered one, one under another key and one that is not a context object all fail the same way; the card is then shown with
 * the arguments only. Null: the proposal carries no context.
 */
export async function openContext(wire: ContentWire, ownKeyId: string, keys: DeviceKeyStore): Promise<ContextResult> {
  if (wire.context === undefined) return null;
  const wrap = pickWrap(wire, ownKeyId);
  const fingerprint = fingerprintOf(wire);
  if (!wrap || !fingerprint || typeof wire.context !== 'string' || !STRICT_B64URL.test(wire.context) || !STRICT_B64URL.test(wrap.ct) || !STRICT_B64URL.test(wrap.enc)) {
    return { contextError: 'context_unreadable' };
  }
  let cek: Uint8Array | null = null;
  try {
    cek = await keys.openContentKey(wrap);
    const ctxKey = await hkdfSha256(cek, '', CONTEXT_INFO, 32);
    const plain = await aesOpen(ctxKey, b64uDecode(wire.context), concat(utf8('context'), Uint8Array.of(0), utf8(fingerprint)));
    ctxKey.fill(0);
    const obj = JSON.parse(utf8Decode(plain)) as Record<string, unknown>;
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj) || typeof obj.gateway_version !== 'string') return { contextError: 'context_unreadable' };
    return { context: obj as unknown as CardContext };
  } catch {
    return { contextError: 'context_unreadable' };
  } finally {
    cek?.fill(0);
  }
}

/**
 * Open a sealed mandate body or a give prepared for this phone (plan 4.4 "Transport"): the same AES-256-GCM sealing as proposal
 * content, under this phone's own wrap. A body carries no fingerprint: what the phone shows is bound by the hashes it recomputes from
 * the plaintext and signs (mandate-give.ts). Throws {@link NoWrapError} without a wrap, an `Error` for anything that does not open as an
 * object; no error text carries content, and nothing is stored.
 */
export async function openSealedObject(ciphertext: unknown, wrap: unknown, keys: DeviceKeyStore): Promise<Record<string, unknown>> {
  const w = wrap as Partial<Wrap> | null | undefined;
  if (!w || typeof w !== 'object') throw new NoWrapError();
  if (typeof ciphertext !== 'string' || ![ciphertext, w.ct, w.enc].every((x) => typeof x === 'string' && STRICT_B64URL.test(x))) {
    throw new Error('This content could not be opened on this device.');
  }
  let cek: Uint8Array | null = null;
  try {
    cek = await keys.openContentKey({ ct: w.ct as string, enc: w.enc as string });
    const obj = JSON.parse(utf8Decode(await aesOpen(cek, b64uDecode(ciphertext)))) as unknown;
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new Error('not an object');
    return obj as Record<string, unknown>;
  } catch {
    throw new Error('This content could not be opened on this device.');
  } finally {
    cek?.fill(0);
  }
}
