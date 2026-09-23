/**
 * Archived mandates — `~/.suveren/archived-mandates.json`.
 *
 * A display flag, nothing more. Archiving hides an expired or revoked mandate
 * from the default Mandates view and from the nav badge; it deletes nothing.
 * The mandate stays on the Authority Server, and the Gatekeeper's evidence
 * archive (every signed ticket together with the signed mandate it ran under)
 * is untouched, so every ticket issued under it stays fully verifiable.
 *
 * Local to this gateway by design: it only changes what this owner sees here.
 * Which mandates MAY be archived (expired or revoked, never live authority) is
 * enforced where status is known — the UI's auth-status helper, which also
 * ignores the flag for a mandate that is live again (e.g. extended after it
 * was archived), so live authority can never be hidden by a stale flag.
 *
 * Reads are forgiving (missing or corrupt file → empty set, never a startup
 * failure); writes are strict (ids are validated, the list is de-duplicated).
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

/** authz_<uuid> today; kept permissive for older id shapes, but bounded and path-safe. */
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;

export function isValidMandateId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function storePath(dataDir?: string): string {
  const dir = dataDir ?? process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
  return join(dir, 'archived-mandates.json');
}

export function readArchived(dataDir?: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(storePath(dataDir), 'utf8')) as { archived?: unknown };
    if (!Array.isArray(raw.archived)) return [];
    return [...new Set(raw.archived.filter(isValidMandateId))];
  } catch {
    return [];
  }
}

function writeArchived(ids: string[], dataDir?: string): string[] {
  const next = [...new Set(ids.filter(isValidMandateId))].sort();
  const path = storePath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename so a crash mid-write never leaves a truncated file.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ archived: next }, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
  return next;
}

export function archiveMandate(id: string, dataDir?: string): string[] {
  if (!isValidMandateId(id)) throw new Error('invalid mandate id');
  return writeArchived([...readArchived(dataDir), id], dataDir);
}

export function unarchiveMandate(id: string, dataDir?: string): string[] {
  if (!isValidMandateId(id)) throw new Error('invalid mandate id');
  return writeArchived(readArchived(dataDir).filter(x => x !== id), dataDir);
}
