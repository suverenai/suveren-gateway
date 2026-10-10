/**
 * Tickets issued before the v0.7 wire switch (no `issuer`, standard-base64
 * signature over the JCS of every other field) must verify against the key
 * archived at issuance — not read as "Signature check FAILED".
 *
 * Found on a real archive after 0.23.0 (2026-10-10): every pre-switch ticket
 * showed FAILED although its signature was genuine. The fixture here is
 * generated, not a real ticket.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalize } from '@hap/core';
import { isPreV07Ticket, verifyPreV07TicketSignature } from '../routes/evidence';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, publicKeyHex: Buffer.from(raw).toString('hex') };
}

/** A ticket in the pre-v0.7 shape, signed the way the AS signed it then. */
function legacyTicket(privateKey: ReturnType<typeof keypair>['privateKey']) {
  const body = {
    id: 'ticket-1',
    groupId: 'g', userId: 'u', authorizationId: 'authz_x',
    profileId: 'github.com/humanagencyprotocol/hap-profiles/customers@0.8',
    path: 'github.com/humanagencyprotocol/hap-profiles/customers@0.8',
    action: 'crm__log_activity', actionType: 'write',
    executionContext: { action_type: 'write', contact_type: 'customer' },
    cumulativeState: { daily: { amount: 0, count: 3 }, monthly: { amount: 0, count: 3 } },
    timestamp: 1791272004,
    contentHash: 'sha256:abc', contentBinding: { version: '1', kind: 'jcs' },
  };
  const signature = sign(null, Buffer.from(canonicalize(body), 'utf8'), privateKey).toString('base64');
  return { ...body, signature } as Record<string, unknown>;
}

describe('pre-v0.7 tickets verify with their own format', () => {
  it('a genuine pre-switch ticket verifies against the archived key', () => {
    const kp = keypair();
    const t = legacyTicket(kp.privateKey);
    expect(isPreV07Ticket(t)).toBe(true);
    expect(verifyPreV07TicketSignature(t, kp.publicKeyHex)).toBe(true);
  });

  it('an altered field fails', () => {
    const kp = keypair();
    const t = legacyTicket(kp.privateKey);
    (t.executionContext as Record<string, unknown>).contact_type = 'lead';
    expect(verifyPreV07TicketSignature(t, kp.publicKeyHex)).toBe(false);
  });

  it('a different key fails', () => {
    const t = legacyTicket(keypair().privateKey);
    expect(verifyPreV07TicketSignature(t, keypair().publicKeyHex)).toBe(false);
  });

  it('a missing or malformed signature fails, never throws', () => {
    const kp = keypair();
    const t = legacyTicket(kp.privateKey);
    expect(verifyPreV07TicketSignature({ ...t, signature: undefined }, kp.publicKeyHex)).toBe(false);
    expect(verifyPreV07TicketSignature({ ...t, signature: 'not-a-signature' }, kp.publicKeyHex)).toBe(false);
    expect(verifyPreV07TicketSignature(t, 'zz')).toBe(false);
  });

  it('a ticket that carries an issuer is v0.7 and never takes this path', () => {
    expect(isPreV07Ticket({ issuer: 'did:key:z6Mk…', signature: 'x' })).toBe(false);
  });
});
