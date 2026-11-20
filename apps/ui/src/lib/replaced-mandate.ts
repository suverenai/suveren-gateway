/**
 * A mandate the person replaced while the Authority Server still holds it (its
 * revoke there has not gone through yet). The gateway no longer uses it and
 * ends it on suveren.ai by itself (control-plane replaced-revoke-retry.ts);
 * the Mandates list shows one quiet line on it until then, and no action
 * (Andreas, 2026-11-20). Wording approved by Andreas, 2026-11-20.
 */
export const REPLACED_LINE = 'Replaced by your change. Your AI no longer uses it.';

/** The quiet line for this mandate, or null. Only while it still shows as active. */
export function replacedLine(status: string, authorizationId: string, replaced: ReadonlySet<string> | undefined): string | null {
  return status === 'active' && replaced?.has(authorizationId) ? REPLACED_LINE : null;
}
