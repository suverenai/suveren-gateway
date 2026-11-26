/**
 * "Ask for changes" on the phone: the note is sealed here and opened by the gateway's own reader (control-plane `decryptProposalContent`),
 * so the two cannot drift. The Authority Server's shape check (`validateNoteEncrypted`: ciphertext and keys of { ct, enc }) is mirrored.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '../../../control-plane/src/lib/e2e-crypto';
import { decryptProposalContent } from '../../../control-plane/src/lib/content-crypto';
import { noteReaders, sealChangeNote } from './change-note';
import { b64uEncode } from '@hap/core/device-keys';
import type { ChainState } from '@hap/core/device-keys';

const chainWith = (devices: Array<{ id: string; kind: 'gateway' | 'approve-app'; pub: Uint8Array; removed?: boolean }>): ChainState => ({
  devices: Object.fromEntries(devices.map((d) => [d.id, { key_id: d.id, kind: d.kind, label: d.id, read_pub: b64uEncode(d.pub), sign_pub: '', removed_seq: d.removed ? 3 : null }])),
  head: { seq: 5, hash: 'h' }, root_did: 'did:key:root',
} as unknown as ChainState);

describe('a change note sealed on the phone', () => {
  it('the gateway opens it with its own key id, and nobody else can', async () => {
    const gw = await generateKeyPair();
    const other = await generateKeyPair();
    const readers = noteReaders(chainWith([
      { id: 'key-gateway-1', kind: 'gateway', pub: gw.publicKey },
      { id: 'key-phone-1', kind: 'approve-app', pub: other.publicKey },
      { id: 'key-gateway-old', kind: 'gateway', pub: other.publicKey, removed: true },
    ]));
    expect(readers.map((r) => r.keyId)).toEqual(['key-gateway-1']); // active gateways only
    const text = 'Use the reply address, not the old one. Keep it short.';
    const sealed = await sealChangeNote(text, readers);
    expect(Object.keys(sealed.keys)).toEqual(['key-gateway-1']);
    expect(sealed.ciphertext).not.toContain('reply');
    // the Authority Server's shape check
    expect(typeof sealed.ciphertext).toBe('string');
    for (const w of Object.values(sealed.keys)) { expect(typeof w.ct).toBe('string'); expect(typeof w.enc).toBe('string'); }
    expect(await decryptProposalContent(sealed, 'user-1', gw.privateKey, 'did:key:root', 'key-gateway-1')).toBe(text);
    await expect(decryptProposalContent(sealed, 'user-1', other.privateKey, 'did:key:root', 'key-gateway-1')).rejects.toThrow();
    await expect(decryptProposalContent(sealed, 'user-1', gw.privateKey, 'did:key:root', 'key-gateway-2')).rejects.toThrow(/No key wrap/);
  });

  it('with no gateway to read it, nothing is sealed', async () => {
    expect(noteReaders(chainWith([{ id: 'p', kind: 'approve-app', pub: new Uint8Array(32) }]))).toEqual([]);
    await expect(sealChangeNote('x', [])).rejects.toThrow('no_note_reader');
  });
});
