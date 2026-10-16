/**
 * "Last seen Tickets at" — `~/.suveren/tickets-seen.json` (UI spec §12.3).
 *
 * A display flag, nothing more (same shape of claim as archived-mandates-
 * store.ts): it only changes what the Tickets page and the dashboard's "Done automatically" column
 * consider "new" here. It never deletes or alters a ticket.
 *
 * Owner-keyed: this gateway has exactly one operator identity per vault (see
 * middleware/auth.ts — a single API key, no multi-user accounts), so unlike
 * a multi-tenant store there is nothing to key the file by. Mirrors
 * archived-mandates-store.ts one-for-one otherwise: reads are forgiving
 * (missing/corrupt file → 0, i.e. "never seen" — the safe direction, since it
 * only ever widens what counts as new, never hides a real ticket); writes
 * are strict and atomic (write-then-rename, so a crash mid-write never
 * leaves a truncated file).
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

function storePath(dataDir?: string): string {
  const dir = dataDir ?? process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
  return join(dir, 'tickets-seen.json');
}

/** 0 ⇒ never seen (every ticket ever issued counts as new). */
export function readLastSeenTicketsAt(dataDir?: string): number {
  try {
    const raw = JSON.parse(readFileSync(storePath(dataDir), 'utf8')) as { lastSeenTicketsAt?: unknown };
    return typeof raw.lastSeenTicketsAt === 'number' && Number.isFinite(raw.lastSeenTicketsAt)
      ? raw.lastSeenTicketsAt
      : 0;
  } catch {
    return 0;
  }
}

/** Persists `ts` as the new cutoff and returns it (so the route echoes
 * persisted truth, not the request). Invalid input falls back to now. */
export function markTicketsSeen(ts: number, dataDir?: string): number {
  const safeTs = typeof ts === 'number' && Number.isFinite(ts) ? ts : Date.now();
  const path = storePath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename so a crash mid-write never leaves a truncated file.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ lastSeenTicketsAt: safeTs }, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
  return safeTs;
}
