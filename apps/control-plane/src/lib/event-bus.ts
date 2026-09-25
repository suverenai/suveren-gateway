/**
 * In-process EventBus for gateway server-sent-events.
 *
 * Single shared instance (eventBus) — safe under the single-gateway-per-user
 * assumption. No cross-process or cross-user coordination needed.
 *
 * EventType is the authoritative list; the SSE route and all emitters must use
 * values from this union. Phase-6 types (action-approval-needed, action-resolved)
 * are registered here now so the SSE contract is stable before Phase 6 ships.
 */

export type EventType =
  | 'integration-changed'
  | 'attestation-changed'
  | 'proposal-added'
  | 'proposal-resolved'
  | 'team-membership-changed'
  | 'action-approval-needed'   // Phase 6
  | 'action-resolved'          // Phase 6
  | 'proposal-approved'        // Phase 6: one approver signed off (not yet committed)
  | 'proposal-rejected'        // Phase 6: one approver rejected
  | 'session-locked';          // The AS session ended (expiry or revocation) — gateway just locked

export interface BusEvent {
  type: EventType;
  payload?: unknown;
}

type Handler = (event: BusEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Handler>();

  /**
   * Subscribe to all bus events.
   * Returns an unsubscribe function — callers MUST call it on disconnect / unmount
   * to avoid listener leaks.
   */
  subscribe(handler: Handler): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  emit(type: EventType, payload?: unknown): void {
    const event: BusEvent = { type, payload };
    for (const handler of this.listeners) {
      try {
        handler(event);
      } catch (err) {
        // A misbehaving subscriber must not prevent other subscribers from
        // receiving the event.
        console.error('[EventBus] subscriber threw:', err);
      }
    }
  }

  /** How many listeners are currently subscribed. Useful for tests and health checks. */
  get listenerCount(): number {
    return this.listeners.size;
  }
}

/** Shared singleton — import and use from anywhere in the control-plane process. */
export const eventBus = new EventBus();
