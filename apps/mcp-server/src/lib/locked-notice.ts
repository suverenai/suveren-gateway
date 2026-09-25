/**
 * What an agent is told when the gateway is running but LOCKED.
 *
 * Two ways to end up here, and they need different explanations:
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
 *
 * Before either existed, this state was reported as "No authorizations
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
export type LockedReason = 'restart' | 'expired';

/** Address the person should open. Honours a non-default control-plane port. */
function uiUrl(): string {
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

/**
 * The notice, addressed to the AGENT but written to be relayed verbatim to the
 * person — the agent is the only thing that can see this state, and the person
 * is the only one who can fix it.
 */
export function lockedNotice(action?: string, reason: LockedReason = 'restart'): string {
  const what = action ? `Cannot ${action}: the` : 'The';
  return reason === 'expired' ? expiredSessionNotice(what) : bootLockedNotice(what);
}
