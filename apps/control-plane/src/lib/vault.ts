/**
 * Vault — encrypted credential and service storage (AES-256-GCM).
 *
 * All secrets are encrypted at rest using a key derived from the user's API key
 * via PBKDF2. The vault key is held in memory only while the session is active.
 */

import { createHash, pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, readdirSync } from 'node:fs';
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
  /**
   * A fixed text encrypted with the vault key — written at the first unseal
   * (or the next one, for a vault from before it existed). It answers "is this
   * the key this vault was sealed with?" on its own, whether or not any
   * credential, mandate or ticket has been stored yet (see keyMatch).
   */
  verifier?: EncryptedBlob;
  credentials: Record<string, EncryptedBlob>;
}

const VERIFIER_TEXT = 'suveren-vault-verifier-v1';

/** How a candidate key relates to what is already sealed on disk. */
export type KeyMatch = 'match' | 'empty' | 'conflict';

function isBlob(v: unknown): v is EncryptedBlob {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return typeof b.iv === 'string' && typeof b.ciphertext === 'string' && typeof b.tag === 'string';
}

/** The first encrypted blob anywhere in a parsed store file, depth-first. */
function firstBlob(v: unknown, depth = 0): EncryptedBlob | null {
  if (depth > 6 || !v || typeof v !== 'object') return null;
  if (isBlob(v)) return v;
  for (const child of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) {
    const found = firstBlob(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function decryptWith(key: Buffer, blob: EncryptedBlob): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, 'hex')), decipher.final()]).toString('utf8');
}

function opens(key: Buffer, blob: EncryptedBlob): boolean {
  try { decryptWith(key, blob); return true; } catch { return false; }
}

/** A key derived but not yet in use — see Vault.deriveCandidate / adopt. */
export interface CandidateKey {
  readonly key: Buffer;
  readonly providerId: string;
  readonly apiKeyHash: string | null;
}

interface ServicesFile {
  version: 1;
  services: Record<string, ServiceDef>;
}

/** PBKDF2 parameters for every provider that derives from a passphrase-like secret. */
const KDF_ITERATIONS = 100_000;
const KDF_KEY_BYTES = 32;

/**
 * How the vault key comes into existence.
 *
 * Today there is exactly one provider: the user's API key, derived at login and
 * never persisted, so the gateway always boots LOCKED. That is the right
 * default on a laptop — nothing on disk or in the environment can unlock the
 * vault without the person.
 *
 * It is a liveness problem on a server. A container restart at 03:00 brings the
 * gateway up locked, and the agent silently cannot act until a human opens a
 * browser — true for any unattended deployment, including one a customer runs
 * in their own cloud. The fix there is a provider that derives from something
 * the machine can present (a KMS unwrap, an instance identity), which is a
 * deliberate weakening of the laptop guarantee and must be an explicit choice,
 * not a default.
 *
 * This interface exists so that choice is a new class rather than a change to
 * every call site. `deriveKey` may be async precisely because a KMS round-trip
 * is: making it sync now would force exactly the cross-cutting refactor this
 * seam is meant to avoid.
 */
export interface UnsealProvider {
  /** Stable identifier for logs and diagnostics. Never the secret itself. */
  readonly id: string;
  /**
   * Produce the 32-byte vault key from the vault's stored PBKDF2 salt, which is
   * created on first unseal and reused for the life of the vault.
   */
  deriveKey(salt: Buffer): Buffer | Promise<Buffer>;
}

/**
 * The only provider today: PBKDF2 over the user's Suveren API key. The key
 * lives in memory for the session and is never written anywhere.
 */
export class ApiKeyUnsealProvider implements UnsealProvider {
  readonly id = 'api-key';
  constructor(private readonly apiKey: string) {}

  deriveKey(salt: Buffer): Buffer {
    return pbkdf2Sync(this.apiKey, salt, KDF_ITERATIONS, KDF_KEY_BYTES, 'sha256');
  }

  /** The hash validateApiKey compares against — never the key itself. */
  hash(): string {
    return createHash('sha256').update(this.apiKey).digest('hex');
  }
}

/** Why the vault is currently locked, beyond "nobody has unlocked it yet".
 *  'expired' — the AS session ended (30-day expiry, or revoked).
 *  'as-key-mismatch' — the AS at the configured URL presented a signing key
 *    that does not match the one pinned at pairing (see as-pairing.ts).
 *  'as-tls-mismatch' — opt-in TLS pinning (`config set pin-tls on`) is
 *    enabled and a connection to the AS presented a TLS certificate whose
 *    public key does not match the one pinned at pairing (see
 *    as-tls-pin.ts). Distinct from 'as-key-mismatch': this is caught at the
 *    transport layer, before any application-level signature is even checked.
 *  'as-url-changed' — the resolved Authority Server URL differs from the one
 *    this gateway was last paired with (boot-time only; re-pairing is
 *    required — see as-config.ts / as-pairing.ts).
 *  'managed-wrong-team' — WS4 (work-plan "Added 2026-10-11 — an account is
 *    Personal OR in one team"): IT policy locks this gateway to one team
 *    (`Team`, see lib/policy.ts) and the signed-in account's active
 *    workspace is no longer that team — either it never was (refused at
 *    sign-in, see routes/auth.ts) or the account left/was removed while
 *    signed in (caught by lib/managed-team.ts's periodic check). */
