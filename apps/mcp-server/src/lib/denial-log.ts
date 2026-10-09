/**
 * Denial Log — durable, local, encrypted record of refused tool calls. Started
 * as READ blocks only (F7.4 / the read-denial-recording design); AU2 (2026-10-09
 * work-plan) extends it to every refusal of a gated call — local Gatekeeper
 * refusals (bounds/scope/action type), Authority Server ticket refusals (by
 * canonical code), simulation-mode blocks, and "no matching mandate" — so the
 * owner can tell "a limit I set fired" from "the gateway is broken" (surfaced
 * via a control-plane endpoint + UI).
 *
 * DELIBERATELY records DENIALS ONLY — never successful calls (a full log would
 * be a correspondence/content-metadata trail). Records carry NO message/event
 * content and no action arguments: a `kind`, a human sentence, which field/
 * limit was checked and its value — never a subject, body, recipient, or
 * record content.
 *
 * `kind` discriminates the refusal:
 *  - 'read'          — a read the Gatekeeper refused (original F7.4 shape;
 *                       `reason`/`target` carry the detail, as before).
 *  - 'bound'         — a local per_transaction/enum bound, or a manifest
 *                       action_type defect, refused by this gateway.
 *  - 'scope'         — a local scope constraint (enum/subset) refused by
 *                       this gateway.
 *  - 'cumulative'     — a cumulative (daily/weekly/monthly) limit refused by
 *                       the Authority Server (local Gatekeepers never enforce
 *                       cumulative bounds — AS-only, protocol.md).
 *  - 'simulation'     — the call is refused because simulation mode is on.
 *  - 'not_authorized' — no mandate currently covers the call (no matching
 *                       grant, a mandate the AS no longer honours, or no
 *                       approver path configured).
 *
 * Absent `kind` on an older on-disk record means 'read' — every record ever
 * written before AU2 was a read block.
 *
 * Mirrors ExecutionLog: encrypted at rest with the vault key, plaintext fallback
 * until the key is set. Retention: the most recent MAX_RECORDS, and nothing
 * older than MAX_AGE_MS.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type DenialReason =
  | 'ungoverned'    // F9 — read tool declares no governance
  | 'read_gate'     // static gate (records/crm read_access) not satisfied
  | 'unset_age'     // F11 — no read-age window set on the grant
  | 'age'           // item older than the read window (post-fetch)
  | 'age_window'    // request itself reached past the window (pre-fetch refusal)
  | 'resource'      // container (calendar/…) not in the permitted set
  | 'spam'          // item in an excluded container (SPAM/TRASH)
  | 'query_unsafe'; // F8 — agent query couldn't be safely combined

/** Discriminates every refusal recorded here. See the module doc above.
 * Absent on an on-disk record ⇒ 'read' (every record predating AU2 was one). */
export type DenialKind = 'read' | 'bound' | 'scope' | 'cumulative' | 'simulation' | 'not_authorized';

/** Who made the refusal. Local Gatekeeper checks (bounds, scope, action type,
 * simulation mode, no matching mandate) are 'gateway'; cumulative bounds and
 * mandate-validity refusals the Authority Server makes at ticket time are
 * 'authority-server'. */
export type DenialWho = 'gateway' | 'authority-server';

export interface DenialRecord {
  ts: number;               // Date.now() ms at the block
  tool: string;             // provider tool name, e.g. "get_message"
  integrationId: string;
  profile: string | null;
  /** Omitted ⇒ 'read' (pre-AU2 records). */
  kind?: DenialKind;
  detail: string;           // human sentence — no content
  // kind === 'read' only (unchanged F7.4 shape):
  reason?: DenialReason;
  target?: string;          // OPTIONAL coarse target (e.g. calendar name)
  // kind !== 'read' — AU2 fields. Never content: identifiers and numbers only.
  /** The authorizationId evaluated, when a specific mandate was in play. */
  mandateId?: string;
  /** Local title for that mandate, when the gateway has one on record. */
  mandateTitle?: string;
  /** Which bound/scope field (or 'action_type') the call was checked against. */
  field?: string;
  /** The value that was checked — never the action's content, just the
   * number/token the limit compares against. */
  value?: number | string;
  /** The limit it was checked against. */
  limit?: number | string;
  who?: DenialWho;
  /** The canonical error code (hap-core Gatekeeper or Authority Server ticket
   * route) — never derived from free-text messages. */
  code?: string;
}

