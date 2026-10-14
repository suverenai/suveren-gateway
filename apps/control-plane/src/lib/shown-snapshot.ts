/**
 * AU10 §8.4 — "What you saw" snapshot (doc/au10-request-context.md §4 + §8.4).
 *
 * On approve / "change needed" / reject, the UI sends the EXACT payload it
 * rendered (the AU8 preview result, the AU10 request/history result, and the
 * read time) — "so no second read can differ" (§8.4). This module hashes that
 * payload (JCS -> sha256, same construction as `computeProposalContentHash`
 * in content-crypto.ts) and stores it locally, encrypted at rest.
 *
 * Encryption: the gateway's OTHER local, keyed-by-id encrypted stores
 * (`gates.enc.json`, `execution-log.enc.json`) use the control plane's own
 * `Vault` (AES-256-GCM, key derived from the signed-in user's API key via
 * PBKDF2 — vault.ts) — this reuses that exact primitive (`vault.encrypt`/
 * `vault.decrypt`) rather than hap-core or a new scheme. NOTE: the execution
 * JOURNAL itself (apps/mcp-server/src/lib/execution-journal.ts) is plaintext
 * BY DESIGN (ticket ids/tool names only, so a second process can read it
 * without the vault key) — this store holds the opposite: full card content
 * (customer names, emails, quote values), so it follows the ENCRYPTED
 * siblings' scheme, not the journal's own.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalize } from '@hap/core';
import type { Vault, EncryptedBlob } from './vault';

/** `sha256:` + hex over JCS(snapshot) — same construction as
 *  content-crypto.ts's `computeProposalContentHash`, applied to the card's
 *  rendered payload instead of the proposal's tool args. */
export function computeShownHash(snapshot: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalize(snapshot)).digest('hex')}`;
}

export interface ShownSnapshotEntry {
  shownHash: string;
  snapshot: unknown;
  storedAt: number;
}

interface SnapshotFile {
  version: 1;
  entries: Record<string, EncryptedBlob>;
}

const DEFAULT_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
const FILE_NAME = 'shown-snapshots.enc.json';

/** Matches the execution journal's own retention window (90 days) — "removed
 *  together with the journal entry of the ticket" (doc §8.4): both age out on
 *  the same clock, since nothing here is keyed to look the journal up directly. */
export const SHOWN_SNAPSHOT_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

/**
 * Keyed by proposal id, one independently encrypted blob per entry — the
 * same per-entry shape `GateStore` uses for `gates.enc.json`, picked because
 * a snapshot is looked up by a single id, never iterated whole (unlike
 * `ExecutionLog`'s one-blob-for-everything).
 */
export class ShownSnapshotStore {
  private readonly filePath: string;

  constructor(dataDir?: string) {
    this.filePath = join(dataDir ?? DEFAULT_DIR, FILE_NAME);
  }

  /** Hashes + stores `snapshot` for `proposalId`, returning the hash to send
   *  with the decision. Requires an unlocked vault — callers already require
   *  an AS session (and therefore an unlocked vault) to reach this path.
   *  Opportunistically prunes expired entries first (doc §8.4's retention —
   *  this store has no in-memory cache to prune on every write the way
   *  `ExecutionLog` does, so a decision call is the one guaranteed moment
   *  the vault key is in hand). */
  save(proposalId: string, snapshot: unknown, vault: Vault): string {
    this.pruneWithVault(vault);
    const shownHash = computeShownHash(snapshot);
    const entry: ShownSnapshotEntry = { shownHash, snapshot, storedAt: Math.floor(Date.now() / 1000) };
    const file = this.load();
    file.entries[proposalId] = vault.encrypt(JSON.stringify(entry));
    this.persist(file);
    return shownHash;
  }

  /** Returns the stored entry, or null if none exists (off-device / never
   *  approved on this gateway — doc §8.4's "only on the approving gateway"). */
  get(proposalId: string, vault: Vault): ShownSnapshotEntry | null {
    const file = this.load();
    const blob = file.entries[proposalId];
    if (!blob) return null;
    try {
      return JSON.parse(vault.decrypt(blob)) as ShownSnapshotEntry;
    } catch {
      return null;
    }
  }

  remove(proposalId: string): void {
    const file = this.load();
    if (!(proposalId in file.entries)) return;
    delete file.entries[proposalId];
    this.persist(file);
  }

  /**
   * Drops entries older than {@link SHOWN_SNAPSHOT_MAX_AGE_SECONDS}. `storedAt`
   * lives INSIDE each encrypted blob, so this needs the vault key — called
   * once per unlock (same trigger as `ExecutionLog`'s own migration-on-
   * unlock), not on a timer while locked.
   */
  pruneWithVault(vault: Vault, now: number = Math.floor(Date.now() / 1000)): void {
    const file = this.load();
    const cutoff = now - SHOWN_SNAPSHOT_MAX_AGE_SECONDS;
    let changed = false;
    for (const [proposalId, blob] of Object.entries(file.entries)) {
      try {
        const entry = JSON.parse(vault.decrypt(blob)) as ShownSnapshotEntry;
        if (entry.storedAt < cutoff) {
          delete file.entries[proposalId];
          changed = true;
        }
      } catch {
        // Unreadable (e.g. a different vault key) — leave it; it ages out
        // once readable, or is removed explicitly with the ticket.
      }
    }
    if (changed) this.persist(file);
  }

  // ─── Persistence ────────────────────────────────────────────────────────

  private load(): SnapshotFile {
    if (!existsSync(this.filePath)) return { version: 1, entries: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as SnapshotFile;
      if (parsed?.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) {
        return { version: 1, entries: {} };
      }
      return parsed;
    } catch {
      return { version: 1, entries: {} };
    }
  }

  private persist(file: SnapshotFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }
}
