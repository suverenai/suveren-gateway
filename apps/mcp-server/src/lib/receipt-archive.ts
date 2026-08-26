/**
 * Receipt Archive — durable local custody of complete signed receipts.
 *
 * The execution log keeps an UNSIGNED summary and prunes at 31 days — it
 * exists for cumulative display, not evidence. This archive is the human's
 * own copy of the evidence: the complete AS-signed receipt (verbatim), the
 * attestation blobs it was issued under, and the AS public key — everything
 * needed to verify offline, without the Authority Server's cooperation
 * (protocol.md → Receipt Verification: "the holder is the verifier").
 *
 * Properties:
 *  - Append-only, never pruned. retention_minimum is a floor, not a ceiling.
 *  - Receipts dedup by receipt id (idempotent retries / crash-window re-runs
 *    must not produce duplicate entries).
 *  - Attestation blobs dedup per authorization by (domain, blob).
 *  - Storage mirrors the GateStore/ExecutionLog pattern: plaintext until the
 *    vault key arrives, then encrypted (AES-256-GCM) with plaintext migration.
 *  - Archiving is best-effort by contract: callers MUST NOT let an archive
 *    failure block an execution the AS already authorized — the AS copy
 *    exists; this one is the subject's safety copy.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface ArchivedAttestation {
  domain: string;
  blob: string;
  expiresAt: number;
}

/** One entry per grant — attestation blobs are deduped here, not per receipt. */
export interface ArchivedAuthorization {
  authorizationId: string;
  profileId: string;
  boundsHash?: string;
  contextHash?: string;
  /**
   * Plaintext bounds and context VALUES, kept next to the hashes on purpose:
   * the signed attestation payload commits to bounds_hash/context_hash only,
   * so without the values the evidence reads as opaque hashes. A verifier
   * recomputes the hash from these values and matches it against the signed
   * payload — readable AND checkable.
   */
  bounds?: Record<string, string | number>;
  context?: Record<string, string | number>;
  /**
   * The intent TEXT (Direction State), copied from the local gate store so the
   * archive entry is self-contained: the signed attestation commits only to
   * gate_content_hashes.intent, and without the text the exculpatory reasoning
   * is an unreadable hash. Local custody only — this never leaves the machine
   * except in the user's own export.
   */
  intent?: string;
  attestations: ArchivedAttestation[];
  archivedAt: number; // Unix seconds, first time this grant was archived
}

export interface ArchivedReceipt {
  archivedAt: number; // Unix seconds
  authorizationId: string;
  /** AS base URL the receipt came from — which key/issuer this belongs to. */
  asUrl: string;
  /** AS Ed25519 public key (hex) at archive time — enables offline verification. */
  asPublicKey?: string;
  /** The complete signed receipt exactly as the AS returned it. */
  receipt: Record<string, unknown>;
  /**
   * Review path only — the proposal this receipt executed. The receipt binds
   * `proposalId` into its signature, but the id alone is a pointer to the
   * Authority Server: what a human actually approved (`toolArgs`), who
   * approved it and when, live in the proposal record. Without a local copy,
   * the most evidentially important case — a human explicitly said yes to
   * this exact content — is the one that cannot be reconstructed offline.
   */
  proposal?: Record<string, unknown>;
  /**
   * The content the receipt's `contentHash` commits to — the hash's preimage,
   * stored so the archive can reproduce what ran and not merely refute a forgery.
   *
   * On the review path the proposal already carries the full approved args;
   * this is what makes the AUTOMATIC path equally reconstructable. It holds
   * only what the binding covers, so it is checkable by construction and
   * excludes what the binding deliberately omits (e.g. an email's `bcc`).
   */
  boundContent?: Record<string, unknown> | string;
}

interface ArchiveFile {
  version: 1;
  authorizations: Record<string, ArchivedAuthorization>;
  receipts: ArchivedReceipt[];
}

interface EncryptedBlob {
  iv: string;
  ciphertext: string;
  tag: string;
}

interface EncryptedArchiveFile {
  version: 1;
  blob: EncryptedBlob;
}

const DEFAULT_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');

/**
 * Drop `_imagePreview` from archived tool arguments.
 *
 * It is a base64 data URL (up to 1 MB) attached so a review card can render an
 * image the approver is about to send — a rendering aid for a decision already
 * recorded, not the decision. The archive is append-only and never pruned, so
 * keeping one per review receipt would grow it without bound. The underlying
 * `imagePath` stays, so what was sent is still named.
 */
function stripPreviews(proposal: Record<string, unknown>): Record<string, unknown> {
  const args = proposal.toolArgs;
  if (!args || typeof args !== 'object') return proposal;
  const { _imagePreview, ...rest } = args as Record<string, unknown>;
  if (_imagePreview === undefined) return proposal;
  return { ...proposal, toolArgs: rest };
}

export interface ReceiptArchiveEntry {
  receipt: Record<string, unknown>;
  authorizationId: string;
  asUrl: string;
  asPublicKey?: string;
  proposal?: Record<string, unknown>;
  boundContent?: Record<string, unknown> | string;
  authorization?: {
    profileId: string;
    boundsHash?: string;
    contextHash?: string;
    bounds?: Record<string, string | number>;
    context?: Record<string, string | number>;
    intent?: string;
    attestations: ArchivedAttestation[];
  };
}

