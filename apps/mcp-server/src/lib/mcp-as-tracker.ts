/**
 * The MCP server's OWN record of which Authority Server URL its gate store
 * (cached mandates) currently belongs to — separate from the shared
 * `as-pairing.json` that auth.ts (control plane) owns.
 *
 * Why a separate file: the control plane and the MCP server each check for
 * an AS-URL change at their own boot, and bundle/server.js starts them
 * concurrently — either can come up first. The control plane is the sole
 * owner of `as-pairing.json` (it writes it at login and deletes it on a
 * boot-time mismatch); if the MCP server's "should I clear my gate store"
 * decision also read THAT file, whichever process booted first and deleted
 * it would leave the other with nothing to compare against, and it would
 * skip clearing stale mandates — the exact race a prior version of this
 * code had. Reading and writing this file exclusively from the MCP server
 * side means neither process's timing can affect the other's decision.
 *
 * Plaintext, like as-pairing.json — an AS URL is not a secret.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function trackerPath(dataDir: string): string {
  return join(dataDir, 'mcp-as-pairing.json');
}

/** The AS URL this process's gate store was last known to belong to, or
 *  `null` on a fresh data dir (nothing to compare against — first boot). */
export function readMcpPairedAsUrl(dataDir: string): string | null {
  const path = trackerPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as { asUrl?: unknown };
    return typeof data.asUrl === 'string' ? data.asUrl : null;
  } catch {
    return null;
  }
}

export function writeMcpPairedAsUrl(dataDir: string, asUrl: string): void {
  const path = trackerPath(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ asUrl }, null, 2), { encoding: 'utf-8', mode: 0o600 });
}
