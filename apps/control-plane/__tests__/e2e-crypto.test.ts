/**
 * e2e-crypto tests — HPKE broadcast pattern (P5.1)
 *
 * Covers:
 *   - generateKeyPair returns 32-byte X25519 keys
 *   - round-trip: single recipient can decrypt
 *   - multi-recipient: each recipient decrypts independently to the same plaintext
 *   - non-recipient cannot decrypt
 *   - intentHash is a stable 64-char hex SHA-256 digest
 */

import { describe, it, expect } from 'vitest';
import { computeIntentHash, computeIntentDisclosureHash } from '@hap/core';
import {
  generateKeyPair,
  encryptForRecipients,
  decryptIntent,
  intentHash,
} from '../src/lib/e2e-crypto';

// ─── generateKeyPair ─────────────────────────────────────────────────────────

describe('generateKeyPair', () => {
  it('returns 32-byte private and public keys', async () => {
    const kp = await generateKeyPair();
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey.length).toBe(32);
    expect(kp.publicKey.length).toBe(32);
  });

  it('each call returns a distinct key pair', async () => {
    const kp1 = await generateKeyPair();
    const kp2 = await generateKeyPair();
    // Extremely unlikely to collide; if it does the RNG is broken.
    expect(Buffer.from(kp1.privateKey).toString('hex')).not.toBe(
      Buffer.from(kp2.privateKey).toString('hex'),
    );
  });
});

// ─── round-trip: single recipient ────────────────────────────────────────────

describe('encryptForRecipients / decryptIntent — single recipient', () => {
  it('recipient can decrypt the intent', async () => {
    const kp = await generateKeyPair();
    const plaintext = 'Post 1-2x daily about the new workflow features.';

    const encrypted = await encryptForRecipients(plaintext, [
      { userId: 'alice', publicKey: kp.publicKey },
    ]);

    const decrypted = await decryptIntent(encrypted, 'alice', kp.privateKey);
    expect(decrypted).toBe(plaintext);
  });

  it('encryptedKeys contains an entry for the recipient', async () => {
    const kp = await generateKeyPair();
    const encrypted = await encryptForRecipients('hello', [
      { userId: 'alice', publicKey: kp.publicKey },
    ]);
    expect(encrypted.encryptedKeys['alice']).toBeDefined();
    expect(encrypted.encryptedKeys['alice'].ct).toBeInstanceOf(Uint8Array);
    expect(encrypted.encryptedKeys['alice'].enc).toBeInstanceOf(Uint8Array);
  });
});

// ─── multi-recipient ─────────────────────────────────────────────────────────

describe('encryptForRecipients — multi-recipient', () => {
  it('each recipient decrypts independently to the same plaintext', async () => {
    const [kpAlice, kpBob, kpCarol] = await Promise.all([
      generateKeyPair(),
      generateKeyPair(),
      generateKeyPair(),
    ]);
    const plaintext = 'Spring promo. Avoid hard sales language.';

    const encrypted = await encryptForRecipients(plaintext, [
      { userId: 'alice', publicKey: kpAlice.publicKey },
      { userId: 'bob', publicKey: kpBob.publicKey },
      { userId: 'carol', publicKey: kpCarol.publicKey },
    ]);

    const [ptAlice, ptBob, ptCarol] = await Promise.all([
      decryptIntent(encrypted, 'alice', kpAlice.privateKey),
      decryptIntent(encrypted, 'bob', kpBob.privateKey),
      decryptIntent(encrypted, 'carol', kpCarol.privateKey),
    ]);

    expect(ptAlice).toBe(plaintext);
    expect(ptBob).toBe(plaintext);
    expect(ptCarol).toBe(plaintext);
  });

  it('each recipient has a separate key wrap entry', async () => {
    const [kp1, kp2] = await Promise.all([generateKeyPair(), generateKeyPair()]);

    const encrypted = await encryptForRecipients('test', [
      { userId: 'u1', publicKey: kp1.publicKey },
      { userId: 'u2', publicKey: kp2.publicKey },
    ]);

    expect(Object.keys(encrypted.encryptedKeys)).toHaveLength(2);
    expect(encrypted.encryptedKeys['u1']).toBeDefined();
    expect(encrypted.encryptedKeys['u2']).toBeDefined();

    // Each wrap's enc (HPKE encapsulated key) must differ — they are independent HPKE seals.
    const enc1 = Buffer.from(encrypted.encryptedKeys['u1'].enc).toString('hex');
    const enc2 = Buffer.from(encrypted.encryptedKeys['u2'].enc).toString('hex');
    expect(enc1).not.toBe(enc2);
  });
});

