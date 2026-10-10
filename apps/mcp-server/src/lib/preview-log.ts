/**
 * Preview Log — local, plaintext record of AU3 preview reads (`/internal/preview`).
 *
 * Decision 1 (temp/briefs/au3-au5-brief.md): the preview read is recorded
 * locally with NO content — time, proposal id, integration, preview tool,
 * and the result status only. Plaintext on purpose, like execution-journal.ts
 * and proposal-submission-store.ts: nothing here is sensitive, so there is no
 * reason to require the vault key to read it back.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface PreviewLogEntry {
  ts: number; // Date.now() ms
  proposalId: string;
  integrationId: string;
  tool: string;
  status: 'none' | 'ok' | 'unavailable' | 'not_found';
}

interface LogFile {
  version: 1;
  entries: PreviewLogEntry[];
}

const DEFAULT_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
const FILE_NAME = 'preview-log.json';
const MAX_RECORDS = 500;
/** Longer than any plausible approval window — this is a diagnostic trail, not evidence. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export class PreviewLog {
  private readonly filePath: string;

  constructor(filePath?: string) {
    const baseDir = filePath && filePath.endsWith('.json') ? dirname(filePath) : (filePath ?? DEFAULT_DIR);
    this.filePath = join(baseDir, FILE_NAME);
  }

  /** Record one preview read. Never throws — recording must not break the read. */
  record(entry: PreviewLogEntry): void {
    try {
      const file = this.load();
      file.entries.push(entry);
      const cutoff = entry.ts - MAX_AGE_MS;
      file.entries = file.entries.filter(e => e.ts >= cutoff);
      if (file.entries.length > MAX_RECORDS) {
        file.entries = file.entries.slice(file.entries.length - MAX_RECORDS);
      }
      this.persist(file);
    } catch (err) {
      console.error('[PreviewLog] failed to record preview read:', err);
    }
  }

  /** Diagnostic only. */
  getAll(): PreviewLogEntry[] {
    return [...this.load().entries];
  }

  private load(): LogFile {
    if (!existsSync(this.filePath)) return { version: 1, entries: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as LogFile;
      return { version: 1, entries: parsed.entries ?? [] };
    } catch {
      return { version: 1, entries: [] };
    }
  }

  private persist(file: LogFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, this.filePath);
  }
}
