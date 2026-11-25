/**
 * The alarm for a pending request for a new root DID (device-keys plan 10 "New root DID",
 * DEC-21, DEC-33; step 16 on the Authority Server, step 7 of this gateway).
 *
 * Someone with the account's email link can ask for a new identity without the recovery
 * code. It takes effect after 72 hours, and every device of the old chain can cancel. The
 * Authority Server tells a device in its sign-in answer and in the chain answer
 * (`pending_identity_reset: { id, effective_at }`); this holds what it said, raises the
 * alarm once per request, and lets it end when the Authority Server stops saying it.
 *
 * What the alarm is: a banner state (read at `GET /auth/device/status`) and two doorbell
 * events on the bus (`identity-reset-pending`, `identity-reset-cleared`; the event stream
 * carries the type only, never the payload) and one desktop notification per request. It
 * is NOT a lock. Locking would take away the one thing the person needs: this computer's
 * key, to cancel. The Authority Server's word is not an authority here (the cancel is a
 * signature the Authority Server must verify); a false alarm costs a visible banner.
 *
 * Wording is the maintainer's (O19); the strings here are placeholders.
 */

import type { EventType } from './event-bus';

export interface PendingIdentityReset {
  /** The request id; what a cancel names. */
  id: string;
  /** Epoch seconds: when the new identity takes effect if nobody cancels. */
  effectiveAt: number;
}

export interface AlarmState extends PendingIdentityReset {
  /** Epoch seconds, this gateway's clock. */
  raisedAt: number;
}

/** PLACEHOLDER wording (O19). */
export const IDENTITY_RESET_NOTICE = {
  title: 'Suveren: a new identity was requested',
  message: 'Someone asked for a new identity for this account. If it was not you, cancel it in the gateway.',
};

export interface IdentityResetAlarmDeps {
  emit: (type: EventType, payload?: unknown) => void;
  /** A desktop notification, once per request id. Unset: none. */
  notify?: (title: string, message: string) => void;
  /** Epoch seconds. */
  now?: () => number;
}

export class IdentityResetAlarm {
  private current: AlarmState | null = null;
  /** Requests already announced by notification, so a renewal every hour does not repeat it. */
  private readonly notified = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly d: IdentityResetAlarmDeps) {
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** What the page shows, or null. */
  get(): AlarmState | null { return this.current; }

  /**
   * What the Authority Server said at a sign-in that was verified: the open request, or none.
   * A new id raises the alarm; the same id changes nothing; none ends it.
   */
  observe(p: PendingIdentityReset | null): void {
    if (!p) {
      if (this.current) { this.current = null; this.d.emit('identity-reset-cleared'); }
      return;
    }
    if (this.current?.id === p.id) { this.current = { ...this.current, effectiveAt: p.effectiveAt }; return; }
    this.current = { id: p.id, effectiveAt: p.effectiveAt, raisedAt: this.now() };
    this.d.emit('identity-reset-pending');
    if (!this.notified.has(p.id)) {
      this.notified.add(p.id);
      try { this.d.notify?.(IDENTITY_RESET_NOTICE.title, IDENTITY_RESET_NOTICE.message); } catch { /* a notification never breaks a sign-in */ }
    }
  }

  /** This computer cancelled the request and the Authority Server said so. */
  cancelled(id: string): void {
    if (this.current?.id === id) { this.current = null; this.d.emit('identity-reset-cleared'); }
  }

  /** The vault locked: nobody can act on it, and the next unlock's sign-in says it again. */
  forget(): void { this.current = null; }
}
