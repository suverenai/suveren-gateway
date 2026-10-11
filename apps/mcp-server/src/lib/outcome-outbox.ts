/**
 * Outcome Outbox — RJ4 ("Reject or ask for a change", 2026-10-11 brief,
 * decision 3): the AI learns a proposal's final rejection outcome on its
 * NEXT call to ANY gateway tool, once, even when it never asks about that
 * proposal again. There is no chat id to push this to — the only channel
 * back to the AI is the reply to whatever it calls next.
 *
 * Persisted like execution-journal.ts / denial-log.ts: plaintext before the
 * vault key arrives, AES-256-GCM encrypted after (mirrors denial-log.ts),
 * so this survives a gateway restart with the same guarantees as the other
 * local stores. Fed by bin/http.ts's existing committed-proposal poll tick
 * (no second AS polling loop — see pollRejectedOutcomes there) and consumed
 * by `wrapWithOutcomeOutbox`, the one wrapper every registered tool handler
 * goes through.
 *
 * `deliveredAt` is kept, not deleted, once a line has gone out — the point
 * is EXACTLY ONE delivery per outcome, and a delivered row makes that
 * auditable instead of inferred from absence. Retention: an entry (delivered
 * or not) older than 7 days is dropped on the next load/write — the brief
 * requires this for undelivered rows (an outcome the AI never picks up must
 * not resurface weeks later); the same window is applied to delivered rows
 * too, since nothing here needs them past that.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ProposalOutcome } from './sp-client';

export interface OutcomeOutboxEntry {
  proposalId: string;
  outcome: ProposalOutcome;
  note?: string;
  /** Display name if known locally, else the user id — see who-label.ts. */
  who: string;
  /** Unix ms when the PERSON decided (the AS's rejection `at`, which is unix
   *  seconds, × 1000) — drives the 7-day window. It must be the decision time,
   *  not the time this gateway first saw it: otherwise every old rejection
   *  arrives as "new" after an update, and again after each 7-day prune. */
  decidedAt: number;
  /** Unix ms when this entry was appended to a tool reply. Absent = not yet delivered. */
  deliveredAt?: number;
}

interface StoreFile { version: 1; entries: OutcomeOutboxEntry[]; }
interface EncryptedBlob { iv: string; ciphertext: string; tag: string; }
interface EncryptedStoreFile { version: 1; blob: EncryptedBlob; }

const DEFAULT_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
/** Undelivered AND delivered rows older than this are dropped — see module doc. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The 7-day window, exported for the poller's admission rule. */
export const OUTCOME_MAX_AGE_MS = MAX_AGE_MS;

/**
 * Which rejected proposals become an outbox entry. Only proposals THIS gateway
 * submitted (a local submission record exists) — another device's proposals
 * are not this gateway's AI's business — and only decisions inside the 7-day
 * window, by the decision time itself, so an entry pruned after 7 days can
 * never be re-admitted as new.
 */
export function outcomeEntryFor(
  proposal: {
    id: string;
    rejectedBy?: { userId: string; at: number; outcome?: ProposalOutcome; note?: string; domain?: string } | null;
    approverRejectedBy?: { userId: string; at: number; outcome?: ProposalOutcome; note?: string };
  },
  submittedHere: boolean,
  who: string,
  nowMs: number,
): Omit<OutcomeOutboxEntry, 'deliveredAt'> | null {
  if (!submittedHere) return null;
  const by = proposal.approverRejectedBy ?? proposal.rejectedBy;
  if (!by || typeof by.at !== 'number') return null;
  const decidedAt = by.at * 1000; // AS stores unix seconds
  if (nowMs - decidedAt > MAX_AGE_MS) return null;
  return { proposalId: proposal.id, outcome: by.outcome ?? 'rejected', note: by.note, who, decidedAt };
}

export class OutcomeOutbox {
  private entries: OutcomeOutboxEntry[] = [];
  private baseDir: string;
  private vaultKey: Buffer | null = null;

  constructor(filePath?: string) {
    this.baseDir = filePath && filePath.endsWith('.json') ? dirname(filePath) : (filePath ?? DEFAULT_DIR);
    this.loadPlaintext();
  }

  /** Mirrors DenialLog.setVaultKey — migrates plaintext -> encrypted once, in place. */
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
   * Record a resolved outcome, UNLESS this proposal is already known here
   * (delivered or not) — the poller rechecks the AS's rejected list on
   * every tick, and a proposal stays in that list well past the moment this
   * gateway first learned about it, so without this guard the same outcome
   * would be queued again right after it was delivered.
   */
  recordIfNew(entry: Omit<OutcomeOutboxEntry, 'deliveredAt'>): void {
    if (this.entries.some(e => e.proposalId === entry.proposalId)) return;
    this.entries.push({ ...entry });
    this.prune(Date.now());
    this.persist();
  }

  /** Undelivered entries, oldest first — what the next tool reply should carry. */
  getUndelivered(): OutcomeOutboxEntry[] {
    return this.entries.filter(e => e.deliveredAt === undefined).sort((a, b) => a.decidedAt - b.decidedAt);
  }