export class ReceiptArchive {
  private data: ArchiveFile = { version: 1, authorizations: {}, receipts: [] };
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
    } else if (this.data.receipts.length > 0 || Object.keys(this.data.authorizations).length > 0) {
      this.persistEncrypted();
      if (existsSync(this.plaintextFilePath)) {
        try { unlinkSync(this.plaintextFilePath); } catch { /* ignore */ }
      }
    }
  }

  /**
   * True when encrypted evidence exists on disk that this process cannot read
   * yet (no vault key). Callers MUST NOT present the archive as "empty" in
   * this state — that would report a hollow success over unreadable evidence.
   */
  isLocked(): boolean {
    return this.vaultKey === null && existsSync(this.encryptedFilePath);
  }

  /**
   * Archive a signed receipt (and the grant it was issued under).
   * Idempotent on receipt id — a replayed receipt is recorded once.
   */
  record(entry: ReceiptArchiveEntry, now: number = Math.floor(Date.now() / 1000)): void {
    let changed = false;

    const receiptId = typeof entry.receipt?.id === 'string' ? entry.receipt.id : undefined;
    const alreadyArchived =
      receiptId !== undefined &&
      this.data.receipts.some(r => (r.receipt as { id?: unknown }).id === receiptId);

    if (!alreadyArchived) {
      this.data.receipts.push({
        archivedAt: now,
        authorizationId: entry.authorizationId,
        asUrl: entry.asUrl,
        asPublicKey: entry.asPublicKey,
        receipt: entry.receipt,
        ...(entry.proposal ? { proposal: stripPreviews(entry.proposal) } : {}),
        ...(entry.boundContent !== undefined ? { boundContent: entry.boundContent } : {}),
      });
      changed = true;
    }

    if (entry.authorization) {
      const existing = this.data.authorizations[entry.authorizationId];
      if (!existing) {
        this.data.authorizations[entry.authorizationId] = {
          authorizationId: entry.authorizationId,
          profileId: entry.authorization.profileId,
          boundsHash: entry.authorization.boundsHash,
          contextHash: entry.authorization.contextHash,
          bounds: entry.authorization.bounds,
          context: entry.authorization.context,
          intent: entry.authorization.intent,
          attestations: [...entry.authorization.attestations],
          archivedAt: now,
        };
        changed = true;
      } else {
        // Merge any attestation blobs not seen yet (e.g. a later domain).
        for (const att of entry.authorization.attestations) {
          const seen = existing.attestations.some(
            a => a.domain === att.domain && a.blob === att.blob,
          );
          if (!seen) {
            existing.attestations.push(att);
            changed = true;
          }
        }
        // Back-fill plaintext values on entries archived before they were
        // known (e.g. review path with an evicted cache).
        if (!existing.bounds && entry.authorization.bounds) {
          existing.bounds = entry.authorization.bounds;
          changed = true;
        }
        if (!existing.context && entry.authorization.context) {
          existing.context = entry.authorization.context;
          changed = true;
        }
        if (!existing.intent && entry.authorization.intent) {
          existing.intent = entry.authorization.intent;
          changed = true;
        }
      }
    }

    if (changed) this.persist();
  }

  getReceipts(): ArchivedReceipt[] {
    return [...this.data.receipts];
  }

  getAuthorizations(): ArchivedAuthorization[] {
    return Object.values(this.data.authorizations);
  }

  get size(): number {
    return this.data.receipts.length;
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
    return join(this.baseDir, 'receipt-archive.json');
  }

  private get encryptedFilePath(): string {
    return join(this.baseDir, 'receipt-archive.enc.json');
  }

  // ─── Load / Persist ─────────────────────────────────────────────────────

  private loadPlaintext(): void {
    if (!existsSync(this.plaintextFilePath)) {
      mkdirSync(this.baseDir, { recursive: true });
      return;
    }
    try {
      const raw = readFileSync(this.plaintextFilePath, 'utf-8');
      const parsed: ArchiveFile = JSON.parse(raw);
      this.data = {
        version: 1,
        authorizations: parsed.authorizations ?? {},
        receipts: parsed.receipts ?? [],
      };
    } catch {
      // Evidence store: NEVER start fresh over a file we can't read — that
      // would overwrite the archive on the next record(). Move it aside.
      console.error(`[ReceiptArchive] Could not parse ${this.plaintextFilePath} — preserving as .corrupt`);
      try {
        writeFileSync(
          `${this.plaintextFilePath}.corrupt-${Date.now()}`,
          readFileSync(this.plaintextFilePath),
        );
      } catch { /* best effort */ }
    }
  }

  private loadEncrypted(): void {
    if (!existsSync(this.encryptedFilePath)) return;
    try {
      const raw = readFileSync(this.encryptedFilePath, 'utf-8');
      const data: EncryptedArchiveFile = JSON.parse(raw);
      const decrypted = this.decrypt(data.blob);
      const parsed: ArchiveFile = JSON.parse(decrypted);
      this.data = {
        version: 1,
        authorizations: parsed.authorizations ?? {},
        receipts: parsed.receipts ?? [],
      };
    } catch (err) {
      // Same rule: a decrypt failure must not lead to overwriting history.
      console.error(`[ReceiptArchive] Could not decrypt ${this.encryptedFilePath} — preserving as .corrupt:`, err);
      try {
        writeFileSync(
          `${this.encryptedFilePath}.corrupt-${Date.now()}`,
          readFileSync(this.encryptedFilePath),
        );
      } catch { /* best effort */ }
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
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.plaintextFilePath, JSON.stringify(this.data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  private persistEncrypted(): void {
    const data: EncryptedArchiveFile = {
      version: 1,
      blob: this.encrypt(JSON.stringify(this.data)),
    };
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.encryptedFilePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }
}
