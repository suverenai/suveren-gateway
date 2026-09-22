import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The Agent Brief — user-authored standing orders for MCP-connecting agents.
 *
 * Plaintext markdown at `${SUVEREN_DATA_DIR}/context.md` (default
 * `~/.suveren/context.md`). The MCP server reads the same file
 * (context-loader.ts) and prepends it to every agent session; the control
 * plane serves it to the Agent Brief editor and hands it to the intent
 * assistant so the two documents don't contradict each other.
 */

/** 16 KB cap — plenty for standing orders. Enforced on write in index.ts. */
export const AGENT_CONTEXT_MAX_BYTES = 16 * 1024;

export function agentBriefPath(): string {
  const dataDir = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
  return join(dataDir, 'context.md');
}

/** Current brief, or '' when none has been written yet. */
export function readAgentBrief(): string {
  const filePath = agentBriefPath();
  if (!existsSync(filePath)) return '';
  return readFileSync(filePath, 'utf-8');
}
