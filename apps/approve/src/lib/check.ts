/**
 * The phone's check key: the app's passkey (plan 3.1, 8, DEC-47). Face ID, Touch ID, an Android biometric or the phone's PIN,
 * through WebAuthn with user verification. The passkey is made at registration or pairing and named in the device's chain
 * entry (`device.check = { type: "webauthn", rp_id, cred_id, pub }`); a check is an assertion whose challenge is the 32 digest
 * bytes of one object hash (hap-core `verifyCheck`), so it proves a touch over exactly that object.
 *
 * Only ES256 / P-256 is asked for and accepted (hap-core reads exactly EC2 / ES256 / P-256 COSE keys). The relying-party id
 * is the app's own address, so a phone paired at one address is not paired at another.
 *
 * The passkey syncs through the platform's keychain (step 1, check 8: flags `be` and `bs` set on iOS): a check proves the
 * person's account passkey, not this phone. The plan states this limit; nothing here pretends otherwise.
 *
 * `CheckDevice` is the seam: the browser implementation below, and a fake in tests (a virtual authenticator comes with the
 * Playwright run of step 11).
 */
import { b64uDecode, b64uEncode, concat, encodeCoseEc2, hashBytes, sha256, utf8 } from '@hap/core/device-keys';
import type { WebauthnProof } from '@hap/core/device-keys';
import { own } from './bytes';

export type CheckErrorCode =
  /** The person cancelled, or the prompt ran out of time. */
  | 'cancelled'
  /** This phone or browser cannot make or use a passkey of this kind. */
  | 'unsupported'
  /** The passkey was made or used without user verification: the phone has no screen lock. */
  | 'no_user_verification'
  | 'failed';

export class CheckError extends Error {
  constructor(readonly code: CheckErrorCode) {
    super(code);
    this.name = 'CheckError';
  }
}

/** What the Authority Server needs to register a phone's passkey (plan 3.2, rule 2a): the attestation exactly as the browser made it. */
export interface PasskeyRegistration {
  cred_id: string;
  /** COSE_Key bytes, base64url: what `device.check.pub` holds. */
  pub: string;
  rp_id: string;
  /** base64url of the clientDataJSON the browser made: it carries the origin the browser saw. */
  client_data_json: string;
  /** base64url of the attestationObject. */
  attestation_object: string;
}

export interface CheckDevice {
  /** Make the passkey. Asks the person once (Face ID, fingerprint or PIN). */
  register(keyId: string, label: string): Promise<PasskeyRegistration>;
  /** Check one object: an assertion over `objectHash` by the passkey `credId`. Asks the person. */
  prove(credId: string, objectHash: string): Promise<WebauthnProof>;
}

const REGISTER_LABEL = 'suveren-passkey-register-v1';

/**
 * The challenge of a passkey registration, bound to the device it is made for: `sha256("suveren-passkey-register-v1" || 0x00
 * || key_id)`. The Authority Server can recompute it from the entry it receives and refuses a registration made for another
 * key. PROPOSED (the plan fixes no challenge); the server side is not built (see the hand-over).
 */
export async function registrationChallenge(keyId: string): Promise<Uint8Array> {
  return sha256(concat(utf8(REGISTER_LABEL), Uint8Array.of(0), utf8(keyId)));
}

/** UV flag of authenticator data (byte 32, bit 2). */
function userVerified(authData: Uint8Array): boolean {
  return authData.length >= 37 && (authData[32] & 0x04) !== 0;
}

/** The COSE key of a P-256 SPKI (what `getPublicKey()` returns): the last 65 bytes are the uncompressed point. */
export function coseFromSpki(spki: Uint8Array): Uint8Array {
  if (spki.length !== 91 || spki[26] !== 0x04) throw new CheckError('unsupported');
  return encodeCoseEc2(spki.slice(27, 59), spki.slice(59, 91));
}

function mapError(e: unknown): CheckError {
  if (e instanceof CheckError) return e;
  const name = (e as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return new CheckError('cancelled');
  if (name === 'NotSupportedError' || name === 'SecurityError') return new CheckError('unsupported');
  return new CheckError('failed');
}

export class BrowserCheckDevice implements CheckDevice {
  constructor(
    /** The app's own address: the relying-party id. */
    private readonly rpId: string = globalThis.location.hostname,
    private readonly creds: CredentialsContainer = globalThis.navigator.credentials,
  ) {}

  async register(keyId: string, label: string): Promise<PasskeyRegistration> {
    let cred: Credential | null;
    try {
      cred = await this.creds.create({
        publicKey: {
          rp: { id: this.rpId, name: 'Suveren' },
          user: { id: own(globalThis.crypto.getRandomValues(new Uint8Array(16))), name: label, displayName: label },
          challenge: own(await registrationChallenge(keyId)),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          attestation: 'none',
          timeout: 120_000,
        },
      });
    } catch (e) {
      throw mapError(e);
    }
    const pk = cred as PublicKeyCredential | null;
    const r = pk?.response as AuthenticatorAttestationResponse | undefined;
    if (!pk || !r || typeof r.getPublicKey !== 'function') throw new CheckError('unsupported');
    const spki = r.getPublicKey();
    if (!spki || r.getPublicKeyAlgorithm() !== -7) throw new CheckError('unsupported');
    if (!userVerified(new Uint8Array(r.getAuthenticatorData()))) throw new CheckError('no_user_verification');
    return {
      cred_id: b64uEncode(new Uint8Array(pk.rawId)),
      pub: b64uEncode(coseFromSpki(new Uint8Array(spki))),
      rp_id: this.rpId,
      client_data_json: b64uEncode(new Uint8Array(r.clientDataJSON)),
      attestation_object: b64uEncode(new Uint8Array(r.attestationObject)),
    };
  }

  async prove(credId: string, objectHash: string): Promise<WebauthnProof> {
    let cred: Credential | null;
    try {
      cred = await this.creds.get({
        publicKey: {
          challenge: own(hashBytes(objectHash)),
          rpId: this.rpId,
          allowCredentials: [{ type: 'public-key', id: own(b64uDecode(credId)) }],
          userVerification: 'required',
          timeout: 120_000,
        },
      });
    } catch (e) {
      throw mapError(e);
    }
    const r = (cred as PublicKeyCredential | null)?.response as AuthenticatorAssertionResponse | undefined;
    if (!r) throw new CheckError('failed');
    const authData = new Uint8Array(r.authenticatorData);
    if (!userVerified(authData)) throw new CheckError('no_user_verification');
    return {
      authenticatorData: b64uEncode(authData),
      clientDataJSON: b64uEncode(new Uint8Array(r.clientDataJSON)),
      signature: b64uEncode(new Uint8Array(r.signature)),
    };
  }
}