  /** Mark these proposals' entries delivered (idempotent). Always persists from disk state. */
  markDelivered(proposalIds: string[]): void {
    if (proposalIds.length === 0) return;
    const ids = new Set(proposalIds);
    const now = Date.now();
    let changed = false;
    for (const e of this.entries) {
      if (ids.has(e.proposalId) && e.deliveredAt === undefined) {
        e.deliveredAt = now;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /** Diagnostic / tests. */
  get size(): number { return this.entries.length; }

  // ─── Retention ────────────────────────────────────────────────────────────
  private prune(now: number): void {
    const cutoff = now - MAX_AGE_MS;
    this.entries = this.entries.filter(e => e.decidedAt >= cutoff);
  }

  // ─── Encryption (mirrors DenialLog / ExecutionLog) ─────────────────────────
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

  private get plaintextFilePath(): string { return join(this.baseDir, 'outcome-outbox.json'); }
  private get encryptedFilePath(): string { return join(this.baseDir, 'outcome-outbox.enc.json'); }

  private loadPlaintext(): void {
    if (!existsSync(this.plaintextFilePath)) { mkdirSync(this.baseDir, { recursive: true }); return; }
    try {
      const data: StoreFile = JSON.parse(readFileSync(this.plaintextFilePath, 'utf-8'));
      this.entries = data.entries ?? [];
      this.prune(Date.now());
    } catch {
      console.error(`[OutcomeOutbox] Could not parse ${this.plaintextFilePath}, starting fresh`);
      this.entries = [];
    }
  }

  private loadEncrypted(): void {
    if (!existsSync(this.encryptedFilePath)) return;
    try {
      const data: EncryptedStoreFile = JSON.parse(readFileSync(this.encryptedFilePath, 'utf-8'));
      const storeFile: StoreFile = JSON.parse(this.decrypt(data.blob));
      this.entries = storeFile.entries ?? [];
      this.prune(Date.now());
    } catch (err) {
      console.error(`[OutcomeOutbox] Could not decrypt ${this.encryptedFilePath}:`, err);
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

// ─── Delivery line + the one wrapper ────────────────────────────────────────

/** One labelled line per outcome, exactly as decision 3 specifies. */
export function formatOutcomeLine(e: OutcomeOutboxEntry): string {
  const what =
    e.outcome === 'change_needed' ? `SENT BACK FOR A CHANGE by ${e.who}: "${e.note ?? ''}"`
    : e.outcome === 'replaced' ? `REPLACED by the person's own mandate`
    : `REJECTED by ${e.who}`;
  return `[Suveren gateway] Since your last call: proposal ${e.proposalId} was ${what}.`;
}

type ToolResult = { content: Array<{ type: string; text?: string } & Record<string, unknown>>; [k: string]: unknown };

/**
 * The ONE wrapper (decision 3) — applied at every `server.registerTool`
 * call site in index.ts, for proxied, builtin AND gateway tools alike.
 * Never applied to an internal tool (those are never registered with the
 * MCP server at all — see index.ts's `if (tool.internal) continue`) nor to
 * a `/internal/*` control-plane<->MCP-server route (this wraps an MCP tool
 * handler, not an HTTP route).
 *
 * On every call: deliver whatever is undelivered, mark it delivered, append
 * ONE extra text content item (one line per outcome) to the REAL reply.
 * Nothing to deliver -> the reply is returned completely unchanged.
 *
 * Untyped on purpose (`any`) — the MCP SDK's `registerTool` is generic over
 * each tool's own zod input shape, so there is no single handler type to
 * preserve here; the caller casts back to what `registerTool` expects, the
 * same way index.ts already casts a proxied tool's handler (see its
 * `as Parameters<typeof server.registerTool>[2]`).
 *
 * Tolerates a missing/undefined `outbox` (a test's partial `SharedState`
 * mock, or any future caller that never got as far as constructing one) by
 * treating it as "nothing to deliver" — delivering a courtesy notice must
 * never be why the REAL reply a tool call depends on fails to come back.
 */
export function wrapWithOutcomeOutbox(
  outbox: OutcomeOutbox | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...args: any[]) => unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): (...args: any[]) => Promise<unknown> {
  return async (...args: unknown[]) => {
    const result = (await handler(...args)) as ToolResult | undefined;
    if (!outbox) return result;
    const pending = outbox.getUndelivered();
    if (pending.length === 0) return result;
    // A malformed reply (no `content` array) cannot actually carry the
    // line — leave the entries undelivered so a later, well-formed reply
    // still gets the chance, rather than mark-and-lose them here.
    if (!result || !Array.isArray(result.content)) return result;
    outbox.markDelivered(pending.map(e => e.proposalId));
    const note = pending.map(formatOutcomeLine).join('\n');
    return { ...result, content: [...result.content, { type: 'text' as const, text: note }] };
  };
}
