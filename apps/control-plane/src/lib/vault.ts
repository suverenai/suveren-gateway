/**
 * Vault — encrypted credential and service storage (AES-256-GCM).
 *
 * All secrets are encrypted at rest using a key derived from the user's API key
 * via PBKDF2. The vault key is held in memory only while the session is active.
 */

import { createHash, pbkdf2Sync, scrypt, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, readdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { rekeyDirectory, CONTROL_PLANE_FILES } from './rekey';
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
  /**
   * Present once the person has set an unlock password. The vault key is not
   * derived from the password: it is wrapped (AES-256-GCM) by a key scrypt
   * derives from the password, so changing the password re-wraps one key and
   * leaves every credential and every other store sealed as it was.
   */
  password?: PasswordHeader;
  credentials: Record<string, EncryptedBlob>;
  /**
   * Sealed values the gateway keeps for itself (the device signing key, the
   * device chain head; device-keys step 6). Kept apart from `credentials` on
   * purpose: nothing that lists, pushes or edits credentials can see, send or
   * overwrite them. Sealed with the vault key like a credential, so a move to a
   * fresh key re-seals them (lib/rekey.ts walks every blob).
   */
  slots?: Record<string, EncryptedBlob>;
  /**
   * Present once the person has enabled unlock by the computer's own lock (Touch ID;
   * DEC-38, packages/unlock-helper/DESIGN.md). A second wrap of the SAME random vault
   * key, held by the native helper. The password header stays; this never replaces it.
   */
  platform?: PlatformHeader;
}

/** The unlock-by-Touch-ID header in vault.enc.json. Nothing in it is secret: the key blob needs this computer's Secure Enclave and a touch. */
export interface PlatformHeader {
  v: 1;
  backend: string;
  policy: string;
  /** Opaque key blob of the wrap key (useless on another computer). */
  keyBlob: string;
  /** The wrap key's public half, so a re-key wraps again without a touch. */
  publicKey: string;
  /** The vault key under the wrap key (base64url). */
  wrapped: string;
  /** Part of the wrap's authenticated data, like the password wrap's. */
  accountId: string;
}

/**
 * What the vault needs from the native helper. The vault never starts a program itself:
 * lib/platform-helper.ts implements this over the helper process, tests over a fake or the
 * helper's software backend.
 */
export interface PlatformKeyService {
  /** New wrap key. No touch. */
  createWrapKey(): Promise<{ keyBlob: string; publicKey: string; policy: string; backend: string }>;
  /** Wrap the vault key to the public key. No touch. */
  wrap(a: { publicKey: string; vaultKey: Buffer; aad: string }): Promise<string>;
  /** ONE touch. Returns the vault key; the caller zeroes it. */
  unwrap(a: { keyBlob: string; wrapped: string; aad: string }): Promise<Buffer>;
}

/**
 * What turning Touch ID unlock on or off asks besides the unlock password: where this computer has a check key,
 * a fresh check over an object whose prompt text names the action (lib/platform-checks.ts). Set by the mount.
 * The vault asks it itself, so no route can skip it.
 */
export interface PlatformGate {
  hasCheckKey(): boolean;
  check(action: 'enable' | 'disable'): Promise<void>;
}

/** A refusal of the platform unlock with a neutral code (and the helper's code, when it came from there). */
export class PlatformUnlockError extends Error {
  constructor(readonly code: string, readonly helperCode?: string) {
    super(code);
    this.name = 'PlatformUnlockError';
  }
}

const PLATFORM_AAD_PREFIX = 'suveren-vault-key-platform-wrap-v1|';
const platformAad = (accountId: string): string => PLATFORM_AAD_PREFIX + accountId;
const B64U = /^[A-Za-z0-9_-]+$/;

/** A failure from the helper as a neutral code. Only the helper's code travels, never its message (which could name a path). */
function helperFailure(err: unknown): PlatformUnlockError {
  if (err instanceof PlatformUnlockError) return err;
  const e = err as { code?: unknown; helperCode?: unknown };
  const raw = typeof e?.helperCode === 'string' ? e.helperCode : e?.code;
  const code = typeof raw === 'string' ? raw : 'internal';
  return new PlatformUnlockError('helper_failed', /^[a-z_]{1,40}$/.test(code) ? code : 'internal');
}

