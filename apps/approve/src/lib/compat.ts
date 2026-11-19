/**
 * Can this phone pair at all? (plan 8, "Conditions to pair" and "Minimum platforms"; DEC-19.)
 *
 * The app needs: Ed25519 and X25519 in WebCrypto (iOS 18.4+, Chrome 137+); a passkey with a screen lock; the installed app on
 * an iPhone (the browser tab has other storage than the home-screen app, so a phone paired in a tab is not paired in the app).
 * Nothing is guessed from the user-agent text: each ability is tried. A phone that fails says WHICH ability it lacks, so the
 * screen can say which phone or system version is needed.
 *
 * There is no software-key fallback for old phones (DEC-19). The reading-key wrap of key-store.ts is not that fallback: it is
 * the way the same non-extractable keys are kept on iOS 18.7.
 */

/** What the phone can do, as tried. */
export interface Probe {
  ed25519: boolean;
  x25519: boolean;
  /** WebAuthn exists and the phone has a platform authenticator that verifies the user (a screen lock and a passkey store). */
  passkey: boolean;
  /** iOS only: this is a Safari tab, not the installed app. */
  iosTab: boolean;
  /** IndexedDB is there. */
  storage: boolean;
}

export type Need = 'install_app' | 'newer_system' | 'passkey' | 'storage';

export type Assessment = { ok: true } | { ok: false; needs: Need[] };

/** Pure: the order is the order the screen lists them. */
export function assess(p: Probe): Assessment {
  const needs: Need[] = [];
  if (p.iosTab) needs.push('install_app');
  if (!p.ed25519 || !p.x25519) needs.push('newer_system');
  if (!p.passkey) needs.push('passkey');
  if (!p.storage) needs.push('storage');
  return needs.length === 0 ? { ok: true } : { ok: false, needs };
}

async function canMake(subtle: SubtleCrypto, name: 'Ed25519' | 'X25519'): Promise<boolean> {
  try {
    await subtle.generateKey({ name }, false, name === 'Ed25519' ? ['sign', 'verify'] : ['deriveBits']);
    return true;
  } catch {
    // X25519 is made extractable in key-store.ts (to be wrapped), so try that form as well.
    if (name === 'X25519') {
      try {
        await subtle.generateKey({ name }, true, ['deriveBits']);
        return true;
      } catch { return false; }
    }
    return false;
  }
}

/** Try each ability on this phone. */
export async function probe(): Promise<Probe> {
  const subtle = globalThis.crypto?.subtle;
  const nav = globalThis.navigator as Navigator & { standalone?: boolean };
  let passkey = false;
  try {
    const PKC = (globalThis as { PublicKeyCredential?: typeof PublicKeyCredential }).PublicKeyCredential;
    passkey = !!PKC && (await PKC.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch { passkey = false; }
  return {
    ed25519: !!subtle && (await canMake(subtle, 'Ed25519')),
    x25519: !!subtle && (await canMake(subtle, 'X25519')),
    passkey,
    iosTab: typeof nav.standalone === 'boolean' && nav.standalone === false,
    storage: typeof globalThis.indexedDB !== 'undefined',
  };
}

/**
 * Ask the browser to keep the app's storage (plan 8: "The app calls navigator.storage.persist() and shows whether storage is
 * persistent"). Null: the browser cannot say.
 */
export async function requestPersistentStorage(): Promise<boolean | null> {
  const s = globalThis.navigator?.storage;
  if (!s || typeof s.persist !== 'function' || typeof s.persisted !== 'function') return null;
  try {
    return (await s.persisted()) || (await s.persist());
  } catch {
    return null;
  }
}
