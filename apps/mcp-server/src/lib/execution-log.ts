/**
 * Execution Log — durable local storage for approved execution records.
 *
 * Mirrors the GateStore pattern: encrypted local storage with vault key support.
 * Records every approved tool execution for cumulative constraint tracking.
 *
 * Provides `sumByWindow()` for the gatekeeper to resolve cumulative fields.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ExecutionLogEntry, ExecutionLogQuery, CumulativeWindow } from '@hap/core';

interface LogFile {
  version: 1;
  entries: ExecutionLogEntry[];
}

interface EncryptedBlob {
  iv: string;
  ciphertext: string;
  tag: string;
}

interface EncryptedLogFile {
  version: 1;
  blob: EncryptedBlob;
}

const DEFAULT_DIR = process.env.HAP_DATA_DIR ?? join(homedir(), '.hap');

/** Max age for log entries — 31 days covers the longest window (monthly). */
const MAX_AGE_SECONDS = 31 * 24 * 60 * 60;

export class ExecutionLog implements ExecutionLogQuery {
  private entries: ExecutionLogEntry[] = [];
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

  /**
   * Set the vault key for encryption. Triggers migration from plaintext if needed.
   */
  setVaultKey(key: Buffer): void {
    this.vaultKey = key;

    if (existsSync(this.encryptedFilePath)) {
      this.loadEncrypted();
    } else if (this.entries.length > 0) {
      this.persistEncrypted();
      if (existsSync(this.plaintextFilePath)) {
        try { unlinkSync(this.plaintextFilePath); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Record an approved execution.
   */
  record(entry: ExecutionLogEntry): void {
    this.entries.push(entry);
    this.prune();
    this.persist();
  }

  /**
   * Sum a field's values within a time window for a given profile and path.
   *
   * @param profileId - The profile ID to filter by
   * @param path - The execution path to filter by
   * @param field - The execution field to sum ("_count" for plain counting)
   * @param window - Time window (daily, weekly, monthly)
   * @param now - Current timestamp in seconds (for testing)
   */
  sumByWindow(
    profileId: string,
    path: string,
    field: string,
    window: CumulativeWindow,
    now: number = Math.floor(Date.now() / 1000),
  ): number {
    const cutoff = windowCutoff(window, now);

    let total = 0;
    for (const entry of this.entries) {
      if (entry.profileId !== profileId) continue;
      if (entry.path !== path) continue;
      if (entry.timestamp < cutoff) continue;

      if (field === '_count') {
        total += 1;
      } else {
        const val = entry.execution[field];
        if (typeof val === 'number') {
          total += val;
        } else if (val !== undefined) {
          total += Number(val) || 0;
        }
      }
    }

    return total;
  }

  /**
   * Get all entries (for debugging/inspection).
   */
  getAll(): ExecutionLogEntry[] {
    return [...this.entries];
  }

  /**
   * Get entry count.
   */
  get size(): number {
    return this.entries.length;
  }

  // ─── Pruning ────────────────────────────────────────────────────────────

  private prune(now: number = Math.floor(Date.now() / 1000)): void {
    const cutoff = now - MAX_AGE_SECONDS;
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.timestamp >= cutoff);
    if (this.entries.length < before) {
      console.log(`[ExecutionLog] Pruned ${before - this.entries.length} expired entries`);
    }
  }

  // ─── Encryption helpers ─────────────────────────────────────────────────

  private encrypt(plaintext: string): EncryptedBlob {
    if (!this.vaultKey) throw new Error('No vault key');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.vaultKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      iv: iv.toString('hex'),
      ciphertext: encrypted.toString('hex'),
      tag: tag.toString('hex'),
    };
  }

  private decrypt(blob: EncryptedBlob): string {
    if (!this.vaultKey) throw new Error('No vault key');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.vaultKey,
      Buffer.from(blob.iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(blob.ciphertext, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  // ─── File paths ─────────────────────────────────────────────────────────

  private get plaintextFilePath(): string {
    return join(this.baseDir, 'execution-log.json');
  }

  private get encryptedFilePath(): string {
    return join(this.baseDir, 'execution-log.enc.json');
  }

  // ─── Load / Persist ─────────────────────────────────────────────────────

  private loadPlaintext(): void {
    if (!existsSync(this.plaintextFilePath)) {
      mkdirSync(this.baseDir, { recursive: true });
      return;
    }
    try {
      const raw = readFileSync(this.plaintextFilePath, 'utf-8');
      const data: LogFile = JSON.parse(raw);
      this.entries = data.entries;
      this.prune();
    } catch {
      console.error(`[ExecutionLog] Could not parse ${this.plaintextFilePath}, starting fresh`);
      this.entries = [];
    }
  }

  private loadEncrypted(): void {
    if (!existsSync(this.encryptedFilePath)) return;
    try {
      const raw = readFileSync(this.encryptedFilePath, 'utf-8');
      const data: EncryptedLogFile = JSON.parse(raw);
      const decrypted = this.decrypt(data.blob);
      const logFile: LogFile = JSON.parse(decrypted);
      this.entries = logFile.entries;
      this.prune();
    } catch (err) {
      console.error(`[ExecutionLog] Could not decrypt ${this.encryptedFilePath}:`, err);
      this.entries = [];
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
    const data: LogFile = { version: 1, entries: this.entries };
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.plaintextFilePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  private persistEncrypted(): void {
    const logFile: LogFile = { version: 1, entries: this.entries };
    const data: EncryptedLogFile = {
      version: 1,
      blob: this.encrypt(JSON.stringify(logFile)),
    };
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.encryptedFilePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function windowCutoff(window: CumulativeWindow, now: number): number {
  switch (window) {
    case 'daily':
      return now - 24 * 60 * 60;
    case 'weekly':
      return now - 7 * 24 * 60 * 60;
    case 'monthly':
      return now - 30 * 24 * 60 * 60;
  }
}
