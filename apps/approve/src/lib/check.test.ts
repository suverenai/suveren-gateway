import { describe, it, expect } from 'vitest';
import { b64uDecode, b64uEncode, concat, ecdsaRawToDer, hashBytes, sha256, utf8, validateCheckKey, verifyCheck } from '@hap/core/device-keys';
import { BrowserCheckDevice, CheckError, coseFromSpki, registrationChallenge } from './check';
import { checkKeyOf } from './device-record';

const RP = 'approve.test';

/** A CredentialsContainer with one real P-256 key behind it, answering the way a browser does. */
async function fakeBrowser(opts: { uv?: boolean; refuse?: string } = {}) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const rawId = crypto.getRandomValues(new Uint8Array(16));
  const flags = opts.uv === false ? 0x01 : 0x05;
  const authData = concat(await sha256(utf8(RP)), Uint8Array.of(flags), Uint8Array.of(0, 0, 0, 7));
  const seen: { create?: unknown; get?: unknown } = {};
  const creds = {
    async create(o: unknown) {
      seen.create = o;
      if (opts.refuse) throw Object.assign(new Error('x'), { name: opts.refuse });
      return {
        rawId: rawId.buffer,
        response: {
          getPublicKey: () => spki.buffer,
          getPublicKeyAlgorithm: () => -7,
          getAuthenticatorData: () => authData.buffer,
          clientDataJSON: utf8('{"type":"webauthn.create"}').buffer,
          attestationObject: utf8('att').buffer,
        },
      };
    },
    async get(o: unknown) {
      seen.get = o;
      if (opts.refuse) throw Object.assign(new Error('x'), { name: opts.refuse });
      const challenge = new Uint8Array((o as { publicKey: { challenge: BufferSource } }).publicKey.challenge as ArrayBuffer);
      const clientData = utf8(JSON.stringify({ type: 'webauthn.get', challenge: b64uEncode(challenge), origin: `https://${RP}` }));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new Uint8Array(concat(authData, await sha256(clientData)))));
      return { response: { authenticatorData: authData.buffer, clientDataJSON: clientData.buffer, signature: ecdsaRawToDer(raw).buffer } };
    },
  } as unknown as CredentialsContainer;
  return { device: new BrowserCheckDevice(RP, creds), seen };
}

describe('the passkey is the phone\'s check key', () => {
  it('a registration names a webauthn check key hap-core accepts (ES256, P-256, COSE)', async () => {
    const { device } = await fakeBrowser();
    const reg = await device.register('keyid', 'My iPhone');
    expect(reg.rp_id).toBe(RP);
    const check = checkKeyOf(reg);
    expect(check).toMatchObject({ type: 'webauthn', rp_id: RP, cred_id: reg.cred_id });
    expect(validateCheckKey(check)).toEqual(check);
  });

  it('asks only for ES256, with user verification and a resident key, and binds the challenge to the key id', async () => {
    const { device, seen } = await fakeBrowser();
    await device.register('keyid-1', 'My iPhone');
    const pk = (seen.create as { publicKey: Record<string, any> }).publicKey; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(pk.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }]);
    expect(pk.authenticatorSelection).toEqual({ residentKey: 'required', userVerification: 'required' });
    expect(pk.rp.id).toBe(RP);
    expect(pk.attestation).toBe('none');
    expect(b64uEncode(new Uint8Array(pk.challenge))).toBe(b64uEncode(await registrationChallenge('keyid-1')));
    expect(b64uEncode(await registrationChallenge('keyid-1'))).not.toBe(b64uEncode(await registrationChallenge('keyid-2')));
  });

  it('a check is an assertion over the exact object hash: hap-core verifies it, and not for another hash', async () => {
    const { device } = await fakeBrowser();
    const reg = await device.register('keyid', 'My iPhone');
    const hash = 'sha256:' + 'ab'.repeat(32);
    const proof = await device.prove(reg.cred_id, hash);
    expect(await verifyCheck(checkKeyOf(reg), hash, proof)).toBe(true);
    expect(await verifyCheck(checkKeyOf(reg), 'sha256:' + 'cd'.repeat(32), proof)).toBe(false);
  });

  it('asks for the one credential and for user verification', async () => {
    const { device, seen } = await fakeBrowser();
    const reg = await device.register('keyid', 'My iPhone');
    await device.prove(reg.cred_id, 'sha256:' + 'ab'.repeat(32));
    const pk = (seen.get as { publicKey: Record<string, any> }).publicKey; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(pk.userVerification).toBe('required');
    expect(pk.rpId).toBe(RP);
    expect(pk.allowCredentials).toHaveLength(1);
    expect(b64uEncode(new Uint8Array(pk.allowCredentials[0].id))).toBe(reg.cred_id);
    expect(new Uint8Array(pk.challenge)).toEqual(hashBytes('sha256:' + 'ab'.repeat(32)));
  });

  it('a phone without a screen lock (no user-verified flag) cannot register or check', async () => {
    const { device } = await fakeBrowser({ uv: false });
    await expect(device.register('k', 'x')).rejects.toMatchObject({ code: 'no_user_verification' });
    const ok = await fakeBrowser();
    const reg = await ok.device.register('k', 'x');
    const noUv = await fakeBrowser({ uv: false });
    await expect(noUv.device.prove(reg.cred_id, 'sha256:' + 'ab'.repeat(32))).rejects.toMatchObject({ code: 'no_user_verification' });
  });

  it('a cancelled prompt is "cancelled"; an unsupported one is "unsupported"', async () => {
    const cancelled = await fakeBrowser({ refuse: 'NotAllowedError' });
    await expect(cancelled.device.register('k', 'x')).rejects.toMatchObject({ code: 'cancelled' });
    await expect(cancelled.device.prove(b64uEncode(new Uint8Array(16)), 'sha256:' + 'ab'.repeat(32))).rejects.toMatchObject({ code: 'cancelled' });
    const unsupported = await fakeBrowser({ refuse: 'NotSupportedError' });
    await expect(unsupported.device.register('k', 'x')).rejects.toBeInstanceOf(CheckError);
  });

  it('coseFromSpki takes the point out of a P-256 SPKI and refuses anything else', () => {
    const spki = new Uint8Array(91);
    spki[26] = 0x04;
    spki.fill(1, 27, 59);
    spki.fill(2, 59, 91);
    const cose = coseFromSpki(spki);
    expect(b64uDecode(b64uEncode(cose))).toEqual(cose);
    expect(() => coseFromSpki(new Uint8Array(90))).toThrow();
  });
});