/**
 * The third way to the vault key (after the account key and the password): the helper opens
 * the second wrap after a touch. The salt is not used: the key is not derived, it is unwrapped.
 */
export class PlatformUnsealProvider implements UnsealProvider {
  readonly id = 'platform';
  constructor(private readonly service: PlatformKeyService, private readonly header: PlatformHeader) {}

  deriveKey(_salt?: Buffer): Promise<Buffer> {
    return this.service.unwrap({ keyBlob: this.header.keyBlob, wrapped: this.header.wrapped, aad: platformAad(this.header.accountId) });
  }
}

/** The unlock-password header in vault.enc.json. Nothing in it is secret. */
export interface PasswordHeader {
  v: 1;
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;       // hex, random per wrap
  wrapped: EncryptedBlob; // the vault key (base64), sealed under the password key
  /**
   * The AS account this vault belongs to. It is part of the wrap's
   * authenticated data: removing or changing it breaks the unwrap.
   */
  accountId: string;
  /**
   * Present only while the move to a fresh vault key is not finished: the OLD
   * key, wrapped under the same password key, so a crash halfway can be
   * completed at the next unlock (lib/rekey.ts is idempotent).
   */
  pending?: EncryptedBlob;
}

/** What the control plane asks of the MCP server while the vault moves to a fresh key. */
export interface McpRekeyClient {
  /** Which key the server's stores are sealed with, as the SERVER reports it. */
  state(oldKeyHex: string, newKeyHex: string): Promise<{ sealedWith: 'old' | 'new' | 'mixed' | 'empty' }>;
  /** Re-seal and switch, in one step. Idempotent. */
  rekey(oldKeyHex: string, newKeyHex: string): Promise<void>;
}

/** The outcome of trying to finish the move, and the key (if any) the MCP server may be configured with. */
export interface RekeyOutcome {
  outcome: 'done' | 'pending' | 'locked';
  /** Null: do not configure the MCP server at all (what its stores are sealed with is not known). */
  mcpKeyHex: string | null;
}

export interface ScryptParams { N: number; r: number; p: number }

/** ~0.3 s and 128 MiB on a laptop: costly for a guesser, fine for one unlock. */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 1 << 17, r: 8, p: 1 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const WRAP_AAD_PREFIX = 'suveren-vault-key-wrap-v1|';
const wrapAad = (accountId: string): Buffer => Buffer.from(WRAP_AAD_PREFIX + accountId);

/** Parameters come from a file; refuse any that are nonsense or would exhaust memory. */
function scryptParamsOk(p: ScryptParams): boolean {
  const { N, r, p: par } = p;
  if (![N, r, par].every(Number.isInteger)) return false;
  if (N < 16 || N > 1 << 20 || (N & (N - 1)) !== 0) return false;
  if (r < 1 || r > 16 || par < 1 || par > 4) return false;
  return 128 * N * r <= SCRYPT_MAXMEM;
}

function scryptAsync(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM }, (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });
}

function wrapKey(kek: Buffer, vaultKey: Buffer, accountId: string): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  cipher.setAAD(wrapAad(accountId));
  const ct = Buffer.concat([cipher.update(vaultKey), cipher.final()]);
  return { iv: iv.toString('hex'), ciphertext: ct.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}

