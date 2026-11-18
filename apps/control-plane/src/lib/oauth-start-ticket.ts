/**
 * One-time start tickets for OAuth sign-in on a vault with an unlock password.
 *
 * The page opens /auth/oauth/:id/start in a new window, which cannot send the
 * page session's header token. So the page first asks, WITH the header, for a
 * ticket: random, valid 60 seconds, once, for that connector, bound to that
 * page session. /start then needs the ticket AND the session cookie (SameSite=
 * Strict: a link on another site does not carry it). A page on another origin
 * can obtain neither the ticket (it lacks the header token) nor the cookie.
 */

import { randomBytes } from 'node:crypto';

export const TICKET_TTL_MS = 60_000;

export interface StartTicket { confirmedAt?: number; replaces?: string[] }

interface Entry extends StartTicket { sessionId: string; integrationId: string; expiresAt: number }

export class OAuthStartTickets {
  private tickets = new Map<string, Entry>();
  constructor(private readonly now: () => number = Date.now) {}

  issue(sessionId: string, integrationId: string, info: StartTicket = {}): string {
    const t = this.now();
    for (const [k, e] of this.tickets) if (e.expiresAt <= t) this.tickets.delete(k);
    const id = randomBytes(24).toString('base64url');
    this.tickets.set(id, { ...info, sessionId, integrationId, expiresAt: t + TICKET_TTL_MS });
    return id;
  }

  /** Spent whether or not it fits. */
  consume(ticket: unknown, sessionId: string | null, integrationId: string): StartTicket | null {
    if (typeof ticket !== 'string') return null;
    const e = this.tickets.get(ticket);
    if (!e) return null;
    this.tickets.delete(ticket);
    if (!sessionId || e.sessionId !== sessionId || e.integrationId !== integrationId || this.now() >= e.expiresAt) return null;
    return { confirmedAt: e.confirmedAt, replaces: e.replaces };
  }
}
