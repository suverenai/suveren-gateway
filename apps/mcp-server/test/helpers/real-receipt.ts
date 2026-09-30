/**
 * A REAL, verifiably-signed receipt for tests — since ticket-verify.ts now
 * requires every receipt to carry a signature that verifies against the
 * pinned Authority Server key before the gateway will act on it, a bare
 * `{ id: 'r1' }` mock no longer exercises the code path it used to.
 *
 * Uses Node's own `crypto.generateKeyPairSync('ed25519')` /
 * `crypto.sign(null, …)` — the same RFC 8032 Ed25519 scheme hap-core's
 * `verifyReceiptSignature` checks against (via @noble/ed25519), so a
 * signature made here verifies for real. No mocking of the verification
 * itself — only the Authority Server's HTTP call is a test double.
 */
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { canonicalize } from '@hap/core';

export interface TestReceiptKeypair {
  privateKey: KeyObject;
  publicKeyHex: string;
}

export function testReceiptKeypair(): TestReceiptKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = (publicKey.export({ format: 'jwk' }) as { x?: string }).x;
  if (!raw) throw new Error('test setup: could not extract raw Ed25519 public key');
  return { privateKey, publicKeyHex: Buffer.from(raw, 'base64url').toString('hex') };
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
      ...rest,
    },
    kp.privateKey,
  );
}
