/**
 * Denial-log reader (control-plane side). The MCP server's read path WRITES
 * `denials.enc.json`; the control-plane READS it (with the vault key it already
 * holds) to serve the "Recent blocks" UI. See doc/read-denial-recording.md §4.
 *
 * Same encryption scheme both sides (AES-256-GCM, {iv,ciphertext,tag}) so the
 * control-plane Vault's `decrypt` reads what the MCP server's DenialLog wrote.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DenialRecordView {
  ts: number;
  tool: string;
  integrationId: string;
  profile: string | null;
  reason: string;
  detail: string;
  target?: string;
}

export interface EncBlob { iv: string; ciphertext: string; tag: string }

/** Load raw denial records from the data dir. Missing file ⇒ []. Newest-order NOT applied here. */
export function loadDenials(dataDir: string, decrypt: (blob: EncBlob) => string): DenialRecordView[] {
  const encPath = join(dataDir, 'denials.enc.json');
  const plainPath = join(dataDir, 'denials.json');
  if (existsSync(encPath)) {
    const { blob } = JSON.parse(readFileSync(encPath, 'utf-8')) as { blob: EncBlob };
    return (JSON.parse(decrypt(blob)) as { records?: DenialRecordView[] }).records ?? [];
  }
  if (existsSync(plainPath)) {
    return (JSON.parse(readFileSync(plainPath, 'utf-8')) as { records?: DenialRecordView[] }).records ?? [];
  }
  return [];
}

/**
 * Retention, applied on READ. The MCP server's DenialLog prunes to the same
 * window, but only when it writes a new denial — so with no new blocks, old
 * records stayed on disk and on the dashboard indefinitely (a 54-day-old block
 * under "Recent blocks"). Filtering here makes the window hold regardless.
 * Keep equal to MAX_AGE_MS in apps/mcp-server/src/lib/denial-log.ts.
 */
export const DENIAL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Newest-first, never older than DENIAL_MAX_AGE_MS, optional `since` (ms) and
 * `limit`. Returns the full count before limiting. `now` is injectable for tests.
 */
export function selectDenials(
  records: DenialRecordView[],
  opts: { since?: number; limit?: number; now?: number } = {},
): { count: number; records: DenialRecordView[] } {
  const cutoff = (opts.now ?? Date.now()) - DENIAL_MAX_AGE_MS;
  let out = records.filter(r => r.ts >= cutoff).sort((a, b) => b.ts - a.ts);
  if (opts.since !== undefined && Number.isFinite(opts.since)) out = out.filter(r => r.ts >= opts.since!);
  const count = out.length;
  if (opts.limit !== undefined && Number.isFinite(opts.limit) && opts.limit > 0) out = out.slice(0, opts.limit);
  return { count, records: out };
}
