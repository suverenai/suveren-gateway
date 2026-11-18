/**
 * Retries an unfinished move to a fresh vault key in the background, with
 * backoff, so it does not wait for the next login: while it is unfinished the
 * account key still derives a key that opens the MCP server's stores.
 *
 * It never locks the vault (only a login or an unlock counts as an attempt) and
 * never configures anything: a successful move switches the MCP server itself
 * (/internal/rekey), and a failed one changes nothing.
 */

import type { Vault, McpRekeyClient } from './vault';

export const RETRY_FIRST_MS = 30_000;
export const RETRY_MAX_MS = 10 * 60_000;

export class RekeyRetrier {
  private failures = 0;
  private nextAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly vault: Vault,
    private readonly mcp: McpRekeyClient,
    private readonly now: () => number = Date.now,
  ) {}

  /** One look: if a move is pending and its time has come, try it. Returns true if it tried. */
  async tick(): Promise<boolean> {
    if (!this.vault.isUnlocked() || !this.vault.hasPendingRekey()) { this.failures = 0; this.nextAt = 0; return false; }
    const t = this.now();
    if (t < this.nextAt) return false;
    const r = await this.vault.reconcileRekey(this.mcp, { countFailure: false });
    if (r.outcome === 'done') { this.failures = 0; this.nextAt = 0; return true; }
    this.failures++;
    this.nextAt = t + Math.min(RETRY_FIRST_MS * 2 ** (this.failures - 1), RETRY_MAX_MS);
    return true;
  }

  start(everyMs = 10_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
