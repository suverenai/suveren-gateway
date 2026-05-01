/**
 * Gate Store — durable local storage for gate content (intent).
 *
 * v0.4: single `intent` field.
 * v0.3 compat: `problem`, `objective`, `tradeoffs` still accepted and stored.
 *
 * Supports two modes:
 * - Plaintext (gates.json) — used when no vault key is set
 * - Encrypted (gates.enc.json) — used when vault key is provided
 *
 * On first load with a vault key, migrates from gates.json to gates.enc.json.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface GateContent {
  intent: string;
}

export interface GateEntry {
  frameHash: string;
  boundsHash?: string;         // v0.4
  contextHash?: string;        // v0.4
  path: string;
  profileId: string;
  gateContent: GateContent;
  context?: Record<string, string | number>;  // v0.4 context content (encrypted at rest)
  storedAt: string;
}

interface GateFile {
  version: 1;
  entries: Record<string, GateEntry>;
}

interface EncryptedBlob {
  iv: string;
  ciphertext: string;
  tag: string;
}

interface EncryptedGateFile {
  version: 1;
  entries: Record<string, EncryptedBlob>;
}

const DEFAULT_DIR = process.env.HAP_DATA_DIR ?? join(homedir(), '.hap');

export class GateStore {
  private entries = new Map<string, GateEntry>();
  private baseDir: string;
  private vaultKey: Buffer | null = null;

  constructor(filePath?: string) {
    // Accept either a directory or a legacy file path
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

    // If encrypted file exists, load from it
    if (existsSync(this.encryptedFilePath)) {
      this.loadEncrypted();
    } else if (this.entries.size > 0) {
      // Migrate existing plaintext entries to encrypted
      this.persistEncrypted();
      // Remove plaintext file after successful migration
      if (existsSync(this.plaintextFilePath)) {
        try { unlinkSync(this.plaintextFilePath); } catch { /* ignore */ }
      }
    }
  }

  set(path: string, entry: GateEntry): void {
    this.entries.set(path, entry);
    this.persist();
  }

  get(path: string): GateEntry | null {
    return this.entries.get(path) ?? null;
  }

  getAll(): GateEntry[] {
    return Array.from(this.entries.values());
  }

  delete(path: string): void {
    this.entries.delete(path);
    this.persist();
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
    return join(this.baseDir, 'gates.json');
  }

  private get encryptedFilePath(): string {
    return join(this.baseDir, 'gates.enc.json');
  }

  // ─── Load / Persist ─────────────────────────────────────────────────────

  private loadPlaintext(): void {
    if (!existsSync(this.plaintextFilePath)) {
      mkdirSync(this.baseDir, { recursive: true });
      return;
    }
    try {
      const raw = readFileSync(this.plaintextFilePath, 'utf-8');
      const data: GateFile = JSON.parse(raw);
      this.entries = new Map(Object.entries(data.entries));
    } catch {
      console.error(`[GateStore] Could not parse ${this.plaintextFilePath}, starting fresh`);
      this.entries = new Map();
    }
  }

  private loadEncrypted(): void {
    if (!existsSync(this.encryptedFilePath)) return;
    try {
      const raw = readFileSync(this.encryptedFilePath, 'utf-8');
      const data: EncryptedGateFile = JSON.parse(raw);
      this.entries = new Map();
      for (const [key, blob] of Object.entries(data.entries)) {
        const entry: GateEntry = JSON.parse(this.decrypt(blob));
        this.entries.set(key, entry);
      }
    } catch (err) {
      console.error(`[GateStore] Could not decrypt ${this.encryptedFilePath}:`, err);
      this.entries = new Map();
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
    const data: GateFile = {
      version: 1,
      entries: Object.fromEntries(this.entries),
    };
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.plaintextFilePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  private persistEncrypted(): void {
    const data: EncryptedGateFile = {
      version: 1,
      entries: {},
    };
    for (const [key, entry] of this.entries) {
      data.entries[key] = this.encrypt(JSON.stringify(entry));
    }
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.encryptedFilePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }
}
