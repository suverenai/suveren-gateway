/**
 * Execution Journal — the Gatekeeper's record of which tickets it has executed.
 *
 * The protocol guarantees ONE TICKET PER LOGICAL EXECUTION (Cumulative
 * Tracking rule 5): the AS dedups a retried ticket request and returns the
 * original ticket. It does not — and cannot — guarantee ONE EXECUTION PER
 * TICKET, because only the Gatekeeper knows whether it went on to call the
 * tool. This journal is that other half.
 *
 * Why it exists: on 2026-09-04 one gateway process executed a committed
 * proposal twice. Two triggers (the control-plane's post-resolve nudge and the
 * poll loop) both requested a ticket; the second arrived after the proposal
 * had transitioned and received the ORIGINAL ticket back, exactly as the spec
 * says a same-caller retry should. Nothing then stopped the tool from running
 * again. A replayed ticket is a recovery signal for a lost response, not an
 * authorization to act twice — but without a record of what already ran, the
 * two are indistinguishable.
 *
 * Write-ahead by design: `begin()` is persisted BEFORE the tool is called, so
 * a crash between the call and `complete()` leaves an `intent` row rather
 * than nothing. That row is the honest state — "started, outcome unknown" —
 * and callers surface it instead of guessing.
 *
 * Plaintext on purpose: rows hold ticket ids, tool names, and an argument
 * hash — no content, no addresses, no amounts. Keeping it readable without
 * the vault key lets a second process on the same data directory consult it
 * before it acts, which is the cross-process case an in-memory lock cannot
 * reach. Every read goes back to disk for the same reason.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

export type JournalState = 'intent' | 'done' | 'failed';

export interface JournalEntry {
  /** The ticket (receipt) id this execution ran under. Primary key. */
  ticketId: string;
  /** Review path only — the proposal the ticket executed. */
  proposalId?: string;
  /** Namespaced tool name, e.g. `deploy-github__release`. */
  tool: string;
  /** Stable hash of the tool arguments, so a replay with different args is visible. */
  argsHash: string;
  state: JournalState;
  /** Unix seconds. */
  startedAt: number;
  finishedAt?: number;
  /** Process that wrote the row — diagnostic only. */
  pid: number;
}

interface JournalFile {
  version: 1;
  entries: JournalEntry[];
}

const DEFAULT_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
const FILE_NAME = 'execution-journal.json';
/** Rows older than this are pruned. Longer than any ticket validity window in use. */
const MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

export type BeginResult =
  | { ok: true }
  | { ok: false; existing: JournalEntry };

/**
 * Stable hash over tool arguments: keys sorted at every level, so two
 * structurally equal argument objects hash the same regardless of insertion
 * order. Not JCS — this never leaves the machine and is compared only with
 * itself.
 */
export function hashToolArgs(args: unknown): string {
  return 'sha256:' + createHash('sha256').update(stableStringify(args)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export class ExecutionJournal {
  private readonly filePath: string;

  constructor(filePath?: string) {
    const baseDir = filePath && filePath.endsWith('.json') ? dirname(filePath) : (filePath ?? DEFAULT_DIR);
    this.filePath = join(baseDir, FILE_NAME);
  }

  /** Look a ticket up. Always reads from disk — another process may have written. */
  get(ticketId: string): JournalEntry | undefined {
    return this.load().entries.find(e => e.ticketId === ticketId);
  }

  /**
   * Record intent to execute under `ticketId`. Refuses if any row for that
   * ticket already exists, whatever its state — deciding what an existing row
   * means is the caller's job, and it differs by state (see commitments.ts).
   */
  begin(entry: Omit<JournalEntry, 'state' | 'startedAt' | 'pid'>): BeginResult {
    const file = this.load();
    const existing = file.entries.find(e => e.ticketId === entry.ticketId);
    if (existing) return { ok: false, existing };
    file.entries.push({
      ...entry,
      state: 'intent',
      startedAt: nowSec(),
      pid: process.pid,
    });
    this.persist(file);
    return { ok: true };
  }

  /** Close an `intent` row. Missing row is a programming error, not a silent no-op. */
  complete(ticketId: string, state: 'done' | 'failed'): void {
    const file = this.load();
    const row = file.entries.find(e => e.ticketId === ticketId);
    if (!row) throw new Error(`execution journal: no row for ticket ${ticketId} to complete`);
    row.state = state;
    row.finishedAt = nowSec();
    this.persist(file);
  }

  /** All rows, newest last. Diagnostic. */
  getAll(): JournalEntry[] {
    return [...this.load().entries];
  }

  // ─── Persistence ────────────────────────────────────────────────────────

  private load(): JournalFile {
    if (!existsSync(this.filePath)) return { version: 1, entries: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as JournalFile;
      if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) {
        throw new Error('unexpected shape');
      }
      return parsed;
    } catch (err) {
      // An unreadable journal must not become "nothing has ever executed".
      // Fail loudly: the caller refuses to execute rather than risk a repeat.
      throw new Error(
        `execution journal at ${this.filePath} is unreadable (${err instanceof Error ? err.message : String(err)}); ` +
          'refusing to execute until it is inspected',
      );
    }
  }

  private persist(file: JournalFile): void {
    const cutoff = nowSec() - MAX_AGE_SECONDS;
    file.entries = file.entries.filter(e => e.startedAt >= cutoff);
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    // Write-then-rename so a crash mid-write cannot leave a truncated file
    // that the next start reads as "nothing executed".
    const tmp = this.filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
