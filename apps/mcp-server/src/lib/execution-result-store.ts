/**
 * Execution Result Store — the gateway's own copy of what a committed
 * proposal's downstream tool call actually returned.
 *
 * Found 2026-10-13 (live report, Mollie `CreatePaymentLink`): a LATER
 * check-pending-commitments(proposal_id) call answered "approved and has
 * already been EXECUTED ... the gateway did not retain its output" — on
 * SUCCESS, not just failure, because nothing anywhere kept the tool's result
 * text past the single return value of the call that produced it. The
 * execution journal (execution-journal.ts) decides done/failed and keeps a
 * short plaintext detail for a connector refusal — by design, ids and a
 * short label only, no content (see its own doc comment). This store is the
 * content half: the full result text (success) or error text (failure),
 * size-capped, encrypted at rest once the vault key arrives, and retained for
 * the same 90-day window as the journal row it corresponds to.
 *
 * One entry per proposal (latest write wins) — a proposal executes at most
 * once per ticket (ExecutionJournal enforces that), so there is never a
 * reason to keep more than the one outcome.
 *
 * Automatic executions (no proposal) are kept too, since UI spec §14: an
 * automatic ticket shows what the tool answered. They carry no proposalId
 * and are keyed by ticket id instead (one execution per ticket, same rule).
 *
 * Persistence mirrors outcome-outbox.ts: plaintext until the vault key
 * arrives, then AES-256-GCM encrypted, with plaintext migration and deletion.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface ExecutionResultEntry {
  /** Review path only — absent for an automatic execution (keyed by ticketId). */
  proposalId?: string;
  ticketId: string;
  /** True on success (the tool's result); false on failure (the error text). */
  ok: boolean;
  /** The result text (success) or error text (failure). Capped — see MAX_BYTES. */
  text: string;
  /** The downstream's structuredContent, when it returned one. Capped with `text`. */
  structuredContent?: Record<string, unknown>;
  /** Set when `text`/`structuredContent` were cut down to fit the cap. */
  truncated?: boolean;
  /** Unix seconds. Drives the 90-day retention window. */
  recordedAt: number;
}

interface StoreFile { version: 1; entries: ExecutionResultEntry[]; }
interface EncryptedBlob { iv: string; ciphertext: string; tag: string; }
interface EncryptedStoreFile { version: 1; blob: EncryptedBlob; }

const DEFAULT_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
/** Mirrors ExecutionJournal's MAX_AGE_SECONDS — same retention as the journal row it explains. */
const MAX_AGE_SECONDS = 90 * 24 * 60 * 60;
/** Combined cap on `text` + JSON-stringified `structuredContent`, per entry. */
const MAX_BYTES = 16 * 1024;

/**
 * Fit `text`/`structuredContent` under MAX_BYTES. structuredContent is
 * dropped first (text is what a human/agent actually reads); if text alone
 * still exceeds the cap, it is truncated to it. Either case sets `truncated`.
 */
export function capResult(
  text: string,
  structuredContent?: Record<string, unknown>,
): { text: string; structuredContent?: Record<string, unknown>; truncated: boolean } {
  const structJson = structuredContent ? JSON.stringify(structuredContent) : undefined;
  const textBytes = Buffer.byteLength(text, 'utf8');
  const structBytes = structJson ? Buffer.byteLength(structJson, 'utf8') : 0;
  if (textBytes + structBytes <= MAX_BYTES) {
    return { text, ...(structuredContent ? { structuredContent } : {}), truncated: false };
  }
  if (textBytes <= MAX_BYTES) {
    // Text alone fits — drop structuredContent only.
    return { text, truncated: true };
  }
  const cappedText = Buffer.from(text, 'utf8').subarray(0, MAX_BYTES).toString('utf8');
  return { text: cappedText, truncated: true };
}

export class ExecutionResultStore {
  private entries: ExecutionResultEntry[] = [];
  private baseDir: string;
  private vaultKey: Buffer | null = null;

  constructor(filePath?: string) {
    this.baseDir = filePath && filePath.endsWith('.json') ? dirname(filePath) : (filePath ?? DEFAULT_DIR);
    this.loadPlaintext();
  }

