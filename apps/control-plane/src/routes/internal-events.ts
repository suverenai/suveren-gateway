/**
 * POST /internal/event — the MCP server telling the control plane that
 * something happened.
 *
 * Why this exists: the two are separate processes and the EventBus is
 * in-process. An agent creating a proposal talks to the Authority Server
 * directly, so the control plane — which owns the SSE stream, the tab badge and
 * the desktop notification — never learned that anything had happened. The
 * notification feature shipped in v0.7.0 and did nothing at all for the only
 * path that matters, because every test called the trigger directly.
 *
 * The counterpart to lib/mcp-bridge.ts, which runs the other direction
 * (CP → MCP) over the same shared secret.
 *
 * Carries a type and nothing else. Not for want of a schema — the whole
 * notification path is built on "presence, never content", and an endpoint that
 * accepts a payload today is an endpoint that leaks one later.
 */

import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { eventBus, type EventType } from '../lib/event-bus';

/**
 * Only the types that mean "a human now has something to decide". A ping is an
 * unauthenticated-by-session call from a sibling process; it does not get to
 * inject arbitrary events into the UI's stream.
 */
const ALLOWED: readonly EventType[] = ['proposal-added', 'action-approval-needed'] as const;

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!expected) return false; // never accept when no secret is configured
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, which is itself an oracle —
  // compare lengths first and keep the comparison constant-time after that.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createInternalEventsRouter(getSecret: () => string): Router {
  const router = Router();

  router.post('/event', (req, res) => {
    if (!secretMatches(req.headers['x-internal-secret'] as string | undefined, getSecret())) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const type = (req.body ?? {}).type as unknown;
    if (typeof type !== 'string' || !ALLOWED.includes(type as EventType)) {
      res.status(400).json({ error: 'Unsupported event type' });
      return;
    }

    // Emitted with NO payload — whatever the caller sent beyond `type` is
    // dropped here, and the SSE route drops payloads again on the way out.
    // Type only. Enough to answer "did the ping arrive?" during support,
    // without putting anything about the action into a log file.
    console.error(`[Control Plane] Internal event received: ${type}`);
    eventBus.emit(type as EventType);
    res.json({ ok: true });
  });

  return router;
}