export type VaultLockReason = 'expired' | 'as-key-mismatch' | 'as-tls-mismatch' | 'as-url-changed' | 'managed-wrong-team';

export class Vault {
  private vaultKey: Buffer | null = null;
  private apiKeyHash: string | null = null;
  private spSessionCookie: string | null = null;
  private unsealedBy: string | null = null;
  private dataDir: string;
  /**
   * When the AS session (captured at login into `spSessionCookie`) is due to
   * end — unix seconds, from the login response's `sessionExpiresAt`. Held in
   * memory only, exactly like the vault key and the cookie: never written to
   * disk, gone the moment the process restarts or the vault locks.
   */
  private spSessionExpiresAt: number | null = null;
  /** Who the current AS session belongs to (from the login response). Never persisted. */
  private sessionUser: { id: string; did: string } | null = null;
  /** Set by lockExpired(); cleared by any fresh unseal (a new login). */
  private lockedReason: VaultLockReason | null = null;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
  }

  // ─── Key management ─────────────────────────────────────────────────────

  /**
   * The vault's PBKDF2 salt, created on first unseal and stable thereafter.
   * Every provider derives against the same salt, so swapping providers on an
   * existing vault produces a different key — which is correct: a vault sealed
   * by one authority is not readable by another.
   */
  private ensureSalt(): Buffer {
    const vaultData = this.readVaultFile();
    if (!vaultData.salt) {
      vaultData.salt = randomBytes(32).toString('hex');
      this.writeVaultFile(vaultData);
    }
    return Buffer.from(vaultData.salt, 'hex');
  }

  /**
   * Unlock the vault using any UnsealProvider. Call sites should prefer this
   * over the API-key-specific helper below; adding an unattended provider then
   * requires no change here.
   */
  async unseal(provider: UnsealProvider): Promise<void> {
    this.adopt(await this.deriveCandidate(provider));
  }

  /**
   * Derive the key a provider would unlock with, WITHOUT using it: the vault's
   * current key, cookie and session stay exactly as they are. Sign-in derives
   * a candidate first, checks it (keyMatch), and only adopts it once it is
   * accepted — so a foreign or wrong key never ends the running session.
   */
  async deriveCandidate(provider: UnsealProvider): Promise<CandidateKey> {
    const key = await provider.deriveKey(this.ensureSalt());
    const apiKeyHash = provider instanceof ApiKeyUnsealProvider ? provider.hash() : null;
    return { key, providerId: provider.id, apiKeyHash };
  }

  /** Same as deriveCandidate, for the user's API key. */
  async deriveCandidateFromApiKey(apiKey: string): Promise<CandidateKey> {
    return this.deriveCandidate(new ApiKeyUnsealProvider(apiKey));
  }

  /**
   * Is `candidate` the key this vault's data was sealed with?
   * - 'match': yes.
   * - 'empty': nothing sealed yet, any key is fine.
   * - 'conflict': data exists that this key cannot open — another account's.
   *
   * With a verifier, it alone decides. A vault from before the verifier is
   * judged by EVERY encrypted store in the data folder (`*.enc.json`:
   * credentials, mandates, ticket archive, change ledger, reports, …), not
   * only by the first credential: a gateway with mandates and tickets but no
   * connector credential used to count as empty and switched account
   * silently, leaving that data unreadable. One store that opens is enough
   * for 'match' — after an earlier account switch, stores the old account
   * left behind may still be sealed with its key.
   */
  keyMatch(candidate: CandidateKey): KeyMatch {
    const data = this.readVaultFile();
    if (data.verifier) return opens(candidate.key, data.verifier) ? 'match' : 'conflict';
    const blobs = this.sealedSamples();
    if (blobs.length === 0) return 'empty';
    return blobs.some(b => opens(candidate.key, b)) ? 'match' : 'conflict';
  }

  /** One encrypted blob per encrypted store in the data folder. */
  private sealedSamples(): EncryptedBlob[] {
    let names: string[];
    try {
      names = readdirSync(this.dataDir).filter(n => n.endsWith('.enc.json'));
    } catch {
      return [];
    }
    const out: EncryptedBlob[] = [];
    for (const name of names.sort()) {
      try {
        const blob = firstBlob(JSON.parse(readFileSync(join(this.dataDir, name), 'utf-8')));
        if (blob) out.push(blob);
      } catch { /* unreadable file: not evidence either way */ }
    }
    return out;
  }

  /**
   * Start using a candidate key: unlock, and seal a verifier with it if the
   * vault has none yet. Call only after keyMatch said 'match' or 'empty', or
   * after a confirmed wipe — adopting over a conflict would seal the
   * verifier under the wrong key.
   */
  adopt(candidate: CandidateKey): void {
    this.vaultKey = candidate.key;
    this.unsealedBy = candidate.providerId;
    if (candidate.apiKeyHash) this.apiKeyHash = candidate.apiKeyHash;
    // A fresh unseal (a new login) means whatever locked the vault before —
    // if anything — no longer explains its current state.
    this.lockedReason = null;
    const data = this.readVaultFile();
    if (!data.verifier) {
      data.verifier = this.encrypt(VERIFIER_TEXT);
      this.writeVaultFile(data);
    }
  }

  /** True when this API key is the one that unlocked the current session. */
  isCurrentApiKey(apiKey: string): boolean {
    return this.isUnlocked() && this.validateApiKey(apiKey);
  }

  /**
   * Unlock from the user's API key. Also records the key's hash so subsequent
   * requests can be validated (see validateApiKey) — that check is specific to
   * a user-presented secret and has no meaning for a machine provider, which is
   * why it lives here rather than on the interface.
   */
  async deriveAndSetKey(apiKey: string): Promise<void> {
    await this.unseal(new ApiKeyUnsealProvider(apiKey));
  }

  /** Which provider unlocked this vault, for diagnostics. Null while locked. */
  unsealedByProvider(): string | null {
    return this.vaultKey ? this.unsealedBy : null;
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
    this.unsealedBy = null;
    this.spSessionExpiresAt = null;
    this.sessionUser = null;
    this.lockedReason = null;
  }

  /**
   * Lock because the AS session ended — a 401 surfaced it, or the scheduled
   * expiry arrived. Distinct from logout/clearKey() only in that it records
   * WHY, so the next `/health` call and the next locked-tool notice can say
   * something better than "boots locked by design" when that is not what
   * happened.
   */
  lockExpired(): void {
    this.clearKey();
    this.lockedReason = 'expired';
  }

  /** Lock because the live Authority Server key no longer matches the one
   *  pinned at pairing — see as-pairing.ts / gatekeeper.ts. Mirrors
   *  lockExpired() exactly; the only difference callers care about is WHY. */
  lockAsKeyMismatch(): void {
    this.clearKey();
    this.lockedReason = 'as-key-mismatch';
  }

  /** Lock because a pin-tls-enforced connection to the Authority Server
   *  presented a certificate whose public key doesn't match the one pinned
   *  at pairing — see as-tls-pin.ts. Mirrors lockAsKeyMismatch() exactly. */
  lockAsTlsMismatch(): void {
    this.clearKey();
    this.lockedReason = 'as-tls-mismatch';
  }

  /** Lock because this is a managed gateway (IT policy `Team`) and the
   *  signed-in account's active workspace is no longer that team — see
   *  lib/managed-team.ts. Mirrors lockAsKeyMismatch() exactly. */
  lockManagedWrongTeam(): void {
    this.clearKey();
    this.lockedReason = 'managed-wrong-team';
  }

  /**
   * Boot-time only: record that the gateway starts locked because the
   * resolved Authority Server URL differs from the one it was last paired
   * with. Deliberately does NOT call clearKey() — the vault always boots
   * locked already (nothing has been unlocked yet in this process), so there
   * is no session to end; this only attaches the reason so /health and the
   * locked-agent notice can explain it instead of defaulting to "restart".
   */
  markBootLockedAsUrlChanged(): void {
    this.lockedReason = 'as-url-changed';
  }

  /** What locked the vault, if known. `null` covers both "still unlocked"
   *  and the default boot-locked case — callers that care about the
   *  difference should check `isUnlocked()` first. */
  getLockedReason(): VaultLockReason | null {
    return this.lockedReason;
  }

  /** unix seconds the current AS session is due to end, or null (locked, or
   *  the AS didn't report one — a pre-30-day-rollout server). Never persisted. */
  setSessionExpiresAt(expiresAt: number | null): void {
    this.spSessionExpiresAt = expiresAt;
  }

  getSessionExpiresAt(): number | null {
    return this.spSessionExpiresAt;
  }

  /** The signed-in person, set at login from the AS session response; cleared with the session. */
  setSessionUser(user: { id: string; did: string } | null): void {
    this.sessionUser = user;
  }

  getSessionUser(): { id: string; did: string } | null {
    return this.sessionUser;
  }

  /**
   * Was this vault sealed by a different key than the one now unlocked?
   * Same rule as keyMatch (verifier, else every encrypted store).
   */
  isVaultFromDifferentKey(): boolean {
    if (!this.vaultKey) return false;
    return this.keyMatch({ key: this.vaultKey, providerId: this.unsealedBy ?? '', apiKeyHash: null }) === 'conflict';
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
