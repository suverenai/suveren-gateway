/**
 * Confirmations for replacing or removing a connector login (DEC-29 as revised
 * by DEC-44 and DEC-47; plan section 7). Entering a login for the first time
 * needs none.
 *
 * The gateway builds a change request
 *   { request_id, kind, name, change_hash, gateway_key_id, expires_at }
 * where request_id is 16 random bytes, change_hash the SHA-256 of the JCS of
 * the exact change, and expires_at 300 seconds ahead. The person confirms THAT
 * request (password path: only on a computer with no check key). The change
 * then runs only if it presents that request_id, its own change_hash matches,
 * the request was confirmed, it has not expired, it was not used before, and it
 * is presented from the page session that asked for it.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import type { Vault } from './vault';
import { SESSION_COOKIE, type PageSessions, parseCookie } from './page-session';

export const CONFIRMATION_TTL_MS = 300_000;
export const CONFIRMATION_HEADER = 'x-suveren-confirmation';

export type ChangeKind = 'replace' | 'remove';

/** RFC 8785 style canonical JSON: sorted keys, no whitespace. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter(k => o[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** The hash a confirmation is bound to: the exact change, nothing else. */
export function changeHash(kind: ChangeKind, name: string, change: unknown): string {
  return createHash('sha256').update(canonicalJson({ kind, name, change: change ?? null })).digest('hex');
}

export interface ChangeRequest {
  request_id: string;
  kind: ChangeKind;
  /**
   * The connector login the change is for. Inside the signed object so the check key's prompt can say which
   * login ("replace the login of "gmail""), and bound again in `change_hash`. Added to plan section 7's five
   * members for that reason.
   */
  name: string;
  change_hash: string;
  gateway_key_id: string | null;
  expires_at: number; // ms, this gateway's clock
}

interface Pending extends ChangeRequest { sessionId: string; confirmed: boolean; via: 'password' | 'check' | null }

export class ChangeConfirmations {
  private pending = new Map<string, Pending>();
  private readonly now: () => number;
  private readonly checkRequired: () => boolean;

  /**
   * `checkRequired`: does this computer have a check key (lib/platform-checks.ts)? Asked when a
   * confirmation is USED, not only when it is given: a password confirmation made before a check
   * key came to exist never carries a change out afterwards (DEC-47: the password stands in only
   * where there is no check key).
   */
  constructor(opts: { now?: () => number; checkRequired?: () => boolean } = {}) {
    this.now = opts.now ?? Date.now;
    this.checkRequired = opts.checkRequired ?? (() => false);
  }

  /** The gateway builds the request for one exact change, for one page session. */
  request(sessionId: string, kind: ChangeKind, name: string, change: unknown): ChangeRequest {
    const t = this.now();
    for (const [id, p] of this.pending) if (p.expires_at <= t) this.pending.delete(id);
    const req: Pending = {
      request_id: randomBytes(16).toString('base64url'),
      kind,
      name,
      change_hash: changeHash(kind, name, change),
      gateway_key_id: null, // the gateway signs requests once it has a key (plan 20.4)
      expires_at: t + CONFIRMATION_TTL_MS,
      sessionId,
      confirmed: false,
      via: null,
    };
    this.pending.set(req.request_id, req);
    const { sessionId: _s, confirmed: _c, via: _v, ...pub } = req;
    return pub;
  }

  /** The request as it was built, for the session that asked, while it is open. What the check key signs. */
  openRequest(sessionId: string, requestId: string): ChangeRequest | null {
    const p = this.pending.get(requestId);
    if (!p || p.sessionId !== sessionId || p.confirmed || this.now() >= p.expires_at) return null;
    const { sessionId: _s, confirmed: _c, via: _v, ...pub } = p;
    return pub;
  }

  /** The person confirmed this request (after the password, or after the check key, in the route). False if unknown, expired or not theirs. */
  confirm(sessionId: string, requestId: string, via: 'password' | 'check' = 'password'): boolean {
    const p = this.pending.get(requestId);
    if (!p || p.sessionId !== sessionId || this.now() >= p.expires_at) return false;
    p.confirmed = true;
    p.via = via;
    return true;
  }

  /**
   * True once, for the exact change, from the session that asked, within the
   * time limit. The request is spent whether or not it fits.
   */
  consume(sessionId: string | null, requestId: string | undefined, kind: ChangeKind, name: string, change: unknown): boolean {
    if (!requestId) return false;
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    return Boolean(sessionId) && p.confirmed && p.sessionId === sessionId && p.kind === kind
      && p.change_hash === changeHash(kind, name, change) && this.now() < p.expires_at
      && (p.via === 'check' || !this.checkRequired());
  }

  clear(): void {
    this.pending.clear();
  }
}

/**
 * What a route asks before it replaces or removes a stored login. On a vault
 * without a password it is always yes (today's behaviour). With one, it is yes
 * only for a confirmation that fits this exact change.
 */
export interface LoginChangeGate {
  allow(req: Request, kind: ChangeKind, name: string, change: unknown): boolean;
}

export function createLoginChangeGate(vault: Vault, sessions: PageSessions, confirmations: ChangeConfirmations): LoginChangeGate {
  return {
    allow(req, kind, name, change) {
      if (!vault.hasPassword()) return true;
      const header = req.headers[CONFIRMATION_HEADER];
      const given = typeof header === 'string' ? header : undefined;
      const sessionId = sessions.idOf(parseCookie(req.headers.cookie, SESSION_COOKIE));
      return confirmations.consume(sessionId, given, kind, name, change);
    },
  };
}

/** A gate for a vault that needs one but has none wired: refuses every change. */
export const refusingGate: LoginChangeGate = { allow: () => false };

/** The body of the 403 a refused change gets. */
export function confirmationRequired(kind: ChangeKind, name: string) {
  return { error: 'confirmation_required', code: 'confirmation_required', message: 'Confirmation needed.', kind, name };
}
