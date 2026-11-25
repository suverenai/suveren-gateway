/**
 * Replaced mandates — mandates this gateway no longer honours because the
 * person approved a replacement, even while the Authority Server still serves
 * them.
 *
 * A mandate change issues and delivers the NEW mandate first and only then
 * revokes the OLD one at the Authority Server (mandate-ceremony.ts,
 * retireReplaced): a failed delivery must never leave the person with no
 * mandate at all. Until that revoke goes through, the AS still serves the old
 * mandate. Without this store the gateway kept matching it — after a change
 * that tightened the limits, the old, wider limits still applied in full.
 *
 * The rule: once the replacement is delivered, the old id is recorded here and
 * the attestation cache treats it like a revoked mandate (never listed, never
 * matched, its local gate dropped at the next resync). The record also is the
 * revoke outbox: the control plane retries the revoke until the AS confirms it
 * and then clears the record (control-plane lib/replaced-revoke-retry.ts).
 *
 * Holds authorization ids and timestamps only — no intent, no limits — so it is
 * stored in plaintext like the other id-only files. Survives a restart.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ReplacedMandate {
  /** The old mandate's authorization id — no longer honoured on this gateway. */
  authorizationId: string;
  /** The mandate that replaced it. */
  replacedBy: string;
  /** Unix ms when the replacement was delivered. */
  since: number;
  /** Revoke attempts at the Authority Server so far (the first one included). */
  attempts: number;
  /** The last refusal or error, if the last attempt failed. */
  lastError?: string;
  /** Unix ms of the last attempt. */
  lastAttemptAt?: number;
}

interface StoreFile { version: 1; entries: ReplacedMandate[] }

const DEFAULT_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
const FILE = 'replaced-mandates.json';

export class ReplacedMandates {
  private entries = new Map<string, ReplacedMandate>();
  private readonly baseDir: string;

  constructor(path?: string) {
    this.baseDir = path && path.endsWith('.json') ? dirname(path) : (path ?? DEFAULT_DIR);
    this.load();
  }

  private get filePath(): string { return join(this.baseDir, FILE); }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<StoreFile>;
      for (const e of Array.isArray(raw.entries) ? raw.entries : []) {
        if (e && typeof e.authorizationId === 'string' && typeof e.replacedBy === 'string') {
          this.entries.set(e.authorizationId, {
            authorizationId: e.authorizationId,
            replacedBy: e.replacedBy,
            since: typeof e.since === 'number' ? e.since : Date.now(),
            attempts: typeof e.attempts === 'number' ? e.attempts : 0,
            ...(typeof e.lastError === 'string' ? { lastError: e.lastError } : {}),
            ...(typeof e.lastAttemptAt === 'number' ? { lastAttemptAt: e.lastAttemptAt } : {}),
          });
        }
      }
    } catch (err) {
      // Fail visibly, never silently forget: an unreadable file would re-open
      // old mandates. Keep the file for inspection and refuse to start clean.
      throw new Error(`replaced-mandates.json is unreadable (${err instanceof Error ? err.message : String(err)}); refusing to honour replaced mandates again`);
    }
  }

  private persist(): void {
    mkdirSync(this.baseDir, { recursive: true });
    const body: StoreFile = { version: 1, entries: [...this.entries.values()] };
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }

  /** Record that `authorizationId` was replaced by `replacedBy`. Idempotent. */
  record(authorizationId: string, replacedBy: string, now = Date.now()): ReplacedMandate {
    const existing = this.entries.get(authorizationId);
    if (existing) return existing;
    const entry: ReplacedMandate = { authorizationId, replacedBy, since: now, attempts: 0 };
    this.entries.set(authorizationId, entry);
    this.persist();
    return entry;
  }

  /** Note a revoke attempt and its outcome (error absent = it went through). */
  noteAttempt(authorizationId: string, error: string | undefined, now = Date.now()): void {
    const e = this.entries.get(authorizationId);
    if (!e) return;
    e.attempts += 1;
    e.lastAttemptAt = now;
    if (error) e.lastError = error; else delete e.lastError;
    this.persist();
  }

  /** The Authority Server confirmed the revoke: nothing is left to do. */
  clear(authorizationId: string): void {
    if (this.entries.delete(authorizationId)) this.persist();
  }

  has(authorizationId: string): boolean { return this.entries.has(authorizationId); }

  get(authorizationId: string): ReplacedMandate | null { return this.entries.get(authorizationId) ?? null; }

  list(): ReplacedMandate[] { return [...this.entries.values()]; }
}
