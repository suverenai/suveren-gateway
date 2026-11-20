import { describe, it, expect } from 'vitest';
import {
  computeProfileHash, decodeMandateBlob, encodeDidKey, signMandate, verifyMandateSignature, wireExecutionContext, boundReadFields as coreBoundReadFields,
  type AgentProfile, type MandatePayload,
} from '@hap/core';
import { didKeyOf, profileHashOf, verifyMandateBlob, wireFilter, boundReadFields, CLOCK_SKEW_SECONDS } from './mandate-check';

/**
 * The phone cannot load hap-core's main entry in a browser (it imports Node's crypto), so it carries four small rules of its own.
 * Every one of them is run here against hap-core's real function: a drift shows up as a red test, not as a wrong card.
 */

const PROFILE = {
  id: 'test/purchase@0.1',
  boundsSchema: {
    fields: {
      amount_max: { boundType: { kind: 'per_transaction', of: 'amount' } },
      amount_daily: { boundType: { kind: 'cumulative_sum', of: 'spend' } },
      count_daily: { boundType: { kind: 'cumulative_count' } },
      region: { boundType: { kind: 'enum' } },
    },
    actionTypes: ['send'],
  },
  executionContextSchema: { amount: { type: 'number' } },
} as unknown as AgentProfile;

async function asKey() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { raw, hex: [...raw].map((b) => b.toString(16).padStart(2, '0')).join(''), seed: pkcs8.slice(-32) };
}

function payloadFor(issuer: string, over: Partial<MandatePayload> = {}): MandatePayload {
  return {
    mandate_id: 'mandate-0001', version: '0.8', profile_id: 'test/purchase@0.1', bounds_hash: 'sha256:' + 'a'.repeat(64), scope_hash: 'sha256:' + 'b'.repeat(64),
    execution_context_hash: 'sha256:' + 'c'.repeat(64), profile_hash: computeProfileHash(PROFILE), issuer, mandate_owners: [{ did: 'did:key:z6Mkowner' }],
    gate_content_hashes: {}, commitment_mode: 'review', issued_at: 1_800_000_000, expires_at: 1_800_100_000, ...over,
  } as unknown as MandatePayload;
}

describe('did:key of the pinned server key', () => {
  it('is hap-core\'s encodeDidKey, byte for byte', async () => {
    for (let i = 0; i < 5; i++) {
      const k = await asKey();
      expect(didKeyOf(k.raw)).toBe(encodeDidKey(k.raw));
    }
    // leading zero bytes are the case a hand-written base58 gets wrong
    const zeros = new Uint8Array(32);
    expect(didKeyOf(zeros)).toBe(encodeDidKey(zeros));
  });
});

describe('the mandate signature (plan 8: the AS signature on the mandate with the pinned key)', () => {
  it('accepts what hap-core signed and hap-core\'s verifier accepts the same blob', async () => {
    const k = await asKey();
    const payload = payloadFor(encodeDidKey(k.raw));
    const blob = Buffer.from(JSON.stringify(await signMandate(payload, k.seed))).toString('base64url');
    await verifyMandateSignature(decodeMandateBlob(blob), { trustedIssuers: [encodeDidKey(k.raw)] });
    const v = await verifyMandateBlob(blob, k.hex, 1_800_000_100);
    expect(v.ok && v.payload.mandate_id).toBe('mandate-0001');
  });

  it('refuses a mandate signed by another key, even one that names the pinned key as issuer', async () => {
    const pinned = await asKey();
    const rogue = await asKey();
    const payload = payloadFor(encodeDidKey(pinned.raw));
    const blob = Buffer.from(JSON.stringify(await signMandate(payload, rogue.seed))).toString('base64url');
    await expect(verifyMandateSignature(decodeMandateBlob(blob), { trustedIssuers: [encodeDidKey(pinned.raw)] })).rejects.toThrow();
    expect(await verifyMandateBlob(blob, pinned.hex, 1_800_000_100)).toEqual({ ok: false, code: 'mandate_signature' });
  });

  it('refuses a mandate whose issuer is not the pinned key (a server that signs under its own, other key)', async () => {
    const pinned = await asKey();
    const other = await asKey();
    const blob = Buffer.from(JSON.stringify(await signMandate(payloadFor(encodeDidKey(other.raw)), other.seed))).toString('base64url');
    expect(await verifyMandateBlob(blob, pinned.hex, 1_800_000_100)).toEqual({ ok: false, code: 'mandate_signature' });
  });

  it('refuses a payload changed after signing', async () => {
    const k = await asKey();
    const m = await signMandate(payloadFor(encodeDidKey(k.raw)), k.seed);
    const tampered = Buffer.from(JSON.stringify({ ...m, payload: { ...m.payload, mandate_id: 'mandate-0002' } })).toString('base64url');
    expect(await verifyMandateBlob(tampered, k.hex, 1_800_000_100)).toEqual({ ok: false, code: 'mandate_signature' });
  });

  it('time: valid to expires_at plus the skew hap-core allows, then expired', async () => {
    const k = await asKey();
    const blob = Buffer.from(JSON.stringify(await signMandate(payloadFor(encodeDidKey(k.raw)), k.seed))).toString('base64url');
    const end = 1_800_100_000;
    expect((await verifyMandateBlob(blob, k.hex, end + CLOCK_SKEW_SECONDS)).ok).toBe(true);
    expect(await verifyMandateBlob(blob, k.hex, end + CLOCK_SKEW_SECONDS + 1)).toEqual({ ok: false, code: 'mandate_expired' });
  });

  it('garbage is "invalid", never a throw', async () => {
    const k = await asKey();
    for (const junk of ['', '!!!', 'e30', Buffer.from('[]').toString('base64url'), Buffer.from('{"header":{},"payload":{}, "signature":"x"}').toString('base64url')]) {
      const v = await verifyMandateBlob(junk, k.hex, 1);
      expect(v.ok).toBe(false);
    }
    expect((await verifyMandateBlob('abc', 'not-hex', 1)).ok).toBe(false);
  });
});

describe('the profile hash', () => {
  it('is hap-core\'s computeProfileHash, whatever the key order or formatting', async () => {
    expect(await profileHashOf(PROFILE)).toBe(computeProfileHash(PROFILE));
    const reordered = JSON.parse(JSON.stringify({ executionContextSchema: PROFILE.executionContextSchema, boundsSchema: PROFILE.boundsSchema, id: PROFILE.id }));
    expect(await profileHashOf(reordered)).toBe(computeProfileHash(PROFILE));
    expect(await profileHashOf({ ...reordered, id: 'other' })).not.toBe(computeProfileHash(PROFILE));
  });
});

describe('the wire execution context', () => {
  it('is hap-core\'s wireExecutionContext: only what a bound reads, no _ key, no null', () => {
    const execution = { amount: 12.5, spend: 3, region: 'AT', _hint: 1, extra: 'x', amount_none: null };
    expect(wireFilter(execution, PROFILE)).toEqual(wireExecutionContext(execution, PROFILE));
    expect(wireFilter({ amount: null, spend: undefined }, PROFILE)).toEqual(wireExecutionContext({ amount: null, spend: undefined }, PROFILE));
    expect([...boundReadFields(PROFILE)].sort()).toEqual([...coreBoundReadFields(PROFILE)].sort());
    // a profile without bounds reads nothing
    expect(wireFilter({ amount: 1 }, {})).toEqual({});
  });
});