function unwrapKey(kek: Buffer, blob: EncryptedBlob, accountId: string): Buffer | null {
  try {
    const d = createDecipheriv('aes-256-gcm', kek, Buffer.from(blob.iv, 'hex'));
    d.setAAD(wrapAad(accountId));
    d.setAuthTag(Buffer.from(blob.tag, 'hex'));
    const key = Buffer.concat([d.update(Buffer.from(blob.ciphertext, 'hex')), d.final()]);
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
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
export type VaultLockReason = 'expired' | 'as-key-mismatch' | 'as-tls-mismatch' | 'as-url-changed' | 'managed-wrong-team' | 'rekey-incomplete';

/** Failed attempts to finish the move to a fresh vault key before the vault locks and says so. */
export const REKEY_ATTEMPTS = 3;

export class Vault {
  private vaultKey: Buffer | null = null;
  private apiKeyHash: string | null = null;
  private spSessionCookie: string | null = null;
  private unsealedBy: string | null = null;
  private dataDir: string;
  private readonly scryptParams: ScryptParams;
  private readonly deviceKeys: boolean;
  private pendingOldKey: Buffer | null = null;
  private chain: Promise<void> = Promise.resolve();
  private rekeyFailures = 0;
  private lockListeners: Array<() => void> = [];
  private platform: PlatformKeyService | null = null;
  private platformGate: PlatformGate | null = null;
  /** Counts every change of the vault key in memory (unlock, lock, re-key): a long step compares it before it writes. */
  private keyEpoch = 0;
  private platformBusy = false;
  private passwordCache: { stamp: string; has: boolean } | null = null;
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

  constructor(dataDir?: string, options?: { scrypt?: ScryptParams; deviceKeys?: boolean }) {
    this.dataDir = dataDir ?? process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
    this.scryptParams = options?.scrypt ?? DEFAULT_SCRYPT_PARAMS;
    this.deviceKeys = options?.deviceKeys ?? false;
  }

  // ─── Unlock password (PasswordUnsealProvider) ───────────────────────────
  //
  // The password never derives the vault key. A random 32-byte vault key is
  // wrapped by a scrypt key; the wrap, its parameters and the account it
  // belongs to sit in the vault header (the account id is inside the wrap's
  // authenticated data).
  //
  // Moving a vault made before passwords existed switches it to a FRESH random
  // key and re-seals everything the old key sealed (lib/rekey.ts), so the
  // account key, which still derives the old key, no longer opens anything.

  /**
   * Does this vault have an unlock password? Read from the vault file, so it
   * holds while locked. Fails CLOSED once device keys are on: a `password`
   * header that is present but invalid, or a vault file that cannot be read,
   * counts as a password vault that cannot be opened, never as "no password"
   * (which would hand the vault to the account-key and wipe-and-claim path).
   */
  hasPassword(): boolean {
    // Called on every request, so the file is only re-read when it changed.
    let stamp = '';
    try {
      const st = statSync(this.vaultFilePath);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch { /* no file: no password */ }
    if (this.passwordCache?.stamp !== stamp) {
      this.passwordCache = { stamp, has: this.passwordPresent() };
    }
    return this.passwordCache.has;
  }

  private passwordPresent(): boolean {
    if (!existsSync(this.vaultFilePath)) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.vaultFilePath, 'utf-8'));
    } catch {
      return this.deviceKeys; // unreadable: refuse, but only where this feature is on
    }
    if (!parsed || typeof parsed !== 'object') return this.deviceKeys;
    return 'password' in (parsed as Record<string, unknown>);
  }

  /** The account the password is bound to. Null when there is no valid header. */
  getPasswordAccountId(): string | null {
    return this.readPasswordHeader()?.accountId ?? null;
  }

  /** The header, or null when absent or not valid. A valid header has every field the unwrap needs. */
  private readPasswordHeader(): PasswordHeader | null {
    const h = this.readVaultFile().password;
    if (!h || h.v !== 1 || h.kdf !== 'scrypt' || !isBlob(h.wrapped) || typeof h.salt !== 'string'
      || typeof h.accountId !== 'string' || !h.accountId || (h.pending !== undefined && !isBlob(h.pending))) return null;
    return h;
  }

  /** Is the move to a fresh vault key still to be finished (after a crash or an unreachable MCP server)? */
  hasPendingRekey(): boolean {
    return this.pendingOldKey !== null;
  }

  /**
   * Run `fn` with nothing else that decides who owns the vault running: the
   * move to a password and the login's wipe-and-claim take turns.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Move an unlocked vault to a password. A fresh random vault key is wrapped
   * under the password; our own files are re-sealed with it; the MCP server is
   * moved after (`reconcileRekey`). Needs the account the vault belongs to.
   * Serialised with the login's wipe-and-claim.
   */
  setPassword(password: string, accountId: string | null | undefined, mcp?: McpRekeyClient): Promise<RekeyOutcome> {
    if (!this.vaultKey) return Promise.reject(new Error('Vault is locked'));
    if (!accountId) return Promise.reject(new Error('Account unknown'));
    return this.exclusive(async () => {
      if (!this.vaultKey) throw new Error('Vault is locked');
      if (this.hasPassword()) throw new Error('A password is already set');
      const oldKey = this.vaultKey;
      const newKey = randomBytes(32);
      await this.writePasswordWrap(password, newKey, accountId, oldKey, await this.platformAfterRekey(newKey, accountId));
      this.pendingOldKey = oldKey;
      this.vaultKey = newKey;
      this.keyEpoch++;
      this.unsealedBy = 'password';
      this.apiKeyHash = null; // nothing in this process treats the account key as a credential any more
      return this.reconcileRekey(mcp, { countFailure: false });
    });
  }

  /**
   * Finish the move, deciding what to do from what the MCP server REPORTS about
   * its stores, never from our own record of what we asked it:
   *  - sealed with the new key (an earlier request was applied, its reply lost):
   *    done; configure with the new key.
   *  - sealed with the old key: ask it to re-seal (idempotent). If that fails it
   *    still holds the old key, so the old key is the one to configure.
   *  - mixed (a run that stopped halfway): ask it to resume. If that fails,
   *    neither key reads everything: configure nothing.
   *  - cannot be determined: configure nothing.
   * Repeated failure (login and unlock count; the background retry does not)
   * locks the vault with a visible reason.
   */
  async reconcileRekey(mcp?: McpRekeyClient, opts: { countFailure?: boolean } = {}): Promise<RekeyOutcome> {
    const old = this.pendingOldKey;
    if (!this.vaultKey) return { outcome: 'pending', mcpKeyHex: null };
    if (!old) return { outcome: 'done', mcpKeyHex: this.vaultKey.toString('hex') };
    const oldHex = old.toString('hex');
    const newHex = this.vaultKey.toString('hex');
    // Our own files first: nothing of the MCP server's is touched before it confirms.
    rekeyDirectory(this.dataDir, old, this.vaultKey, { only: CONTROL_PLANE_FILES });

    let mcpKeyHex: string | null = null;
    let finished = false;
    if (!mcp) {
      finished = true;
      mcpKeyHex = newHex;
    } else {
      try {
        let st = (await mcp.state(oldHex, newHex)).sealedWith;
        if (st === 'old' || st === 'mixed' || st === 'empty') {
          try { await mcp.rekey(oldHex, newHex); } catch { /* the state below says what happened */ }
          st = (await mcp.state(oldHex, newHex)).sealedWith;
        }
        if (st === 'new' || st === 'empty') { finished = true; mcpKeyHex = newHex; }
        else if (st === 'old') mcpKeyHex = oldHex;   // still entirely on the old key: that one fits
        // 'mixed': neither key reads everything; mcpKeyHex stays null
      } catch {
        mcpKeyHex = null; // cannot be determined
      }
    }

    if (finished) {
      this.finishMarker(old);
      this.rekeyFailures = 0;
      return { outcome: 'done', mcpKeyHex };
    }
    console.error('[Vault] Moving the MCP server to the new vault key did not finish.');
    if ((opts.countFailure ?? true) && ++this.rekeyFailures >= REKEY_ATTEMPTS) {
      this.clearKey();
      this.lockedReason = 'rekey-incomplete';
      return { outcome: 'locked', mcpKeyHex: null };
    }
    return { outcome: 'pending', mcpKeyHex };
  }

  /** The move is complete: drop the marker and everything the account key could still reach. */
  private finishMarker(old: Buffer): void {
    const data = this.readVaultFile();
    if (data.password) delete data.password.pending;
    // The PBKDF2 salt only ever fed the account-key derivation, which opens nothing now.
    delete data.salt;
    this.writeVaultFile(data);
    old.fill(0);
    this.pendingOldKey = null;
  }

  /**
   * A new vault with a password from the start: a random key, wrapped. Only for
   * a vault with nothing sealed in it, otherwise the data would be unreadable.
   */
  async createWithPassword(password: string, accountId: string | null | undefined): Promise<void> {
    if (!accountId) throw new Error('Account unknown');
    if (this.hasPassword()) throw new Error('A password is already set');
    const data = this.readVaultFile();
    if (data.verifier || Object.keys(data.credentials).length > 0 || this.sealedSamples().length > 0) {
      throw new Error('Vault already holds data');
    }
    const key = randomBytes(32);
    await this.writePasswordWrap(password, key, accountId);
    this.adopt({ key, providerId: 'password', apiKeyHash: null });
  }

  /** Unlock with the password. False for a wrong password; the vault stays as it was. */
  async unlockWithPassword(password: string): Promise<boolean> {
    const opened = await this.unwrapWithPassword(password);
    if (!opened) return false;
    this.adopt({ key: opened.key, providerId: 'password', apiKeyHash: null });
    this.pendingOldKey = opened.pendingOld;
    return true;
  }

  /** Is this the password? Does not change the lock state. */
  async verifyPassword(password: string): Promise<boolean> {
    const opened = await this.unwrapWithPassword(password);
    if (!opened) return false;
    opened.key.fill(0);
    opened.pendingOld?.fill(0);
    return true;
  }

  /** Re-wrap the one vault key under a new password. Every credential stays. */
  async changePassword(currentPassword: string, newPassword: string): Promise<boolean> {
    const header = this.readPasswordHeader();
    if (!header) throw new Error('No password is set');
    const opened = await this.unwrapWithPassword(currentPassword);
    if (!opened) return false;
    try {
      await this.writePasswordWrap(newPassword, opened.key, header.accountId, opened.pendingOld ?? undefined);
    } finally {
      opened.key.fill(0);
      if (opened.pendingOld && opened.pendingOld !== this.pendingOldKey) opened.pendingOld.fill(0);
    }
    return true;
  }

  private async unwrapWithPassword(password: string): Promise<{ key: Buffer; pendingOld: Buffer | null } | null> {
    const header = this.readPasswordHeader();
    if (!header) return null;
    const params = { N: header.N, r: header.r, p: header.p };
    if (!scryptParamsOk(params)) return null;
    const kek = await scryptAsync(password, Buffer.from(header.salt, 'hex'), params);
    try {
      const key = unwrapKey(kek, header.wrapped, header.accountId);
      if (!key) return null;
      const pendingOld = header.pending ? unwrapKey(kek, header.pending, header.accountId) : null;
      return { key, pendingOld };
    } finally {
      kek.fill(0);
    }
  }

  private async writePasswordWrap(
    password: string, vaultKey: Buffer, accountId: string, pendingOld?: Buffer,
    /** Only a re-key passes this: the second wrap for the NEW key (or null: drop it), written in the same atomic write. */
    platform?: PlatformHeader | null,
  ): Promise<void> {
    const salt = randomBytes(32);
    const kek = await scryptAsync(password, salt, this.scryptParams);
    try {
      const data = this.readVaultFile();
      data.password = {
        v: 1,
        kdf: 'scrypt',
        ...this.scryptParams,
        salt: salt.toString('hex'),
        wrapped: wrapKey(kek, vaultKey, accountId),
        accountId,
        ...(pendingOld ? { pending: wrapKey(kek, pendingOld, accountId) } : {}),
      };
      if (platform === null) delete data.platform;
      else if (platform) data.platform = platform;
      this.writeVaultFileAtomic(data);
    } finally {
      kek.fill(0);
    }
  }

  /** Write-then-rename: a crash must never leave a half-written header. */
  private writeVaultFileAtomic(data: VaultFile): void {
    const tmp = `${this.vaultFilePath}.tmp`;
    mkdirSync(dirname(this.vaultFilePath), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, this.vaultFilePath);
  }

  /** Called whenever the vault locks (any reason). The page session ends with it. */
  onLocked(listener: () => void): void {
    this.lockListeners.push(listener);
  }

  // ─── Unlock by the computer's own lock (PlatformUnsealProvider) ─────────
  //
  // A second wrap of the one random vault key, held by the native helper (Touch ID).
  // The password stays: nothing here removes or weakens it. Everything that writes the
  // vault file reads it strictly (an unreadable file is never turned into an empty one)
  // and writes it by rename, in one synchronous step after the last await.

  setPlatformService(service: PlatformKeyService | null, gate: PlatformGate | null = null): void {
    this.platform = service;
    this.platformGate = gate;
  }

  /** The header, or null when absent or not valid. Read from the file, so it holds while locked. */
  readPlatformHeader(): PlatformHeader | null {
    let h: PlatformHeader | undefined;
    try { h = this.readVaultFileStrict().platform; } catch { return null; }
    if (!h || h.v !== 1) return null;
    for (const f of [h.keyBlob, h.publicKey, h.wrapped]) if (typeof f !== 'string' || !f || f.length > 8192 || !B64U.test(f)) return null;
    if (typeof h.backend !== 'string' || typeof h.policy !== 'string' || typeof h.accountId !== 'string' || !h.accountId) return null;
    return h;
  }

  /** Is unlock by Touch ID enabled on this vault? */
  hasPlatformUnlock(): boolean {
    return this.readPlatformHeader() !== null;
  }

  /**
   * Turn it on. The vault is unlocked (by the password) and the person touches once: a wrap
   * that does not open is never stored. Refused while a re-key is unfinished, and when the
   * vault key, the account or the header changed during the touch.
   */
  async enablePlatformUnlock(password: string): Promise<{ backend: string; policy: string }> {
    const service = this.platform;
    const gate = this.platformGate;
    if (!service || !gate) throw new PlatformUnlockError('no_helper');
    const key = this.vaultKey;
    if (!key) throw new PlatformUnlockError('locked');
    const pw = this.readPasswordHeader();
    if (!pw) throw new PlatformUnlockError('no_password');
    if (this.pendingOldKey || pw.pending) throw new PlatformUnlockError('rekey_pending');
    if (this.platformBusy) throw new PlatformUnlockError('busy');
    if (this.hasPlatformUnlock()) throw new PlatformUnlockError('already_enabled');
    this.platformBusy = true;
    const epoch = this.keyEpoch;
    const aad = platformAad(pw.accountId);
    let back: Buffer | null = null;
    try {
      // Turning it on needs the unlock password AND, where this computer has a check key, a fresh check whose
      // prompt says what it is for. Asked here, where the write happens, not in the route.
      if (!(await this.verifyPassword(password))) throw new PlatformUnlockError('wrong_password');
      if (gate.hasCheckKey()) {
        try { await gate.check('enable'); } catch (err) { throw helperFailure(err); }
      }
      let info, wrapped: string;
      try {
        info = await service.createWrapKey();
        wrapped = await service.wrap({ publicKey: info.publicKey, vaultKey: key, aad });
        back = await service.unwrap({ keyBlob: info.keyBlob, wrapped, aad });   // the one touch
      } catch (err) {
        throw helperFailure(err);
      }
      const same = back.length === key.length && timingSafeEqual(back, key);
      if (!same) throw new PlatformUnlockError('wrap_mismatch');
      // Everything after this line is synchronous: nothing can change between the check and the write.
      const now = this.readPasswordHeader();
      if (this.vaultKey !== key || this.keyEpoch !== epoch || this.pendingOldKey || !now || now.accountId !== pw.accountId || now.pending
        || this.hasPlatformUnlock()) {
        throw new PlatformUnlockError('vault_changed');
      }
      const data = this.readVaultFileStrict();
      data.platform = { v: 1, backend: info.backend, policy: info.policy, keyBlob: info.keyBlob, publicKey: info.publicKey, wrapped, accountId: pw.accountId };
      this.writeVaultFileAtomic(data);
      return { backend: info.backend, policy: info.policy };
    } finally {
      back?.fill(0);
      this.platformBusy = false;
    }
  }

  /**
   * Turn it off, and REVOKE: the vault key is replaced by a fresh one and everything is re-sealed with it (the
   * control plane's files here, the MCP server's stores through /internal/rekey, exactly as the move to a
   * password does; an interrupted run is finished at the next unlock). What this gives: nothing sealed or
   * written from now on opens with the old key, so a copy of vault.enc.json taken BEFORE (which still holds its
   * own key blob) opens only what was in it then, never a credential entered later, and the MCP server's
   * stores are not readable with it. It does NOT make the old copy itself unreadable to someone who can touch
   * this computer's sensor: that copy is the old data, which the old key always opened.
   * Needs the unlock password (the new password wrap is made with it) and, where this computer has a check key,
   * a fresh check that says "turn off Touch ID unlock".
   */
  async disablePlatformUnlock(password: string, mcp?: McpRekeyClient): Promise<RekeyOutcome> {
    const key = this.vaultKey;
    if (!key) throw new PlatformUnlockError('locked');
    const pw = this.readPasswordHeader();
    if (!pw) throw new PlatformUnlockError('no_password');
    if (this.pendingOldKey || pw.pending) throw new PlatformUnlockError('rekey_pending');
    if (this.platformBusy) throw new PlatformUnlockError('busy');
    if (!this.hasPlatformUnlock()) throw new PlatformUnlockError('not_enabled');
    const gate = this.platformGate;
    if (!gate) throw new PlatformUnlockError('no_helper');
    this.platformBusy = true;
    const epoch = this.keyEpoch;
    try {
      if (!(await this.verifyPassword(password))) throw new PlatformUnlockError('wrong_password');
      if (gate.hasCheckKey()) {
        try { await gate.check('disable'); } catch (err) { throw helperFailure(err); }
      }
      return await this.exclusive(async () => {
        const stillSame = () => this.vaultKey === key && this.keyEpoch === epoch && !this.pendingOldKey && this.hasPlatformUnlock();
        if (!stillSame()) throw new PlatformUnlockError('vault_changed');
        const newKey = randomBytes(32);
        // One atomic write: the password wrap of the NEW key (the old key as `pending`) and no platform header.
        await this.writePasswordWrap(password, newKey, pw.accountId, key, null);
        if (this.vaultKey !== key || this.keyEpoch !== epoch) {
          // Locked or replaced during the (slow) password hash: the file already says "new key, old key pending".
          // Memory is not moved on; the next password unlock finishes the move (it reads the pending key).
          newKey.fill(0);
          throw new PlatformUnlockError('vault_changed');
        }
        this.pendingOldKey = key;
        this.vaultKey = newKey;
        this.keyEpoch++;
        return this.reconcileRekey(mcp, { countFailure: false });
      });
    } finally {
      this.platformBusy = false;
    }
  }

  /** Is this the key Touch ID opens? One touch. For the case that the vault is unlocked already and a session is asked for (see routes/platform.ts). */
  async verifyWithPlatform(): Promise<void> {
    const service = this.platform;
    if (!service) throw new PlatformUnlockError('no_helper');
    const current = this.vaultKey;
    if (!current) throw new PlatformUnlockError('locked');
    const header = this.readPlatformHeader();
    if (!header) throw new PlatformUnlockError('not_enabled');
    let key: Buffer | null = null;
    try {
      try { key = await new PlatformUnsealProvider(service, header).deriveKey(); } catch (err) { throw helperFailure(err); }
      if (this.vaultKey !== current || key.length !== current.length || !timingSafeEqual(key, current)) throw new PlatformUnlockError('wrap_mismatch');
    } finally {
      key?.fill(0);
    }
  }

  /**
   * Unlock with a touch. False is never returned: a refusal is an error with a code, so the page
   * can tell "cancelled" from "damaged"; whatever it is, the password still opens the vault.
   * The key that comes back must open the vault's verifier, else it is dropped (a stale wrap).
   */
  async unlockWithPlatform(): Promise<void> {
    const service = this.platform;
    if (!service) throw new PlatformUnlockError('no_helper');
    if (this.vaultKey) throw new PlatformUnlockError('already_unlocked');
    const pw = this.readPasswordHeader();
    const header = this.readPlatformHeader();
    if (!pw || !header) throw new PlatformUnlockError('not_enabled');
    if (pw.pending) throw new PlatformUnlockError('rekey_pending');   // the old key is only in the password wrap
    if (header.accountId !== pw.accountId) throw new PlatformUnlockError('wrap_mismatch');
    if (this.platformBusy) throw new PlatformUnlockError('busy');
    this.platformBusy = true;
    const epoch = this.keyEpoch;
    let key: Buffer | null = null;
    try {
      try {
        key = await new PlatformUnsealProvider(service, header).deriveKey();
      } catch (err) {
        throw helperFailure(err);
      }
      const candidate: CandidateKey = { key, providerId: 'platform', apiKeyHash: null };
      if (this.keyMatch(candidate) !== 'match') throw new PlatformUnlockError('wrap_mismatch');
      // Unlocked, wiped or switched off while the prompt was open: the answer is dropped.
      const still = this.readPlatformHeader();
      if (this.vaultKey || this.keyEpoch !== epoch || !still || still.wrapped !== header.wrapped || still.keyBlob !== header.keyBlob) {
        throw new PlatformUnlockError('vault_changed');
      }
      this.adopt(candidate);
      key = null;     // now the vault's
    } finally {
      key?.fill(0);
      this.platformBusy = false;
    }
  }

  /**
   * A re-key (the move to a fresh vault key) wraps the new key for the helper too, with no touch,
   * in the same write as the password wrap. Without a helper to wrap with, the stale wrap is dropped:
   * the person unlocks with the password. Undefined: there is no second wrap, nothing changes.
   */
  private async platformAfterRekey(newKey: Buffer, accountId: string): Promise<PlatformHeader | null | undefined> {
    const header = this.readPlatformHeader();
    if (!header) return undefined;
    if (!this.platform) return null;
    try {
      const wrapped = await this.platform.wrap({ publicKey: header.publicKey, vaultKey: newKey, aad: platformAad(accountId) });
      return { ...header, wrapped, accountId };
    } catch {
      return null;
    }
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
    this.keyEpoch++;
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
    this.keyEpoch++;
    this.pendingOldKey?.fill(0);
    this.pendingOldKey = null;
    this.vaultKey = null;
    this.apiKeyHash = null;
    this.spSessionCookie = null;
    this.unsealedBy = null;
    this.spSessionExpiresAt = null;
    this.sessionUser = null;
    this.lockedReason = null;
    for (const l of this.lockListeners) {
      try { l(); } catch { /* a listener must never keep the vault open */ }
    }
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

  /** Drop the Authority Server credential and nothing else: the vault stays unlocked (a device session ended). */
  clearSpCookie(): void {
    this.spSessionCookie = null;
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
    // While a move to a fresh key is unfinished, what the MCP server still seals
    // with the old key (the denial log the control plane reads) must read, not vanish.
    if (this.pendingOldKey) {
      try { return decryptWith(this.vaultKey, blob); } catch { return decryptWith(this.pendingOldKey, blob); }
    }
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

  // ─── Secret slots (vault.enc.json `slots`; device-keys step 6) ──────────

  /**
   * The vault file for a slot read or write. Unlike `readVaultFile` it never
   * turns a file it cannot read into an empty vault: a write after that would
   * drop the password header and every credential.
   */
  private readVaultFileStrict(): VaultFile {
    if (!existsSync(this.vaultFilePath)) return { version: 1, credentials: {} };
    const parsed = JSON.parse(readFileSync(this.vaultFilePath, 'utf-8')) as VaultFile;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.credentials !== 'object') throw new Error('The vault file cannot be read');
    return parsed;
  }

  /** Is a slot there (sealed or not openable)? Reads the file only; throws when the file cannot be read. */
  hasSecretSlot(name: string): boolean {
    const blob = this.readVaultFileStrict().slots?.[name];
    return blob !== undefined && blob !== null;
  }

  /** A sealed slot, or null when none was ever written. Throws while locked or when the slot cannot be opened. */
  getSecretSlot<T>(name: string): T | null {
    const blob = this.readVaultFileStrict().slots?.[name];
    if (!blob) return null;
    return JSON.parse(this.decrypt(blob)) as T;
  }

  /** Seal `value` into a slot (atomic write-then-rename). Not listed by `listCredentials`, not pushed anywhere. */
  setSecretSlot(name: string, value: unknown): void {
    const data = this.readVaultFileStrict();
    data.slots = { ...(data.slots ?? {}), [name]: this.encrypt(JSON.stringify(value)) };
    this.writeVaultFile(data);
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

  /** Write-then-rename, always: a crash must never leave a half-written vault file. */
  private writeVaultFile(data: VaultFile): void {
    this.writeVaultFileAtomic(data);
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
