/**
 * Vault — encrypted credential and service storage (AES-256-GCM).
 *
 * All secrets are encrypted at rest using a key derived from the user's API key
 * via PBKDF2. The vault key is held in memory only while the session is active.
 */

import { createHash, pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface EncryptedBlob {
  iv: string;       // hex
  ciphertext: string; // hex
  tag: string;       // hex
}

export interface ServiceDef {
  id: string;
  name: string;
  description: string;
  icon?: string;
  tools?: string[];
  profile?: string;
  credFields: Array<{ label: string; key: string; type: 'text' | 'password'; placeholder?: string }>;
  encryptedFields?: EncryptedBlob;
}

interface VaultFile {
  version: 1;
  salt?: string; // hex — random PBKDF2 salt (generated on first login)
  credentials: Record<string, EncryptedBlob>;
}

interface ServicesFile {
  version: 1;
  services: Record<string, ServiceDef>;
}

export class Vault {
  private vaultKey: Buffer | null = null;
  private apiKeyHash: string | null = null;
  private spSessionCookie: string | null = null;
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
  }

  // ─── Key management ─────────────────────────────────────────────────────

  deriveAndSetKey(apiKey: string): void {
    // Use a random salt stored in vault.enc.json (created on first login)
    const vaultData = this.readVaultFile();
    let salt: string;
    if (vaultData.salt) {
      salt = vaultData.salt;
    } else {
      salt = randomBytes(32).toString('hex');
      vaultData.salt = salt;
      this.writeVaultFile(vaultData);
    }
    this.vaultKey = pbkdf2Sync(apiKey, Buffer.from(salt, 'hex'), 100_000, 32, 'sha256');
    this.apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
  }

  validateApiKey(apiKey: string): boolean {
    if (!this.apiKeyHash) return false;
    const hash = createHash('sha256').update(apiKey).digest('hex');
    // Constant-time comparison to prevent timing attacks
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(this.apiKeyHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  clearKey(): void {
    this.vaultKey = null;
    this.apiKeyHash = null;
    this.spSessionCookie = null;
  }

  /**
   * Check if the vault was created by a different API key.
   * Tries to decrypt the first credential — if it fails, keys don't match.
   * Returns true if the vault belongs to a different user (or is empty).
   */
  isVaultFromDifferentKey(): boolean {
    const data = this.readVaultFile();
    const credKeys = Object.keys(data.credentials);
    if (credKeys.length === 0) return false; // empty vault, no conflict
    try {
      this.decrypt(data.credentials[credKeys[0]]);
      return false; // decryption succeeded, same key
    } catch {
      return true; // decryption failed, different key
    }
  }

  /**
   * Wipe all vault data — credentials, services, and salt.
   * Used when a different user logs in on the same gateway.
   */
  wipe(): void {
    this.writeVaultFile({ version: 1, credentials: {} });
    this.writeServicesFile({ version: 1, services: {} });
    this.clearKey();
  }

  isUnlocked(): boolean {
    return this.vaultKey !== null;
  }

  getVaultKeyHex(): string {
    if (!this.vaultKey) throw new Error('Vault is locked');
    return this.vaultKey.toString('hex');
  }

  // ─── SP session cookie (server-side only) ───────────────────────────────

  setSpCookie(cookie: string): void {
    this.spSessionCookie = cookie;
  }

  getSpCookie(): string | null {
    return this.spSessionCookie;
  }

  // ─── Encryption primitives ──────────────────────────────────────────────

  encrypt(plaintext: string): EncryptedBlob {
    if (!this.vaultKey) throw new Error('Vault is locked');
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

  decrypt(blob: EncryptedBlob): string {
    if (!this.vaultKey) throw new Error('Vault is locked');
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

  // ─── Credential CRUD (vault.enc.json) ───────────────────────────────────

  setCredential(name: string, fields: Record<string, string>): void {
    const data = this.readVaultFile();
    data.credentials[name] = this.encrypt(JSON.stringify(fields));
    this.writeVaultFile(data);
  }

  getCredential(name: string): Record<string, string> | null {
    const data = this.readVaultFile();
    const blob = data.credentials[name];
    if (!blob) return null;
    return JSON.parse(this.decrypt(blob));
  }

  deleteCredential(name: string): void {
    const data = this.readVaultFile();
    delete data.credentials[name];
    this.writeVaultFile(data);
  }

  listCredentials(): string[] {
    const data = this.readVaultFile();
    return Object.keys(data.credentials);
  }

  // ─── Service CRUD (services.enc.json) ───────────────────────────────────

  setService(id: string, def: ServiceDef): void {
    const data = this.readServicesFile();
    data.services[id] = def;
    this.writeServicesFile(data);
  }

  getService(id: string): ServiceDef | null {
    const data = this.readServicesFile();
    return data.services[id] ?? null;
  }

  listServices(): ServiceDef[] {
    const data = this.readServicesFile();
    return Object.values(data.services);
  }

  deleteService(id: string): void {
    const data = this.readServicesFile();
    delete data.services[id];
    this.writeServicesFile(data);
  }

  // ─── File I/O helpers ───────────────────────────────────────────────────

  private get vaultFilePath(): string {
    return join(this.dataDir, 'vault.enc.json');
  }

  private get servicesFilePath(): string {
    return join(this.dataDir, 'services.enc.json');
  }

  private readVaultFile(): VaultFile {
    if (!existsSync(this.vaultFilePath)) {
      return { version: 1, credentials: {} };
    }
    try {
      return JSON.parse(readFileSync(this.vaultFilePath, 'utf-8'));
    } catch {
      return { version: 1, credentials: {} };
    }
  }

  private writeVaultFile(data: VaultFile): void {
    mkdirSync(dirname(this.vaultFilePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.vaultFilePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  private readServicesFile(): ServicesFile {
    if (!existsSync(this.servicesFilePath)) {
      return { version: 1, services: {} };
    }
    try {
      return JSON.parse(readFileSync(this.servicesFilePath, 'utf-8'));
    } catch {
      return { version: 1, services: {} };
    }
  }

  private writeServicesFile(data: ServicesFile): void {
    mkdirSync(dirname(this.servicesFilePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.servicesFilePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }
}