// ─── non-recipient cannot decrypt ────────────────────────────────────────────

describe('decryptIntent — non-recipient', () => {
  it('throws when userId has no key wrap', async () => {
    const kp = await generateKeyPair();
    const encrypted = await encryptForRecipients('secret', [
      { userId: 'alice', publicKey: kp.publicKey },
    ]);

    await expect(
      decryptIntent(encrypted, 'mallory', kp.privateKey),
    ).rejects.toThrow('no key wrap found for userId "mallory"');
  });

  it('throws (HPKE open error) when a wrong private key is used', async () => {
    const kpAlice = await generateKeyPair();
    const kpMallory = await generateKeyPair();

    const encrypted = await encryptForRecipients('secret', [
      { userId: 'alice', publicKey: kpAlice.publicKey },
    ]);

    // Mallory's userId is injected into alice's wrap to force HPKE open failure.
    const tampered = {
      ...encrypted,
      encryptedKeys: {
        mallory: encrypted.encryptedKeys['alice'],
      },
    };

    await expect(
      decryptIntent(tampered, 'mallory', kpMallory.privateKey),
    ).rejects.toThrow();
  });
});

// ─── encryptForRecipients — edge cases ───────────────────────────────────────

describe('encryptForRecipients — edge cases', () => {
  it('throws when recipients array is empty', async () => {
    await expect(encryptForRecipients('hello', [])).rejects.toThrow(
      'recipients array must not be empty',
    );
  });
});

// ─── intentHash ──────────────────────────────────────────────────────────────

describe('intentHash', () => {
  it('returns a 64-character hex string', async () => {
    const h = await intentHash('my intent');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable — same input always produces the same hash', async () => {
    const h1 = await intentHash('consistent intent');
    const h2 = await intentHash('consistent intent');
    expect(h1).toBe(h2);
  });

  it('is different for different inputs', async () => {
    const h1 = await intentHash('intent A');
    const h2 = await intentHash('intent B');
    expect(h1).not.toBe(h2);
  });

  it('known SHA-256 value matches', async () => {
    // SHA-256 of empty string is known.
    const h = await intentHash('');
    expect(h).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

// ─── Full chain: encrypt → commitments → approver decrypt → re-derive ──────────
//
// Ties the REAL gateway crypto to the protocol commitments a verifier checks:
// a second approver (distinct keypair, as if on another machine) recovers the
// intent and reproduces both the signed gate_content_hashes.intent and the
// intent_disclosure_hash the AS binds. The AS-side relay + C2 binding are
// covered live in hap-e2e (team-approval); this closes the crypto end.
describe('intent-disclosure full chain (real HPKE + protocol commitments)', () => {
  it('approver decrypts and re-derives the signed intent + disclosure hashes', async () => {
    const intent = 'Refund the customer, up to €50. Do not touch other invoices.';
    const [kpAlice, kpBob] = await Promise.all([generateKeyPair(), generateKeyPair()]);
    const approvers = ['alice', 'bob'];

    // Attester encrypts for both approvers and computes the commitments.
    const encrypted = await encryptForRecipients(intent, [
      { userId: 'alice', publicKey: kpAlice.publicKey },
      { userId: 'bob', publicKey: kpBob.publicKey },
    ]);
    const ctB64 = Buffer.from(encrypted.intentCiphertext).toString('base64');
    const signedIntentHash = computeIntentHash(intent);                  // gate_content_hashes.intent
    const disclosureHash = computeIntentDisclosureHash(ctB64, approvers); // the AS binds this

    // Approver "bob" — only his private key — recovers the intent...
    const decrypted = await decryptIntent(encrypted, 'bob', kpBob.privateKey);
    expect(decrypted).toBe(intent);

    // ...and independently reproduces BOTH signed commitments.
    expect(computeIntentHash(decrypted)).toBe(signedIntentHash);
    expect(computeIntentDisclosureHash(ctB64, approvers)).toBe(disclosureHash);
  });

  it('a tampered ciphertext breaks the disclosure-hash binding (detected)', async () => {
    const kp = await generateKeyPair();
    const encrypted = await encryptForRecipients('original intent', [
      { userId: 'alice', publicKey: kp.publicKey },
    ]);
    const ctB64 = Buffer.from(encrypted.intentCiphertext).toString('base64');
    const good = computeIntentDisclosureHash(ctB64, ['alice']);
    const tamperedCt = ctB64.slice(0, -2) + (ctB64.endsWith('A') ? 'BB' : 'AA');
    expect(computeIntentDisclosureHash(tamperedCt, ['alice'])).not.toBe(good);
  });
});
