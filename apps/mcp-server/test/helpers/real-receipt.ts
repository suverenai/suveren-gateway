/**
 * A REAL, verifiably-signed receipt for tests — since ticket-verify.ts now
 * requires every receipt to carry a signature that verifies against the
 * pinned Authority Server key before the gateway will act on it, a bare
 * `{ id: 'r1' }` mock no longer exercises the code path it used to.
 *
 * Uses Node's own `crypto.generateKeyPairSync('ed25519')` /
 * `crypto.sign(null, …)` — the same RFC 8032 Ed25519 scheme hap-core's
 * `verifyTicketSignature` checks against (via @noble/ed25519), so a
 * signature made here verifies for real. No mocking of the verification
 * itself — only the Authority Server's HTTP call is a test double.
 *
 * v0.7: `verifyTicketSignature` resolves the verification key from the
 * ticket's own `issuer` did:key (never from a key supplied alongside it),
 * so every test receipt now carries one matching its keypair.
 */
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { canonicalize, encodeDidKey } from '@hap/core';

export interface TestReceiptKeypair {
  privateKey: KeyObject;
  /** Raw 32-byte Ed25519 seed — what hap-core's signMandate/signTicket (via
   *  @noble/ed25519) take directly, for fixtures that sign through hap-core
   *  itself rather than hand-rolling node:crypto signing. */
  privateKeyRaw: Uint8Array;
  publicKeyHex: string;
  issuer: string;
}

export function testReceiptKeypair(): TestReceiptKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = (publicKey.export({ format: 'jwk' }) as { x?: string }).x;
  if (!raw) throw new Error('test setup: could not extract raw Ed25519 public key');
  const rawPrivate = (privateKey.export({ format: 'jwk' }) as { d?: string }).d;
  if (!rawPrivate) throw new Error('test setup: could not extract raw Ed25519 private key');
  const rawBytes = Buffer.from(raw, 'base64url');
  return {
    privateKey,
    privateKeyRaw: new Uint8Array(Buffer.from(rawPrivate, 'base64url')),
    publicKeyHex: rawBytes.toString('hex'),
    issuer: encodeDidKey(rawBytes),
  };
}

/** Sign an arbitrary receipt-shaped payload (no `signature` field yet). */
export function signTestReceipt(
  payload: Record<string, unknown>,
  privateKey: KeyObject,
): Record<string, unknown> {
  const bytes = Buffer.from(canonicalize(payload), 'utf-8');
  const signature = cryptoSign(null, bytes, privateKey).toString('base64url');
  return { ...payload, signature };
}

/**
 * A complete, minimally-valid signed receipt matching what tool-proxy.ts /
 * commitments.ts pass to ticket-verify.ts: `action` and `executionContext`
 * are the two fields it cross-checks, everything else is realistic filler.
 */
export function makeSignedReceipt(
  kp: TestReceiptKeypair,
  overrides: { id?: string; action: string; executionContext?: Record<string, unknown> } & Record<string, unknown>,
): Record<string, unknown> {
  const { id = 'r1', action, executionContext = {}, ...rest } = overrides;
  return signTestReceipt(
    {
      id,
      boundsHash: 'sha256:test',
      profileId: 'test-profile',
      action,
      actionType: 'write',
      executionContext,
      timestamp: Math.floor(Date.now() / 1000),
      issuer: kp.issuer,
      ...rest,
    },
    kp.privateKey,
  );
}
