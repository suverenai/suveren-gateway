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
import { spClient, sessionEvents, SESSION_GONE_EVENT, type SessionGoneDetail } from '../lib/sp-client';
import { SseParser } from '../lib/sse-parse';

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
  | 'session-locked'
  | 'execution-failed'
  | 'denial-recorded'
  | 'ticket-recorded'
  | 'report-written'
  | 'identity-reset-pending'
  | 'identity-reset-cleared';

/**
 * Every type the EventSource registers a browser listener for — built from a
 * `Record<SSEEventType, true>` so TypeScript itself refuses to compile if a
 * union member is ever added here without a matching key (or vice versa).
 * That is precisely the bug class this exists to catch: a new SSEEventType
 * that compiles fine but is never actually subscribed to on the wire.
 */
const SSE_EVENT_TYPE_SET: Record<SSEEventType, true> = {
  'integration-changed': true,
  'attestation-changed': true,
  'proposal-added': true,
  'proposal-resolved': true,
  'team-membership-changed': true,
  'action-approval-needed': true,
  'action-resolved': true,
  'proposal-approved': true,
  'proposal-rejected': true,
  'session-locked': true,
  'execution-failed': true,
  'denial-recorded': true,
  'ticket-recorded': true,
  'report-written': true,
  'identity-reset-pending': true,
  'identity-reset-cleared': true,
};

/** Exported so a test can assert against it directly (see EventSourceContext.test.ts). */
export const SSE_EVENT_TYPES: readonly SSEEventType[] = Object.keys(SSE_EVENT_TYPE_SET) as SSEEventType[];

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
  const { user, pageSessionOpen } = useAuth();
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

    const dispatch = (type: string, raw: string) => {
      if (!(type in SSE_EVENT_TYPE_SET)) return;
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch { payload = null; }
      const handlers = listenersRef.current.get(type as SSEEventType);
      if (handlers) {
        for (const handler of handlers) {
          try { handler(payload); } catch (err) { console.error(`[EventSource] handler for "${type}" threw:`, err); }
        }
      }
    };

    // A gateway with an unlock password needs the page session's header on the stream, which EventSource cannot
    // send: the stream is read with fetch. Reconnects by itself, like EventSource, but never after the session ended.
    if (spClient.hasPageSession()) {
      const abort = new AbortController();
      let stopped = false;
      const run = async () => {
        while (!stopped) {
          try {
            const res = await spClient.openEventStream(abort.signal);
            if (res.status === 401 || res.status === 403) {
              // The gateway no longer accepts this page: say so (the sign-in screen takes over) and stop.
              setConnected(false);
              sessionEvents.dispatchEvent(new CustomEvent<SessionGoneDetail>(SESSION_GONE_EVENT, { detail: { code: 'session_missing' } }));
              return;
            }
            if (res.ok && res.body) {
              setConnected(true);
              const reader = res.body.getReader();
              const decoder = new TextDecoder();
              const parser = new SseParser();
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                for (const m of parser.push(decoder.decode(value, { stream: true }))) dispatch(m.event, m.data);
              }
            }
          } catch { /* dropped or aborted */ }
          setConnected(false);
          if (stopped) return;
          // The stream ends when the page session ends (idle, 12 hours, lock): ask once, so the reason shows.
          if (!(await spClient.sessionStillOpen())) return;
          await new Promise(r => setTimeout(r, 3000));
        }
      };
      void run();
      esRef.current = { close: () => { stopped = true; abort.abort(); } } as unknown as EventSource;
      return () => {
        stopped = true;
        abort.abort();
        esRef.current = null;
        setConnected(false);
      };
    }

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
    for (const type of SSE_EVENT_TYPES) {
      es.addEventListener(type, (e: MessageEvent) => dispatch(type, (e as MessageEvent).data));
    }

    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [user, pageSessionOpen]);

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
