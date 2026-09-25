/**
 * The one place that locks the gateway because the Authority Server's
 * session ended — surfaced by a 401 (from the MCP server's calls, relayed
 * over /internal/event, or from the control plane's own /api proxy), or by
 * the scheduled expiry (session-expiry-scheduler.ts) catching up when no 401
 * happened to arrive first.
 *
 * Deliberately mirrors what logout does to the vault (vault.clearKey(), here
 * via lockExpired()) and adds the two things logout does not need: pushing
 * the cleared state to the MCP server (so its OWN `spClient.isUnlocked()`
 * also flips — needed when this process, not the MCP server, is what found
 * out) and telling the human, once.
 *
 * Single-flight by construction, not by a lock/flag: `vault.isUnlocked()` is
 * read and flipped synchronously inside `lockExpired()`, and Node runs that
 * synchronous section to completion before any other caller's check can run
 * — so N callers racing here (several concurrent 401s, a 401 racing the
 * expiry timer) only ever run the side effects once.
 */
import type { Vault } from './vault';
import { eventBus } from './event-bus';
import { notify, sessionExpiredNotification } from './desktop-notify';
import { unconfigureSession } from './mcp-bridge';

export interface SessionLockDeps {
  vault: Vault;
  port: string | number;
  /** Injectable for tests — defaults to the real side effects. */
  notifyFn?: typeof notify;
  unconfigureSessionFn?: typeof unconfigureSession;
  emit?: typeof eventBus.emit;
}

/** The one-line reason relayed to the browser over SSE (payload, not the event name). */
export const SESSION_LOCKED_MESSAGE = 'Your sign-in ended after 30 days or was revoked. Sign in again.';

export function createSessionLock(deps: SessionLockDeps): () => void {
  const { vault, port } = deps;
  const notifyFn = deps.notifyFn ?? notify;
  const unconfigureSessionFn = deps.unconfigureSessionFn ?? unconfigureSession;
  const emit = deps.emit ?? eventBus.emit.bind(eventBus);

  return function lockExpiredSession(): void {
    if (!vault.isUnlocked()) return; // already locked — nothing to do (single-flight)
    vault.lockExpired();

    console.error('[Control Plane] Authority Server session ended — gateway LOCKED');

    // Best-effort — the MCP server clears its own copy synchronously on its
    // own 401 already; this covers the case where THIS process found out first.
    void unconfigureSessionFn().catch(err => {
      console.error('[Control Plane] Failed to push cleared session to MCP:', err);
    });

    emit('session-locked', { reason: 'expired', message: SESSION_LOCKED_MESSAGE });

    const { title, message, url } = sessionExpiredNotification(port);
    notifyFn(title, message, process.platform, url);
  };
}
