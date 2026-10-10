/**
 * Execution-journal reader (control-plane side). The MCP server's
 * execution-journal.ts WRITES `execution-journal.json`; this READS it for
 * the AU5 "what really happened" card (GET /proposals/:id/outcome).
 *
 * Plaintext, like proposal-submission-store.ts and the journal itself — same
 * reasoning: no content, just ticket ids, a tool name, and an outcome label
 * (plus, since AU4, a connector's own refusal sentence, already shown to the
 * agent/approver elsewhere). Mirrors denials-reader.ts's role for
 * denial-log.ts, minus the encryption (the journal has none).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface JournalEntryView {
  ticketId: string;
  proposalId?: string;
  tool: string;
  argsHash: string;
  state: 'intent' | 'done' | 'failed';
  outcome?: 'refused' | 'changed';
  detail?: string;
  startedAt: number;
  finishedAt?: number;
  pid: number;
}

/** Load raw journal entries from the data dir. Missing/unreadable file ⇒ []. */
export function loadJournalEntries(dataDir: string): JournalEntryView[] {
  const path = join(dataDir, 'execution-journal.json');
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { entries?: JournalEntryView[] };
    return parsed.entries ?? [];
  } catch {
    return [];
  }
}

/** The newest row for a proposal — mirrors ExecutionJournal.findByProposal. */
export function findLatestByProposal(dataDir: string, proposalId: string): JournalEntryView | undefined {
  const rows = loadJournalEntries(dataDir).filter(e => e.proposalId === proposalId);
  return rows[rows.length - 1];
}