  /** Mirrors OutcomeOutbox.setVaultKey — migrates plaintext -> encrypted once, in place. */
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
   * True when encrypted evidence exists on disk that this process cannot
   * read yet (no vault key). Callers should not report "nothing retained" in
   * this state — that would claim a hollow absence over unreadable content.
   */
  isLocked(): boolean {
    return this.vaultKey === null && existsSync(this.encryptedFilePath);
  }

  /**
   * Record the outcome of one execution. Replaces any prior entry for the
   * same proposal — or, for an automatic execution (no proposalId), for the
   * same ticket.
   */
  record(
    input: { proposalId?: string; ticketId: string; ok: boolean; text: string; structuredContent?: Record<string, unknown> },
    now: number = nowSec(),
  ): void {
    const capped = capResult(input.text, input.structuredContent);
    this.entries = input.proposalId !== undefined
      ? this.entries.filter(e => e.proposalId !== input.proposalId)
      : this.entries.filter(e => e.proposalId !== undefined || e.ticketId !== input.ticketId);
    this.entries.push({
      ...(input.proposalId !== undefined ? { proposalId: input.proposalId } : {}),
      ticketId: input.ticketId,
      ok: input.ok,
      text: capped.text,
      ...(capped.structuredContent ? { structuredContent: capped.structuredContent } : {}),
      ...(capped.truncated ? { truncated: true } : {}),
      recordedAt: now,
    });
    this.prune(now);
    this.persist();
  }

  /** The retained outcome for a proposal, or undefined if never recorded (or pruned). */
  get(proposalId: string): ExecutionResultEntry | undefined {
    return this.entries.find(e => e.proposalId === proposalId);
  }

  /** The retained outcome of the execution under a ticket (either path), newest first. */
  getByTicket(ticketId: string): ExecutionResultEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].ticketId === ticketId) return this.entries[i];
    }
    return undefined;
  }

  /** Diagnostic / tests. */
  get size(): number { return this.entries.length; }

  // ─── Retention ────────────────────────────────────────────────────────────
  private prune(now: number): void {
    const cutoff = now - MAX_AGE_SECONDS;
    this.entries = this.entries.filter(e => e.recordedAt >= cutoff);
  }

  // ─── Encryption (mirrors OutcomeOutbox / DenialLog) ────────────────────────
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

  private get plaintextFilePath(): string { return join(this.baseDir, 'execution-results.json'); }
  private get encryptedFilePath(): string { return join(this.baseDir, 'execution-results.enc.json'); }

  private loadPlaintext(): void {
    if (!existsSync(this.plaintextFilePath)) { mkdirSync(this.baseDir, { recursive: true }); return; }
    try {
      const data: StoreFile = JSON.parse(readFileSync(this.plaintextFilePath, 'utf-8'));
      this.entries = data.entries ?? [];
      this.prune(nowSec());
    } catch {
      console.error(`[ExecutionResultStore] Could not parse ${this.plaintextFilePath}, starting fresh`);
      this.entries = [];
    }
  }

  private loadEncrypted(): void {
    if (!existsSync(this.encryptedFilePath)) return;
    try {
      const data: EncryptedStoreFile = JSON.parse(readFileSync(this.encryptedFilePath, 'utf-8'));
      const storeFile: StoreFile = JSON.parse(this.decrypt(data.blob));
      this.entries = storeFile.entries ?? [];
      this.prune(nowSec());
    } catch (err) {
      console.error(`[ExecutionResultStore] Could not decrypt ${this.encryptedFilePath}:`, err);
      this.entries = [];
    }
  }

  private persist(): void {
    if (this.vaultKey) this.persistEncrypted(); else this.persistPlaintext();
  }

  private persistPlaintext(): void {
    const data: StoreFile = { version: 1, entries: this.entries };
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.plaintextFilePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  private persistEncrypted(): void {
    const storeFile: StoreFile = { version: 1, entries: this.entries };
    const data: EncryptedStoreFile = { version: 1, blob: this.encrypt(JSON.stringify(storeFile)) };
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.encryptedFilePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
