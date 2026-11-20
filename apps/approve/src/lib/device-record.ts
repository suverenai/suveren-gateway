/**
 * Building and signing the chain entries this phone makes (plan 3.1, 3.2). Pure over the key store and the check device:
 * no network, no screen.
 */
import {
  buildDeviceRecord, entrySignedBytes, b64uEncode, validateCheckKey,
  type ChainEntry, type CheckKey, type DeviceRecord, type WebauthnProof,
} from '@hap/core/device-keys';
import type { DeviceKeyStore, DevicePublicKeys } from './key-store';
import type { PasskeyRegistration } from './check';

/** The check key a passkey registration names (`device.check`, plan 3.1). */
export function checkKeyOf(reg: PasskeyRegistration): CheckKey {
  return validateCheckKey({ type: 'webauthn', rp_id: reg.rp_id, cred_id: reg.cred_id, pub: reg.pub });
}

/** This phone as a chain device: kind `approve-app`, keys kept by the platform (key-store.ts), its passkey as the check key. */
export async function phoneRecord(keys: DevicePublicKeys, label: string, check: CheckKey): Promise<DeviceRecord> {
  return buildDeviceRecord(
    { sign_pub: b64uEncode(keys.signPub), read_pub: b64uEncode(keys.readPub), kind: 'approve-app', label, keystore: 'platform', check },
    keys.signPub,
  );
}

/** This phone's signature over an entry, in the `sigs` form. `by` is its key id. */
export async function signWithPhone(store: DeviceKeyStore, entry: ChainEntry, by: string): Promise<{ by: string; sig: string }> {
  return { by, sig: b64uEncode(await store.sign(entrySignedBytes(entry))) };
}

/** A `checks` element. */
export const checkElement = (by: string, check: WebauthnProof): { by: string; check: WebauthnProof } => ({ by, check });
