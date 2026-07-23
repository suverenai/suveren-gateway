/**
 * Denial Log — durable, local, encrypted record of READ blocks (F7.4 / the
 * read-denial-recording design). When the Gatekeeper refuses a read, we record
 * *that it happened* so the owner can tell "a limit I set fired" from "the
 * gateway is broken" (surfaced later via a control-plane endpoint + UI panel).
 *
 * DELIBERATELY records DENIALS ONLY — never successful reads (a full read log
 * would be a correspondence-metadata trail). Records carry NO message/event
 * content: a reason, a human sentence, and an OPTIONAL coarse target token
 * (e.g. a calendar name) — never a subject, body, address, or id.
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
  | 'age'           // item older than the read window
  | 'resource'      // container (calendar/…) not in the permitted set
  | 'spam'          // item in an excluded container (SPAM/TRASH)
  | 'query_unsafe'; // F8 — agent query couldn't be safely combined

export interface DenialRecord {
  ts: number;               // Date.now() ms at the block
  tool: string;             // provider tool name, e.g. "get_message"
  integrationId: string;
  profile: string | null;
  reason: DenialReason;
  detail: string;           // human sentence — no content
  target?: string;          // OPTIONAL coarse target (e.g. calendar name)
}

interface LogFile { version: 1; records: DenialRecord[]; }
interface EncryptedBlob { iv: string; ciphertext: string; tag: string; }
interface EncryptedLogFile { version: 1; blob: EncryptedBlob; }

const DEFAULT_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
const MAX_RECORDS = 200;
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