interface LogFile { version: 1; records: DenialRecord[]; }
interface EncryptedBlob { iv: string; ciphertext: string; tag: string; }
interface EncryptedLogFile { version: 1; blob: EncryptedBlob; }

const DEFAULT_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
const MAX_RECORDS = 200;
// Keep equal to DENIAL_MAX_AGE_MS in apps/control-plane/src/lib/denials-reader.ts,
// which applies the same window on read (this prune only runs on write).
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export class DenialLog {
  private records: DenialRecord[] = [];
  private baseDir: string;
  private vaultKey: Buffer | null = null;

  constructor(filePath?: string) {
    this.baseDir = filePath && filePath.endsWith('.json') ? dirname(filePath) : (filePath ?? DEFAULT_DIR);
    this.loadPlaintext();
  }

  setVaultKey(key: Buffer): void {
    this.vaultKey = key;
    if (existsSync(this.encryptedFilePath)) {
      this.loadEncrypted();
    } else if (this.records.length > 0) {
      this.persistEncrypted();
      if (existsSync(this.plaintextFilePath)) {
        try { unlinkSync(this.plaintextFilePath); } catch { /* ignore */ }
      }
    }
  }

  /** Record a read denial. Never throws — recording must not break the denial. */
  record(rec: DenialRecord): void {
    try {
      this.records.push(rec);
      this.prune(rec.ts);
      this.persist();
    } catch (err) {
      console.error('[DenialLog] failed to record denial:', err);
    }
  }

  /** Recent denials, newest first. `sinceMs` and `limit` are optional filters. */
  getRecent(sinceMs?: number, limit = MAX_RECORDS): DenialRecord[] {
    let out = [...this.records].sort((a, b) => b.ts - a.ts);
    if (sinceMs !== undefined) out = out.filter(r => r.ts >= sinceMs);
    return out.slice(0, limit);
  }

  get size(): number { return this.records.length; }

  // ─── Retention ────────────────────────────────────────────────────────────
  private prune(now: number): void {
    const cutoff = now - MAX_AGE_MS;
    this.records = this.records.filter(r => r.ts >= cutoff);
    if (this.records.length > MAX_RECORDS) {
      this.records = this.records.slice(this.records.length - MAX_RECORDS);
    }
  }

  // ─── Encryption (mirrors ExecutionLog) ──────────────────────────────────────
  private encrypt(plaintext: string): EncryptedBlob {
    if (!this.vaultKey) throw new Error('No vault key');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.vaultKey, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { iv: iv.toString('hex'), ciphertext: enc.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
  }

  private decrypt(blob: EncryptedBlob): string {
    if (!this.vaultKey) throw new Error('No vault key');
    const decipher = createDecipheriv('aes-256-gcm', this.vaultKey, Buffer.from(blob.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, 'hex')), decipher.final()]).toString('utf8');
  }

  private get plaintextFilePath(): string { return join(this.baseDir, 'denials.json'); }
  private get encryptedFilePath(): string { return join(this.baseDir, 'denials.enc.json'); }

  private loadPlaintext(): void {
    if (!existsSync(this.plaintextFilePath)) { mkdirSync(this.baseDir, { recursive: true }); return; }
    try {
      const data: LogFile = JSON.parse(readFileSync(this.plaintextFilePath, 'utf-8'));
      this.records = data.records ?? [];
    } catch {
      console.error(`[DenialLog] Could not parse ${this.plaintextFilePath}, starting fresh`);
      this.records = [];
    }
  }

  private loadEncrypted(): void {
    if (!existsSync(this.encryptedFilePath)) return;
    try {
      const data: EncryptedLogFile = JSON.parse(readFileSync(this.encryptedFilePath, 'utf-8'));
      const logFile: LogFile = JSON.parse(this.decrypt(data.blob));
      this.records = logFile.records ?? [];
    } catch (err) {
      console.error(`[DenialLog] Could not decrypt ${this.encryptedFilePath}:`, err);
      this.records = [];
    }
  }

  private persist(): void {
    if (this.vaultKey) this.persistEncrypted(); else this.persistPlaintext();
  }

  private persistPlaintext(): void {
    const data: LogFile = { version: 1, records: this.records };
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.plaintextFilePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  private persistEncrypted(): void {
    const logFile: LogFile = { version: 1, records: this.records };
    const data: EncryptedLogFile = { version: 1, blob: this.encrypt(JSON.stringify(logFile)) };
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.encryptedFilePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }
}
