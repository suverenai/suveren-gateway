/**
 * "Open approvals automatically" on this phone (DEC-86: the same setting as the gateway page's). The gateway keeps it in the
 * gateway; the phone keeps it on the phone, in the app's own store (kv.ts): it is a fact about this device, not a secret and not
 * content. Default on, as the gateway's (control-plane lib/gateway-settings.ts). A store that cannot be read gives null: the
 * panel then never opens by itself and the switch is left out (the gateway's rule: never guessed).
 */
import type { Kv } from './kv';

const KEY = 'openApprovalsAutomatically';

export async function loadAutoOpen(kv: Kv): Promise<boolean | null> {
  try {
    const v = await kv.get<boolean>(KEY);
    return typeof v === 'boolean' ? v : true;
  } catch {
    return null;
  }
}

/** Writes the setting and returns what was stored, read back. Throws when the write fails. */
export async function saveAutoOpen(kv: Kv, value: boolean): Promise<boolean> {
  await kv.set(KEY, value);
  const back = await kv.get<boolean>(KEY);
  if (typeof back !== 'boolean') throw new Error('The setting was not stored');
  return back;
}
