/**
 * "Ask for changes" on the phone: the person's words, sealed for the computers that read them to the AI (device-keys option B, 2026-11-26).
 *
 * The note is the one place a person's text reaches the AI, so it never leaves the phone in the clear. It is sealed the way the gateway seals
 * a note (HPKE broadcast: one AES-256-GCM key for the text, that key wrapped for each reader; standard base64), to the reading key of every
 * ACTIVE gateway of the person's own chain, as this phone verified it. A wrap is labelled with the computer's device key id. The gateway
 * opens the one with its own id (control-plane `pickWrap`), with the same private key it opens everything else with. The Authority Server
 * only checks the shape (`validateNoteEncrypted`) and never sees the text.
 */
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes256Gcm } from '@hpke/core';
import { activeDevices, b64uDecode, type ChainState } from '@hap/core/device-keys';
import { own, toArrayBuffer } from './bytes';

export interface SealedNote { ciphertext: string; keys: Record<string, { ct: string; enc: string }> }

const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));

/** The computers that will read the note: active gateways of the chain, each with its reading key. */
export function noteReaders(chain: ChainState): Array<{ keyId: string; readPub: Uint8Array }> {
  const out: Array<{ keyId: string; readPub: Uint8Array }> = [];
  for (const d of activeDevices(chain)) {
    if (d.kind !== 'gateway' || typeof d.read_pub !== 'string') continue;
    try {
      const pub = b64uDecode(d.read_pub);
      if (pub.length === 32) out.push({ keyId: d.key_id, readPub: pub });
    } catch { /* a key that does not read is no reader */ }
  }
  return out;
}

/** Seal `text` for `readers`. Throws when there is no reader: a note nobody can open is never sent. */
export async function sealChangeNote(text: string, readers: Array<{ keyId: string; readPub: Uint8Array }>): Promise<SealedNote> {
  if (readers.length === 0) throw new Error('no_note_reader');
  const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
  const cek = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await crypto.subtle.importKey('raw', own(cek), { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: own(iv) }, aes, own(new TextEncoder().encode(text))));
  const blob = new Uint8Array(12 + body.length);
  blob.set(iv, 0);
  blob.set(body, 12);
  const keys: SealedNote['keys'] = {};
  for (const r of readers) {
    const ctx = await suite.createSenderContext({ recipientPublicKey: await suite.kem.deserializePublicKey(toArrayBuffer(r.readPub)) });
    keys[r.keyId] = { ct: b64(new Uint8Array(await ctx.seal(toArrayBuffer(cek)))), enc: b64(new Uint8Array(ctx.enc)) };
  }
  cek.fill(0);
  return { ciphertext: b64(blob), keys };
}
