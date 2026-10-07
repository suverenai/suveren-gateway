/**
 * What an agent is told when the gateway is running but LOCKED.
 *
 * Four ways to end up here, and they need different explanations:
 *
 *  - **'restart' (default)** — the gateway always boots locked; nothing on
 *    the machine can decrypt the vault without the person. Autostart makes
 *    that state far more common: after a reboot the gateway comes back up,
 *    binds its port, and answers happily, while being unable to read a
 *    single mandate.
 *  - **'expired'** — a session that WAS active ended: the Authority Server's
 *    session lasts 30 days, or was revoked (suspension, deletion, key
 *    change). The gateway locks itself the moment it learns this, exactly
 *    like logout — so the agent must never keep reporting "no authority" in
 *    words that suggest nothing was ever granted.
 *  - **'as-key-mismatch'** — the Authority Server at the configured URL
 *    presented a signing key that does not match the one pinned at pairing
 *    (as-pairing.ts). Telling the agent "your sign-in ended, sign in again"
 *    here would be actively misleading: signing in again is REFUSED (409) —
 *    see auth.ts — until an operator resolves the mismatch.
 *  - **'as-tls-mismatch'** — opt-in TLS pinning (`config set pin-tls on`,
 *    as-tls-pin.ts) is enabled, and a connection to the Authority Server
 *    presented a TLS certificate whose public key does not match the one
 *    pinned at pairing. Caught at the transport layer — before any
 *    application-level signature check — so this can happen even for a call
 *    that would otherwise never reach the key-mismatch case above. Same fix
 *    as key-mismatch: an operator must resolve it; signing in again is
 *    refused until they do.
 *  - **'as-url-changed'** — the resolved Authority Server URL no longer
 *    matches the one this gateway was paired with; re-pairing (a fresh
 *    sign-in against the new server) is exactly what's needed here, unlike
 *    the key-mismatch case.
 *
 * Before any of these existed, this state was reported as "No authorizations
 * found" — indistinguishable from a correctly configured gateway belonging to
 * someone who has not set anything up. The agent would confidently tell the
 * user they had no authority, and the user would go and create one, when
 * what they needed was to sign in (again). A wrong answer stated confidently,
 * which is worse than an error.
 *
 * Autostart and session expiry both make this QUIETER, not louder: a dead
 * gateway used to produce an obvious connection failure. Now it connects fine
 * and simply has no authority. So the message has to carry the whole
 * explanation and the fix.
 */

/** Why the gateway is locked right now. */
export type LockedReason = 'restart' | 'expired' | 'as-key-mismatch' | 'as-tls-mismatch' | 'as-url-changed';

/** Address the person should open. Honours a non-default control-plane port. */
export function uiUrl(): string {
  const port = process.env.SUVEREN_CP_PORT ?? '3400';
  return `http://localhost:${port}`;
}

function bootLockedNotice(what: string): string {
  return (
    `${what} Suveren gateway is running but LOCKED, so it cannot read any ` +
    `mandates or credentials.\n\n` +
    `This is not the same as having no mandates — yours are on disk, ` +
    `encrypted, and unreadable until someone unlocks them.\n\n` +
    `TELL THE USER: open ${uiUrl()} and enter your Suveren API key to unlock ` +
    `the gateway. It boots locked by design after every restart; the key is ` +
    `never stored.`
  );
}

function expiredSessionNotice(what: string): string {
  return (
    `${what} Suveren gateway's sign-in has ended (sign-ins last 30 days, or ` +
    `it was revoked), so it is now LOCKED.\n\n` +
    `TELL THE USER: open ${uiUrl()} and enter your Suveren API key to sign ` +
    `in again. Your mandates are safe; nothing ran.`
  );
}

function asKeyMismatchNotice(what: string): string {
  return (
    `${what} Suveren gateway is LOCKED because the Authority Server it is ` +
    `configured to use presented a signing key that does not match the one ` +
    `pinned when this gateway last signed in. This is NOT an ended sign-in — ` +
    `signing in again will be refused until the mismatch is resolved.\n\n` +
    `TELL THE USER: this needs an operator to check whether the Authority ` +
    `Server's key changed intentionally (e.g. a reinstall) or something else ` +
    `is answering at that address, at ${uiUrl()}. Nothing ran under the ` +
    `unrecognized key.`
  );
}

function asTlsMismatchNotice(what: string): string {
  return (
    `${what} Suveren gateway is LOCKED because a connection to the Authority Server presented a TLS ` +
    `certificate that does not match the one pinned when this gateway last signed in (opt-in pin-tls). ` +
    `This is NOT an ended sign-in — signing in again will be refused until the mismatch is resolved.\n\n` +
    `TELL THE USER: this needs an operator to check whether the Authority Server's certificate changed ` +
    `intentionally (e.g. a new TLS key, not just a renewal) or something else is answering at that ` +
    `address, at ${uiUrl()}. Nothing was sent under the unrecognized certificate.`
  );
}

function asUrlChangedNotice(what: string): string {
  return (
    `${what} Suveren gateway is LOCKED because the Authority Server it points ` +
    `at has changed since it last signed in. Cached mandates from the old ` +
    `server were cleared.\n\n` +
    `TELL THE USER: open ${uiUrl()} and sign in again to pair with the new ` +
    `Authority Server.`
  );
}

/**
 * The notice, addressed to the AGENT but written to be relayed verbatim to the
 * person — the agent is the only thing that can see this state, and the person
 * is the only one who can fix it.
 */
export function lockedNotice(action?: string, reason: LockedReason = 'restart'): string {
  const what = action ? `Cannot ${action}: the` : 'The';
  switch (reason) {
    case 'expired': return expiredSessionNotice(what);
    case 'as-key-mismatch': return asKeyMismatchNotice(what);
    case 'as-tls-mismatch': return asTlsMismatchNotice(what);
    case 'as-url-changed': return asUrlChangedNotice(what);
    default: return bootLockedNotice(what);
  }
}
