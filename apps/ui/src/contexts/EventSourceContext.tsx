/**
 * EventSourceContext — shared SSE connection for the gateway UI.
 *
 * Opens exactly one EventSource per session at /events (proxied to the
 * control plane). All components subscribe via useSSEEvent() rather than
 * opening their own connections.
 *
 * The provider is mounted inside AuthProvider. It opens the connection as
 * soon as the user object is truthy and closes it on logout.
 *
 * Design notes:
 *  - EventSource reconnects automatically on network drop (browser built-in).
 *  - `connected` tracks whether the most recent connection attempt succeeded
 *    (last open/error state). Exposed for a future status indicator.
 *  - No cross-tab coordination: single-gateway assumption means one tab per user.
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { useAuth } from './AuthContext';
import { spClient } from '../lib/sp-client';

// ─── Event types (must mirror apps/control-plane/src/lib/event-bus.ts) ───────

export type SSEEventType =
  | 'integration-changed'
  | 'attestation-changed'
  | 'proposal-added'
  | 'proposal-resolved'
  | 'team-membership-changed'
  | 'action-approval-needed'
  | 'action-resolved'
  | 'proposal-approved'
  | 'proposal-rejected'
  | 'session-locked';

// ─── Context value ────────────────────────────────────────────────────────────

interface EventSourceContextValue {
  /** True when the EventSource is open and receiving events. */
  connected: boolean;
  /**
   * Register a typed listener for a specific event type.
   * Returns an unregister function. You should use the useSSEEvent() hook
   * instead of calling this directly.
   */
  addListener: (type: SSEEventType, handler: (payload: unknown) => void) => () => void;
}

const EventSourceContext = createContext<EventSourceContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function EventSourceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const esRef = useRef<EventSource | null>(null);
  const [connected, setConnected] = useState(false);

  // Per-type listener registry. Using a Map<type, Set<handler>> so we can
  // add/remove individual handlers without re-creating the EventSource.
  const listenersRef = useRef<Map<SSEEventType, Set<(payload: unknown) => void>>>(new Map());

  const addListener = useCallback(
    (type: SSEEventType, handler: (payload: unknown) => void): (() => void) => {
      const registry = listenersRef.current;
      if (!registry.has(type)) registry.set(type, new Set());
      registry.get(type)!.add(handler);
      return () => {
        registry.get(type)?.delete(handler);
      };
    },
    [],
  );

  useEffect(() => {
    if (!user) {
      // Not logged in — close any open connection.
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
        setConnected(false);
      }
      return;
    }

    // Already open — nothing to do.
    if (esRef.current) return;

    // Native EventSource cannot send custom headers, so the API key has to
    // ride in the URL. The control plane's /events route accepts ?key= as an
    // alternative to the X-API-Key header (only on this route).
    const apiKey = spClient.getApiKey();
    if (!apiKey) return; // not yet logged in (race with auth state propagation)
    const es = new EventSource(`/events?key=${encodeURIComponent(apiKey)}`);
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    // Register a listener for each known event type.
    const eventTypes: SSEEventType[] = [
      'integration-changed',
      'attestation-changed',
      'proposal-added',
      'proposal-resolved',
      'team-membership-changed',
      'action-approval-needed',
      'action-resolved',
      'proposal-approved',
      'proposal-rejected',
      'session-locked',
    ];

    for (const type of eventTypes) {
      es.addEventListener(type, (e: MessageEvent) => {
        let payload: unknown;
        try {
          payload = JSON.parse((e as MessageEvent).data);
        } catch {
          payload = null;
        }
        const handlers = listenersRef.current.get(type);
        if (handlers) {
          for (const handler of handlers) {
            try {
              handler(payload);
            } catch (err) {
              console.error(`[EventSource] handler for "${type}" threw:`, err);
            }
          }
        }
      });
    }

    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [user]);

  return (
    <EventSourceContext.Provider value={{ connected, addListener }}>
      {children}
    </EventSourceContext.Provider>
  );
}

// ─── useSSEEvent hook ─────────────────────────────────────────────────────────

/**
 * Subscribe to a specific SSE event type.
 *
 * @param type   - The SSE event type to listen for.
 * @param handler - Called each time the event arrives. Stable reference
 *                  preferred but the hook re-registers on every render change.
 *
 * Example:
 *   useSSEEvent('proposal-added', () => refresh());
 */
export function useSSEEvent(
  type: SSEEventType,
  handler: (payload: unknown) => void,
): void {
  const ctx = useContext(EventSourceContext);
  // Graceful no-op when rendered outside the provider (e.g., Storybook / tests).
  if (!ctx) return;

  const { addListener } = ctx;

  useEffect(() => {
    return addListener(type, handler);
    // Re-register when type or handler identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, handler, addListener]);
}

// ─── useSSEConnected ──────────────────────────────────────────────────────────

/** Returns true when the SSE stream is open. Useful for a connection badge. */
export function useSSEConnected(): boolean {
  const ctx = useContext(EventSourceContext);
  return ctx?.connected ?? false;
}
