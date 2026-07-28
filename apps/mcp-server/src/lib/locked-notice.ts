/**
 * What an agent is told when the gateway is running but LOCKED.
 *
 * The gateway always boots locked — nothing on the machine can decrypt the
 * vault without the person. Autostart makes that state far more common: after
 * a reboot the gateway comes back up, binds its port, and answers happily,
 * while being unable to read a single authorization.
 *
 * Before this existed, that state was reported as "No authorizations found" —
 * indistinguishable from a correctly configured gateway belonging to someone
 * who has not set anything up. The agent would confidently tell the user they
 * had no authority, and the user would go and create one, when what they
 * needed was to type their API key. A wrong answer stated confidently, which
 * is worse than an error.
 *
 * Autostart makes this quieter, not louder: previously a dead gateway produced
 * an obvious connection failure. Now it connects fine and simply has no
 * authority. So the message has to carry the whole explanation and the fix.
 */

/** Address the person should open. Honours a non-default control-plane port. */
function uiUrl(): string {
  const port = process.env.SUVEREN_CP_PORT ?? '3400';
  return `http://localhost:${port}`;
}

/**
 * The notice, addressed to the AGENT but written to be relayed verbatim to the
 * person — the agent is the only thing that can see this state, and the person
 * is the only one who can fix it.
 */
export function lockedNotice(action?: string): string {
  const what = action ? `Cannot ${action}: the` : 'The';
  return (
    `${what} Suveren gateway is running but LOCKED, so it cannot read any ` +
    `authorizations or credentials.\n\n` +
    `This is not the same as having no authorizations — yours are on disk, ` +
    `encrypted, and unreadable until someone unlocks them.\n\n` +
    `TELL THE USER: open ${uiUrl()} and enter your Suveren API key to unlock ` +
    `the gateway. It boots locked by design after every restart; the key is ` +
    `never stored.`
  );
}
