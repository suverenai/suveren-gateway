/**
 * Report Store — durable local custody of the ONE current evidence-backed
 * report (work-plan "evidence-backed reports", step R5 — gateway frame half).
 *
 * Mirrors the GateStore/ReceiptArchive pattern exactly: plaintext until the
 * vault key arrives, then AES-256-GCM encrypted, with migration on
 * `setVaultKey()`. One report, always replaced — never a history (plan:
 * "one current report, stored encrypted ... replaced with each new test run").
 *
 * This module does NOT know how to verify a report — it is handed a
 * `ReportSources` (receipt archive + connector export runner) and calls
 * `verifyReport` from `verify-report.ts` exactly once per `saveReport()` /
 * `recheck()` call, so the stored `result` is always the actual output of
 * THAT run, never recomputed implicitly on read. `getReport()` returns
 * exactly what was last checked — "UI must reflect backend truth" extends to
 * "the store must reflect the last check it actually ran", not a live
 * re-verification hidden inside a getter.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { verifyReport } from './verify-report';
import type { ReportSources, VerifyReportResult } from './types';

export interface StoredReport {
  /** The AI's HTML, sanitized (verify-report's own sanitize pass) — the raw
   *  material the renderer draws verified elements into. Never the AI's
   *  original unsanitized bytes. */
  html: string;
  /** When this report was (re)written by the AI's save-report tool. */
  savedAt: number;
  /** When `result` was last computed — equal to `savedAt` right after a
   *  save, later than it after a `recheck()`. */
  checkedAt: number;
  result: VerifyReportResult;
}

interface ReportFile {
  version: 1;
  report: StoredReport | null;
}

interface EncryptedBlob {
  iv: string;
  ciphertext: string;
  tag: string;
}

interface EncryptedReportFile {
  version: 1;
  blob: EncryptedBlob;
}

const DEFAULT_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');

export class ReportStore {
  private report: StoredReport | null = null;
  private baseDir: string;
  private vaultKey: Buffer | null = null;

  constructor(filePath?: string) {
    if (filePath && filePath.endsWith('.json')) {
      this.baseDir = dirname(filePath);
    } else {
      this.baseDir = filePath ?? DEFAULT_DIR;
    }
    this.loadPlaintext();
  }

  /** Set the vault key for encryption. Triggers migration from plaintext if needed. */
  setVaultKey(key: Buffer): void {
    this.vaultKey = key;

    if (existsSync(this.encryptedFilePath)) {
      this.loadEncrypted();
    } else if (this.report !== null) {
      this.persistEncrypted();
      if (existsSync(this.plaintextFilePath)) {
        try { unlinkSync(this.plaintextFilePath); } catch { /* ignore */ }
      }
    }
  }

  /**
   * True when encrypted evidence exists on disk that this process cannot
   * read yet (no vault key). Callers MUST NOT present the store as "no
   * report yet" in this state — that would claim a different fact than
   * "the report exists but is locked".
   */
  isLocked(): boolean {
    return this.vaultKey === null && existsSync(this.encryptedFilePath);
  }

  /** The stored, already-verified report — or null if none has been saved
   *  (and the store is not locked; check `isLocked()` first). */
  getReport(): StoredReport | null {
    return this.report;
  }

  /**
   * Replace the current report with `html`, verifying it ONCE against
   * `sources` before storing. Always replaces — there is only ever one
   * current report (plan decision).
   */
  async saveReport(html: string, sources: ReportSources, now: number = Math.floor(Date.now() / 1000)): Promise<StoredReport> {
    const result = await verifyReport(html, sources);
    this.report = { html: result.html, savedAt: now, checkedAt: now, result };
    this.persist();
    return this.report;
  }

  /**
   * Re-run verification against the CURRENTLY stored report's html — "Check
   * again" in the UI. Does not change `savedAt` (the AI did not rewrite
   * anything); only `checkedAt` and `result` move. Returns null if there is
   * no report to recheck.
   */
  async recheck(sources: ReportSources, now: number = Math.floor(Date.now() / 1000)): Promise<StoredReport | null> {
    if (!this.report) return null;
    const result = await verifyReport(this.report.html, sources);
    this.report = { ...this.report, checkedAt: now, result };
    this.persist();
    return this.report;
  }

  // ─── Encryption helpers ─────────────────────────────────────────────────

  private encrypt(plaintext: string): EncryptedBlob {
    if (!this.vaultKey) throw new Error('No vault key');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.vaultKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { iv: iv.toString('hex'), ciphertext: encrypted.toString('hex'), tag: tag.toString('hex') };
  }

  private decrypt(blob: EncryptedBlob): string {
    if (!this.vaultKey) throw new Error('No vault key');
    const decipher = createDecipheriv('aes-256-gcm', this.vaultKey, Buffer.from(blob.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
  }

  // ─── File paths ─────────────────────────────────────────────────────────

  private get plaintextFilePath(): string {
    return join(this.baseDir, 'report.json');
  }

  private get encryptedFilePath(): string {
    return join(this.baseDir, 'report.enc.json');
  }

  // ─── Load / Persist ─────────────────────────────────────────────────────

  private loadPlaintext(): void {
    if (!existsSync(this.plaintextFilePath)) {
      mkdirSync(this.baseDir, { recursive: true });
      return;
    }
    try {
      const raw = readFileSync(this.plaintextFilePath, 'utf-8');
      const parsed: ReportFile = JSON.parse(raw);
      this.report = parsed.report ?? null;
    } catch {
      console.error(`[ReportStore] Could not parse ${this.plaintextFilePath} — preserving as .corrupt`);
      try {
        writeFileSync(`${this.plaintextFilePath}.corrupt-${Date.now()}`, readFileSync(this.plaintextFilePath));
      } catch { /* best effort */ }
      this.report = null;
    }
  }

  private loadEncrypted(): void {
    if (!existsSync(this.encryptedFilePath)) return;
    try {
      const raw = readFileSync(this.encryptedFilePath, 'utf-8');
      const data: EncryptedReportFile = JSON.parse(raw);
      const decrypted = this.decrypt(data.blob);
      const parsed: ReportFile = JSON.parse(decrypted);
      this.report = parsed.report ?? null;
    } catch (err) {
      console.error(`[ReportStore] Could not decrypt ${this.encryptedFilePath} — preserving as .corrupt:`, err);
      try {
        writeFileSync(`${this.encryptedFilePath}.corrupt-${Date.now()}`, readFileSync(this.encryptedFilePath));
      } catch { /* best effort */ }
      this.report = null;
    }
  }

  private persist(): void {
    if (this.vaultKey) {
      this.persistEncrypted();
    } else {
      this.persistPlaintext();
    }
  }

  private persistPlaintext(): void {
    const data: ReportFile = { version: 1, report: this.report };
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.plaintextFilePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  private persistEncrypted(): void {
    const data: EncryptedReportFile = {
      version: 1,
      blob: this.encrypt(JSON.stringify({ version: 1, report: this.report } satisfies ReportFile)),
    };
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.encryptedFilePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }
}
