/**
 * Retry the revoke of replaced mandates until the Authority Server confirms it.
 *
 * mandate-ceremony.ts records an old mandate on the MCP server's replaced list
 * as soon as its replacement is delivered (it is no longer honoured on this
 * gateway from then on) and tries the revoke once. When that fails the record
 * stays, and this loop tries again with a growing pause: 1 minute after the
 * first failure, then 2, 4, 8 … at most 1 hour. The record lives on the MCP
 * server's disk, so a restart of either process loses nothing.
 *
 * Without an AS session (signed out, locked) nothing is attempted and nothing
 * is counted: the next tick after sign-in tries again.
 */
import { revokeReplaced, type CeremonyDeps } from './mandate-ceremony';
import type { ReplacedMandateEntry } from './mcp-bridge';

export interface RetryDeps {
  as: CeremonyDeps['as'];
  /** Whether an AS session exists now (vault unlocked and signed in). */
  signedIn: () => boolean;
  list: () => Promise<ReplacedMandateEntry[]>;
  noteAttempt: (authorizationId: string, error?: string) => Promise<void>;
  clear: (authorizationId: string) => Promise<void>;
  resyncGates?: () => Promise<unknown>;
}

const MINUTE = 60_000;
const MAX_PAUSE = 60 * MINUTE;

/** The pause before the next attempt, after `attempts` attempts so far. */
export function pauseAfter(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(MINUTE * 2 ** (attempts - 1), MAX_PAUSE);
}

/** Whether the entry is due for another attempt at `now`. */
export function isDue(e: ReplacedMandateEntry, now: number): boolean {
  if (e.attempts <= 0 || e.lastAttemptAt === undefined) return true;
  return now - e.lastAttemptAt >= pauseAfter(e.attempts);
}

/**
 * One pass: try every due revoke once. Returns how many went through. A revoke
 * the AS confirms (or reports as already revoked) clears the record.
 */
export async function retryReplacedRevokes(deps: RetryDeps, now = Date.now(), force = false): Promise<{ revoked: string[]; failed: string[] }> {
  const revoked: string[] = [];
  const failed: string[] = [];
  if (!deps.signedIn()) return { revoked, failed };
  let entries: ReplacedMandateEntry[];
  try {
    entries = await deps.list();
  } catch {
    return { revoked, failed };
  }
  for (const e of entries) {
    if (!force && !isDue(e, now)) continue;
    const error = await revokeReplaced(e.authorizationId, e.replacedBy, deps);
    if (error) {
      await deps.noteAttempt(e.authorizationId, error).catch(() => {});
      failed.push(e.authorizationId);
    } else {
      await deps.clear(e.authorizationId).catch(() => {});
      revoked.push(e.authorizationId);
    }
  }
  if (revoked.length > 0) void deps.resyncGates?.().catch(() => {});
  return { revoked, failed };
}

/** Run {@link retryReplacedRevokes} every minute; the timer never holds the process open. */
export function startReplacedRevokeRetry(deps: RetryDeps, everyMs = MINUTE): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void retryReplacedRevokes(deps).finally(() => { running = false; });
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
