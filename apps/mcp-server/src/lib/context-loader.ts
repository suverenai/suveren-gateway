/**
 * Context Loader — reads org/domain context from a user-maintained markdown file.
 *
 * The file at `${HAP_DATA_DIR}/context.md` (default: `~/.hap/context.md`) is written
 * by the human decision owner and included in the agent's mandate brief.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_DIR = process.env.HAP_DATA_DIR ?? join(homedir(), '.hap');

/** Maximum chars to include in the mandate brief before truncating. */
const BRIEF_MAX_CHARS = 1000;

/**
 * Read the context file. Returns null if the file doesn't exist.
 */
export function readContextFile(dataDir?: string): string | null {
  const dir = dataDir ?? DEFAULT_DIR;
  const filePath = join(dir, 'context.md');

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
