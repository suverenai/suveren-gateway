/**
 * Agent contact — has a person's AI ever connected to this gateway, and which one?
 *
 * The dashboard's first-run card shows "Connect your AI" as done once any MCP
 * client has completed an initialize handshake, with the client's own name
 * (MCP `clientInfo.name`, e.g. "claude-ai", "Claude Code") and when it was
 * last seen. "Connected right now" would be the wrong signal: Claude Desktop
 * only holds a session while it is open, so a person who closed it between
 * visits would be told to connect again.
 *
 * Stored as plain JSON in `<dataDir>/agent-contact.json` — a client name and
 * two timestamps, nothing a session carried. Writes are throttled: the first
 * contact and a new client name are written at once, a repeat contact by the
 * same client at most once a minute.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface AgentContact {
  /** The client name from the latest contact. */
  clientName: string;
  clientVersion?: string;
  /** ISO 8601. */
  firstSeenAt: string;
  lastSeenAt: string;
}

const FILE = 'agent-contact.json';
const REWRITE_AFTER_MS = 60_000;

export class AgentContactStore {
  private readonly path: string;
  private current: AgentContact | null;

  constructor(dataDir: string) {
    this.path = join(dataDir, FILE);
    this.current = this.load();
  }

  private load(): AgentContact | null {
    if (!existsSync(this.path)) return null;
    try {
      const v = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<AgentContact>;
      if (typeof v.clientName !== 'string' || typeof v.firstSeenAt !== 'string' || typeof v.lastSeenAt !== 'string') return null;
      return { clientName: v.clientName, clientVersion: v.clientVersion, firstSeenAt: v.firstSeenAt, lastSeenAt: v.lastSeenAt };
    } catch {
      return null;
    }
  }

  read(): AgentContact | null {
    return this.current;
  }

  /** Record a completed MCP initialize. `now` is injectable for tests. */
  record(client: { name?: string; version?: string } | undefined, now: Date = new Date()): void {
    const clientName = client?.name?.trim() || 'Unknown AI client';
    const prev = this.current;
    const due = !prev
      || prev.clientName !== clientName
      || now.getTime() - Date.parse(prev.lastSeenAt) >= REWRITE_AFTER_MS;
    this.current = {
      clientName,
      clientVersion: client?.version,
      firstSeenAt: prev?.firstSeenAt ?? now.toISOString(),
      lastSeenAt: now.toISOString(),
    };
    if (!due) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.current, null, 2));
      renameSync(tmp, this.path);
    } catch (err) {
      // Losing a timestamp only means the card asks again; never break a session over it.
      console.error('[Suveren MCP] Could not save agent contact:', err);
    }
  }
}
