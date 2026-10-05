/**
 * Context Loader — reads org/domain context from a user-maintained markdown file.
 *
 * The file at `${SUVEREN_DATA_DIR}/context.md` (default: `~/.suveren/context.md`) is written
 * by the human decision owner and included in the agent's mandate brief.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const DEFAULT_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');

/** The byte cap the control plane enforces on write (agent-brief-store.ts) — the same for every writer. */
export const CONTEXT_MAX_BYTES = 16 * 1024;

export function contextFilePath(dataDir?: string): string {
  return join(dataDir ?? DEFAULT_DIR, 'context.md');
}

/**
 * Replace the agent brief. Atomic (tmp + rename), like the control plane's PUT,
 * so a crash mid-write never leaves a half-written brief for the next session.
 * Refuses content over the cap instead of truncating it.
 */
export function writeContextFile(content: string, dataDir?: string): void {
  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes > CONTEXT_MAX_BYTES) throw new Error(`the brief is ${bytes} bytes; the limit is ${CONTEXT_MAX_BYTES}.`);
  const filePath = contextFilePath(dataDir);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filePath);
}

/**
 * Maximum chars to include in the mandate brief before truncating.
 * Aligned with the 16 KB cap the agent-brief editor and control-plane PUT
 * enforce — a brief the human saved through the UI is always delivered
 * whole. Truncation only guards against hand-edited oversized context.md
 * files (the byte cap is checked on write; this char cap can only be
 * exceeded by bypassing the UI).
 */
const BRIEF_MAX_CHARS = 16 * 1024;

/**
 * Read the context file. Returns null if the file doesn't exist.
 */
export function readContextFile(dataDir?: string): string | null {
  const filePath = contextFilePath(dataDir);

  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}

/**
 * Get context for the mandate brief — truncated if too long.
 * Returns `{ brief, full }` where brief may be truncated.
 */
export function getContextForBrief(dataDir?: string): { brief: string | null; truncated: boolean } {
  const full = readContextFile(dataDir);
  if (!full) return { brief: null, truncated: false };

  if (full.length <= BRIEF_MAX_CHARS) {
    return { brief: full, truncated: false };
  }

  const truncated = full.slice(0, BRIEF_MAX_CHARS) + '\n... (truncated — call list-authorizations for full context)';
  return { brief: truncated, truncated: true };
}
