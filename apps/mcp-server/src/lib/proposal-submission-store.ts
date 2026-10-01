/**
 * What THIS gateway submitted, for every review-mode proposal it created —
 * so that when the proposal comes back "committed" and the gateway is about
 * to execute it, it can compare against what it itself asked for instead of
 * trusting the Authority Server's echoed-back tool/args/executionContext at
 * face value (see ticket-verify.ts and commitments.ts).
 *
 * Plaintext, like execution-journal.ts (same reasoning: readable without the
 * vault key, no content — a hash of the arguments, not the arguments).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { hashToolArgs } from './execution-journal';

export interface SubmittedProposal {
  proposalId: string;
  tool: string;
  toolArgsHash: string;
  executionContextHash: string;
  authorizationId: string;
  profileId: string;
  submittedAt: number;
}

interface StoreFile {
  version: 1;
  entries: SubmittedProposal[];
}

const DEFAULT_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
const FILE_NAME = 'proposal-submissions.json';
/** Rows older than this are pruned — longer than any proposal's approval window in practice. */
const MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export class ProposalSubmissionStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    const baseDir = filePath && filePath.endsWith('.json') ? dirname(filePath) : (filePath ?? DEFAULT_DIR);
    this.filePath = join(baseDir, FILE_NAME);
  }

  /** Record what was submitted, right after a successful submitProposal(). */
  record(entry: {
    proposalId: string;
    tool: string;
    toolArgs: unknown;
    executionContext: Record<string, unknown>;
    authorizationId: string;
    profileId: string;
  }): void {
    const file = this.load();
    file.entries = file.entries.filter(e => e.proposalId !== entry.proposalId);
    file.entries.push({
      proposalId: entry.proposalId,
      tool: entry.tool,
      toolArgsHash: hashToolArgs(entry.toolArgs),
      executionContextHash: hashToolArgs(entry.executionContext),
      authorizationId: entry.authorizationId,
      profileId: entry.profileId,
      submittedAt: nowSec(),
    });
    this.persist(file);
  }

  /** Always reads from disk — another process (the poll loop lives in the
   *  same process, but this stays consistent with execution-journal.ts). */
  get(proposalId: string): SubmittedProposal | undefined {
    return this.load().entries.find(e => e.proposalId === proposalId);
  }

  private load(): StoreFile {
    if (!existsSync(this.filePath)) return { version: 1, entries: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as StoreFile;
      const cutoff = nowSec() - MAX_AGE_SECONDS;
      parsed.entries = (parsed.entries ?? []).filter(e => e.submittedAt >= cutoff);
      return parsed;
    } catch {
      return { version: 1, entries: [] };
    }
  }

  private persist(file: StoreFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    // Atomic write — a crash mid-write must not corrupt the whole file the
    // next process reads (matches execution-journal.ts).
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(file, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmpPath, this.filePath);
  }
}
