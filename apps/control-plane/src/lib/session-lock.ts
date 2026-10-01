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

/** Same channel, for the pinned-key mismatch case (see as-pairing.ts). */
export const AS_KEY_MISMATCH_MESSAGE =
  'The Authority Server presented a signing key that does not match the one pinned at pairing. Sign in again to review.';

/** Same channel, for the TLS pin mismatch case (see as-tls-pin.ts) — only
 *  reachable when `config set pin-tls on` is enabled. */
export const AS_TLS_MISMATCH_MESSAGE =
  'A connection to the Authority Server presented a TLS certificate that does not match the one pinned ' +
  'at pairing. The connection was refused before anything was sent. If the certificate changed ' +
  'intentionally (a new key, not just renewal), clear the pairing and sign in again to re-pin it.';

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

/**
 * Mirrors {@link createSessionLock} for the AS-key-mismatch case: the MCP
 * server's Gatekeeper found the AS's live signing key no longer matches the
 * one pinned at pairing (gatekeeper.ts) and told this process over
 * `/internal/event` (internal-events.ts). Every gated call already refuses
 * itself on this condition (attestation-cache.ts keeps throwing as long as
 * the mismatch persists); this additionally locks the whole gateway so a
 * human notices even between tool calls, instead of the agent silently
 * hitting refusals one at a time.
 */
export function createAsKeyMismatchLock(deps: SessionLockDeps): () => void {
  const { vault, port } = deps;
  const notifyFn = deps.notifyFn ?? notify;
  const unconfigureSessionFn = deps.unconfigureSessionFn ?? unconfigureSession;
  const emit = deps.emit ?? eventBus.emit.bind(eventBus);

  return function lockOnAsKeyMismatch(): void {
    if (!vault.isUnlocked()) return; // already locked — nothing to do (single-flight)
    vault.lockAsKeyMismatch();

    console.error('[Control Plane] Authority Server key mismatch — gateway LOCKED');

    void unconfigureSessionFn('as-key-mismatch').catch(err => {
      console.error('[Control Plane] Failed to push cleared session to MCP:', err);
    });

    emit('session-locked', { reason: 'as-key-mismatch', message: AS_KEY_MISMATCH_MESSAGE });

    const { title, url } = sessionExpiredNotification(port);
    notifyFn(title, AS_KEY_MISMATCH_MESSAGE, process.platform, url);
  };
}

/**
 * Mirrors {@link createAsKeyMismatchLock} for the TLS pin mismatch case
 * (as-tls-pin.ts, opt-in via `config set pin-tls on`): a connection to the
 * Authority Server — from either process — presented a certificate whose
 * public key doesn't match the one pinned at pairing. Caught at the
 * transport layer, before any application-level signature check, so this
 * can fire even for calls that never reach the Ed25519 ticket/receipt logic.
 */
export function createAsTlsMismatchLock(deps: SessionLockDeps): () => void {
  const { vault, port } = deps;
  const notifyFn = deps.notifyFn ?? notify;
  const unconfigureSessionFn = deps.unconfigureSessionFn ?? unconfigureSession;
  const emit = deps.emit ?? eventBus.emit.bind(eventBus);

  return function lockOnAsTlsMismatch(): void {
    if (!vault.isUnlocked()) return; // already locked — nothing to do (single-flight)
    vault.lockAsTlsMismatch();

    console.error('[Control Plane] Authority Server TLS pin mismatch — gateway LOCKED');

    void unconfigureSessionFn('as-tls-mismatch').catch(err => {
      console.error('[Control Plane] Failed to push cleared session to MCP:', err);
    });

    emit('session-locked', { reason: 'as-tls-mismatch', message: AS_TLS_MISMATCH_MESSAGE });

    const { title, url } = sessionExpiredNotification(port);
    notifyFn(title, AS_TLS_MISMATCH_MESSAGE, process.platform, url);
  };
}
