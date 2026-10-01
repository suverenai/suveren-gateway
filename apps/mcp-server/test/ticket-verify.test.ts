/**
 * verifyTicket — direct unit tests for every check it makes, using a REAL
 * Ed25519 keypair and real signed receipts (see helpers/real-receipt.ts).
 * Integration coverage of the same checks, wired into the automatic and
 * review paths, lives in tools.test.ts / commit-review-parity.test.ts /
 * committed-executor.test.ts / commit-cross-device-skip.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { AttestationCache, AsKeyMismatchError } from '../src/lib/attestation-cache';
import { SPClient } from '../src/lib/sp-client';
import { verifyTicket, TicketBindingMismatchError } from '../src/lib/ticket-verify';
import { testReceiptKeypair, makeSignedReceipt, signTestReceipt } from './helpers/real-receipt';

// AttestationCache.getPublicKey() needs an SPClient whose .url matches what
// it fetches from — construct one against a URL that will never actually be
// hit (getPublicKey is stubbed directly below).
function cacheWithKey(publicKeyHex: string): AttestationCache {
  const spClient = new SPClient('http://localhost:0');
  const cache = new AttestationCache(spClient);
  cache.getPublicKey = async () => publicKeyHex;
  return cache;
}

const BASE = {
  action: 'records__create_record',
  executionContext: { action_type: 'write' },
  authorizationId: 'authz_1',
  profileId: 'test-records@1',
};

describe('verifyTicket', () => {
  it('accepts a fully valid, matching, fresh ticket', async () => {
    const kp = testReceiptKeypair();
    const receipt = makeSignedReceipt(kp, { id: 'r1', ...BASE });
    await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, BASE)).resolves.toBeUndefined();
  });

  it('rejects a signature that does not verify against the pinned key', async () => {
    const kp = testReceiptKeypair();
    const otherKp = testReceiptKeypair();
    const receipt = makeSignedReceipt(kp, { id: 'r1', ...BASE });
    await expect(verifyTicket(cacheWithKey(otherKp.publicKeyHex), receipt, BASE))
      .rejects.toBeInstanceOf(AsKeyMismatchError);
  });

  it('rejects a receipt with no signature at all', async () => {
    const kp = testReceiptKeypair();
    await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), { id: 'r1', ...BASE }, BASE))
      .rejects.toBeInstanceOf(AsKeyMismatchError);
  });

  it('rejects an action mismatch', async () => {
    const kp = testReceiptKeypair();
    const receipt = makeSignedReceipt(kp, { id: 'r1', ...BASE, action: 'records__delete_record' });
    await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, BASE))
      .rejects.toBeInstanceOf(TicketBindingMismatchError);
  });

  it('rejects an executionContext mismatch', async () => {
    const kp = testReceiptKeypair();
    const receipt = makeSignedReceipt(kp, { id: 'r1', ...BASE, executionContext: { action_type: 'delete' } });
    await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, BASE))
      .rejects.toBeInstanceOf(TicketBindingMismatchError);
  });

  it('rejects an authorizationId mismatch', async () => {
    const kp = testReceiptKeypair();
    const receipt = makeSignedReceipt(kp, { id: 'r1', ...BASE, authorizationId: 'authz_other' });
    await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, BASE))
      .rejects.toBeInstanceOf(TicketBindingMismatchError);
  });

  it('rejects a profileId mismatch', async () => {
    const kp = testReceiptKeypair();
    const receipt = makeSignedReceipt(kp, { id: 'r1', ...BASE, profileId: 'other-profile@1' });
    await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, BASE))
      .rejects.toBeInstanceOf(TicketBindingMismatchError);
  });

  describe('proposalId (review path)', () => {
    it('rejects a receipt with no proposalId when one was expected', async () => {
      const kp = testReceiptKeypair();
      const receipt = makeSignedReceipt(kp, { id: 'r1', ...BASE }); // no proposalId
      await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, { ...BASE, proposalId: 'prop-1' }))
        .rejects.toBeInstanceOf(TicketBindingMismatchError);
    });

    it('rejects a receipt minted for a DIFFERENT proposal — the impostor-relay attack shape', async () => {
      const kp = testReceiptKeypair();
      const receipt = makeSignedReceipt(kp, { id: 'r1', ...BASE, proposalId: 'prop-genuine' });
      await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, { ...BASE, proposalId: 'prop-injected' }))
        .rejects.toBeInstanceOf(TicketBindingMismatchError);
    });

    it('accepts a matching proposalId', async () => {
      const kp = testReceiptKeypair();
      const receipt = makeSignedReceipt(kp, { id: 'r1', ...BASE, proposalId: 'prop-1' });
      await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, { ...BASE, proposalId: 'prop-1' }))
        .resolves.toBeUndefined();
    });
  });

  describe('contentHash / contentBinding', () => {
    const CONTENT_BINDING = { version: '1', kind: 'jcs' as const, fields: ['title', 'content'] };

    it('rejects a receipt whose contentHash does not match what this call computed', async () => {
      const kp = testReceiptKeypair();
      const receipt = makeSignedReceipt(kp, {
        id: 'r1', ...BASE, contentHash: 'sha256:aaaa', contentBinding: CONTENT_BINDING,
      });
      await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, {
        ...BASE, contentHash: 'sha256:bbbb', contentBinding: CONTENT_BINDING,
      })).rejects.toBeInstanceOf(TicketBindingMismatchError);
    });

    it('rejects a receipt with NO contentHash when this call expected one — a receipt that does not commit to the content is not evidence of it', async () => {
      const kp = testReceiptKeypair();
      const receipt = makeSignedReceipt(kp, { id: 'r1', ...BASE }); // no contentHash at all
      await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, {
        ...BASE, contentHash: 'sha256:bbbb', contentBinding: CONTENT_BINDING,
      })).rejects.toBeInstanceOf(TicketBindingMismatchError);
    });

    it('rejects a matching contentHash but a different contentBinding descriptor', async () => {
      const kp = testReceiptKeypair();
      const receipt = makeSignedReceipt(kp, {
        id: 'r1', ...BASE, contentHash: 'sha256:same', contentBinding: { version: '1', kind: 'text' },
      });
      await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, {
        ...BASE, contentHash: 'sha256:same', contentBinding: CONTENT_BINDING,
      })).rejects.toBeInstanceOf(TicketBindingMismatchError);
    });

    it('accepts a matching contentHash + contentBinding', async () => {
      const kp = testReceiptKeypair();
      const receipt = makeSignedReceipt(kp, {
        id: 'r1', ...BASE, contentHash: 'sha256:same', contentBinding: CONTENT_BINDING,
      });
      await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, {
        ...BASE, contentHash: 'sha256:same', contentBinding: CONTENT_BINDING,
      })).resolves.toBeUndefined();
    });

    it('is not checked at all for a profile that declares no binding (expected.contentHash undefined)', async () => {
      const kp = testReceiptKeypair();
      // Receipt happens to carry SOME contentHash (e.g. left over from a
      // differently-shaped request) — irrelevant when this call never
      // expected one at all.
      const receipt = makeSignedReceipt(kp, { id: 'r1', ...BASE, contentHash: 'sha256:whatever' });
      await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, BASE)).resolves.toBeUndefined();
    });
  });

  describe('idempotencyKey (G4 — binds the ticket to the request)', () => {
    it('accepts a receipt whose idempotencyKey matches what this call sent', async () => {
      const kp = testReceiptKeypair();
      const receipt = makeSignedReceipt(kp, { id: 'r1', ...BASE, idempotencyKey: 'idem-1' });
      await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, { ...BASE, idempotencyKey: 'idem-1' }))
        .resolves.toBeUndefined();
    });

    it('rejects a receipt whose idempotencyKey differs from what this call sent', async () => {
      const kp = testReceiptKeypair();
      const receipt = makeSignedReceipt(kp, { id: 'r1', ...BASE, idempotencyKey: 'idem-other' });
      await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, { ...BASE, idempotencyKey: 'idem-1' }))
        .rejects.toBeInstanceOf(TicketBindingMismatchError);
    });

    it('rejects a receipt with NO idempotencyKey when this call sent one — fail closed, missing counts as mismatch', async () => {
      const kp = testReceiptKeypair();
      const receipt = makeSignedReceipt(kp, { id: 'r1', ...BASE }); // no idempotencyKey at all
      await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, { ...BASE, idempotencyKey: 'idem-1' }))
        .rejects.toBeInstanceOf(TicketBindingMismatchError);
    });

    it('is not checked at all when this call sent no idempotencyKey (the review path — proposalId is its binding instead)', async () => {
      const kp = testReceiptKeypair();
      // Receipt happens to carry SOME idempotencyKey (e.g. left over from a
      // differently-shaped request) — irrelevant when this call never sent one.
      const receipt = makeSignedReceipt(kp, { id: 'r1', ...BASE, idempotencyKey: 'whatever' });
      await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, BASE)).resolves.toBeUndefined();
    });

    it('idempotent replay of the same key against the same ticket still passes', async () => {
      const kp = testReceiptKeypair();
      const receipt = makeSignedReceipt(kp, { id: 'r1', ...BASE, idempotencyKey: 'idem-1' });
      const expected = { ...BASE, idempotencyKey: 'idem-1' };
      // Call twice — exactly what a retried postReceipt + a retried
      // verifyTicket would look like when the AS replays the original
      // ticket for the same key. Nothing here is stateful, so both pass.
      await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, expected)).resolves.toBeUndefined();
      await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, expected)).resolves.toBeUndefined();
    });
  });

  describe('timestamp freshness', () => {
    it('rejects a ticket older than the freshness window', async () => {
      const kp = testReceiptKeypair();
      const receipt = signTestReceipt(
        { id: 'r1', ...BASE, timestamp: Math.floor(Date.now() / 1000) - 10 * 60 },
        kp.privateKey,
      );
      await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, BASE))
        .rejects.toBeInstanceOf(TicketBindingMismatchError);
    });

    it('rejects a ticket timestamped implausibly in the future', async () => {
      const kp = testReceiptKeypair();
      const receipt = signTestReceipt(
        { id: 'r1', ...BASE, timestamp: Math.floor(Date.now() / 1000) + 120 },
        kp.privateKey,
      );
      await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, BASE))
        .rejects.toBeInstanceOf(TicketBindingMismatchError);
    });

    it('rejects a ticket with no timestamp at all', async () => {
      const kp = testReceiptKeypair();
      const receipt = signTestReceipt({ id: 'r1', ...BASE }, kp.privateKey);
      await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, BASE))
        .rejects.toBeInstanceOf(TicketBindingMismatchError);
    });

    it('accepts a ticket within the clock-skew tolerance, slightly in the future', async () => {
      const kp = testReceiptKeypair();
      const receipt = signTestReceipt(
        { id: 'r1', ...BASE, timestamp: Math.floor(Date.now() / 1000) + 5 },
        kp.privateKey,
      );
      await expect(verifyTicket(cacheWithKey(kp.publicKeyHex), receipt, BASE)).resolves.toBeUndefined();
    });
  });
});
