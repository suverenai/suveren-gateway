/**
 * OAuth `state` — ties a provider callback to a sign-in this gateway started.
 *
 * /auth/oauth/:id/start and /auth/oauth/:id/callback need no API key: the
 * person's browser opens them as a top-level window from the Integrations
 * card, and a window cannot send the X-API-Key header. Without `state`, any
 * page could send the browser to the callback with an authorization code of
 * the attacker's own account, and the gateway would store that account's
 * token for the connector (security review 2026-11, finding A5).
 *
 * Each start issues a random value that is:
 * - single-use: the callback consumes it, whatever the outcome;
 * - short-lived: unknown after `ttlMs` (default 10 minutes);
 * - bound to the start request: it only answers for the same connector, and
 *   it carries the redirect URI that start sent, which the token exchange
 *   must repeat exactly.
 *
 * In memory on purpose: a restart ends every half-finished sign-in, which is
 * the safe direction — the person clicks "Sign in" again.
 */

import { randomBytes } from 'node:crypto';

export interface OAuthStart {
  integrationId: string;
  redirectUri: string;
}

interface Entry extends OAuthStart {
  expiresAt: number;
}

/** Upper bound on open sign-ins, so a loop of /start calls cannot grow memory without end. */
const MAX_OPEN = 100;

export class OAuthStateStore {
  private readonly open = new Map<string, Entry>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** A fresh state for one sign-in started now. */
  issue(start: OAuthStart): string {
    this.prune();
    while (this.open.size >= MAX_OPEN) {
      // Oldest first (Map keeps insertion order).
      const oldest = this.open.keys().next().value as string;
      this.open.delete(oldest);
    }
    const state = randomBytes(32).toString('base64url');
    this.open.set(state, { ...start, expiresAt: this.now() + this.ttlMs });
    return state;
  }

  /**
   * The start this state belongs to, or null when the state is missing,
   * unknown, expired, already used or issued for another connector. The
   * state is spent either way.
   */
  consume(state: unknown, integrationId: string): OAuthStart | null {
    if (typeof state !== 'string' || state === '') return null;
    const entry = this.open.get(state);
    if (!entry) return null;
    this.open.delete(state);
    if (entry.expiresAt <= this.now()) return null;
    if (entry.integrationId !== integrationId) return null;
    return { integrationId: entry.integrationId, redirectUri: entry.redirectUri };
  }

  private prune(): void {
    const t = this.now();
    for (const [k, e] of this.open) if (e.expiresAt <= t) this.open.delete(k);
  }
}
