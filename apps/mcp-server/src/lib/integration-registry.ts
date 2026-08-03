/**
 * Integration Registry — types + persistence for downstream MCP server integrations.
 *
 * Stores integration configs in /data/integrations.json (relative to project root).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExecutionMappingValue, ProfileToolGating } from '@hap/core';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * How a tool's calls should be gated through Suveren authorization.
 * This is the runtime-resolved form used by tool-proxy.ts.
 *
 * - profile: which Suveren profile to match against (e.g., "charge").
 *   If null, tool calls are proxied without Suveren gating.
 * - executionMapping: maps tool argument names to execution context fields
 *   that the Gatekeeper checks against frame bounds.
 * - staticExecution: constant values merged into the execution context
 *   (e.g., { scope: "external" } when no tool arg provides it).
 */
/**
 * Read adapter (manifest data) — how to enforce per-item read bounds for a
 * given provider's read tool, without any provider/profile literal in code.
 */
export interface ReadAdapter {
  /** Execution field the item's date maps to; ties to the profile's age bound via boundType.of. */
  ageField?: string;
  /**
   * Dotted path to the item's timestamp in the provider response (get-by-id
   * tools). Accepts a LIST when a provider returns the date in more than one
   * shape — e.g. a calendar's timed events carry `start.dateTime` while
   * all-day events carry `start.date`. The first path yielding a parseable
   * date wins; if none does the read fails closed, because an unreadable date
   * must never be treated as "inside the window".
   */
  resultDatePath?: string | string[];
  /**
   * Tool argument holding the EARLIEST point a read may reach, clamped to
   * (now − window) before the call goes out. Does for time-range APIs
   * (calendar, chat history, logs) what `ageConstraint` does for search
   * strings.
   *
   * Applied whether or not the agent supplied the argument: at most providers
   * an omitted lower bound means "all history", which is exactly what the
   * window exists to prevent. An agent-supplied bound that is already tighter
   * is left alone — the clamp only ever narrows.
   */
  ageFloorArg?: string;
  /**
   * How to render the clamped floor into `ageFloorArg`: RFC3339 (default), or
   * epoch numbers. Provider data — the engine learns no provider's time
   * format. Slack's `oldest`, for instance, is epoch seconds.
   */
  ageFloorFormat?: 'iso' | 'epoch_ms' | 'epoch_s';
  /** Search-query arg to inject age/scope ceilings into (list/search tools). */
  queryArg?: string;
  /**
   * Provider template for the injected age clause. Two placeholders, so both
   * families of query syntax are declarable without engine changes:
   *   `{days}` — relative age, e.g. Gmail's "newer_than:{days}d"
   *   `{date}` — absolute YYYY-MM-DD floor, e.g. Slack's "after:{date}"
   */
  ageConstraint?: string;
  /**
   * Regex (first capture group = days) matching an agent clause that asks for
   * data OLDER than some age. Used to refuse audibly instead of ANDing the
   * ceiling on and returning a contradictory empty set, which the agent would
   * report as "nothing exists". Declared per manifest so the engine never
   * learns any provider's query syntax.
   */
  ageConflictPattern?: string;
  /** Dotted path to the participant headers array (`[{name,value}]`) in the response. */
  participantsPath?: string;
  /** Header names carrying correspondents, e.g. ["From","To"]. */
  participantHeaders?: string[];
  /** Provider template for a per-correspondent scope term, e.g. "(from:{v} OR to:{v})". */
  scopeTermTemplate?: string;
  // ── Resource scope on reads (F7) — which container the read may touch ────────
  /** Authority context field listing permitted container ids (e.g. "allowed_calendars"). */
  resourceBound?: string;
  /** Single-value tool arg naming the requested container (e.g. "calendarId"). */
  resourceArg?: string;
  /** Array-value tool arg naming requested containers (e.g. "calendarIds"). */
  resourceArrayArg?: string;
  /** Container value(s) the provider defaults to when the arg is omitted (e.g. "primary"). Still checked. */
  resourceDefault?: string;
  /** For enumeration tools: dotted path to each result item's container id (e.g. "id"). Post-filters results. */
  resultResourcePath?: string;
  // ── Fixed container exclusion (F7 interim — e.g. never read SPAM/TRASH) ──────
  /** Args force-set on every call, overriding agent input (e.g. { "includeSpamTrash": false }). */
  pinnedArgs?: Record<string, string | number | boolean>;
  /** Forbidden values — a get-by-id whose item carries one (at `resultValuesPath`) is blocked. */
  blockResultValues?: string[];
  /** Dotted path to the item's value(s) checked against `blockResultValues` (e.g. "labelIds"). */
  resultValuesPath?: string;
}

export interface ToolGatingConfig {
  profile: string | null;
  executionMapping: Record<string, ExecutionMappingValue>;
  staticExecution?: Record<string, string | number>;
  /**
   * Tool category:
   * - 'read'     — read-only; requires authorization + any declared read gate,
   *                but no write execution-context verification.
   * - 'disabled' — declared unavailable by the manifest; always blocked.
   */
  category?: 'read' | 'disabled';
  /** Static read gate (manifest): the bound that must hold to use a read tool. */
  boundField?: string;
  /** The exact value `boundField` must have for the read to be permitted. */
  requiredValue?: string;
  /** Per-item read enforcement descriptor (age/scope) for read tools. */
  read?: ReadAdapter;
  /**
   * Explicit read-governance exemption (F9). A `category:"read"` tool must be
   * governed — a static gate, a read adapter, OR this exemption. `"none"`
   * declares "this read carries no per-item limit, and that is intentional",
   * and MUST be accompanied by `readGovernanceReason`. Absent all three, the
   * read is DENIED (fail closed) — absence of config is never absence of intent.
   */
  readGovernance?: 'none';
  /** Human-readable justification for a `readGovernance:"none"` exemption. */
  readGovernanceReason?: string;
  /**
   * Which argument carries the content the receipt binds to, for a profile
   * declaring `content_binding` with `kind:"text"`.
   *
   * Without this the field is auto-detected from a fixed prose vocabulary
   * (`body`/`text`/`description`/`content`). That works for a message and fails
   * SILENTLY for everything else: a deploy binds a commit SHA, an
   * infrastructure change binds a plan hash, a record binds an id. None is
   * called "body", so no hash is produced, no binding reaches the receipt, and
   * nothing reports a problem — the receipt simply proves less than it appears
   * to.
   *
   * Deliberately separate from the FOOTER's content field. The footer appends
   * a verification line to prose; appending it to a commit SHA would corrupt
   * the value being deployed. Binding and footer are different questions about
   * the same call, and conflating them breaks non-prose connectors.
   */
  contentField?: string;

  /**
   * Arguments this tool must not accept, removed from the schema the agent
   * sees and refused if sent anyway.
   *
   * A downstream server's schema reaches the agent unchanged, so a connector
   * can hand out a bypass simply by offering one. Gmail's `send_message` takes
   * `raw` — a whole pre-encoded message — and its own description states that
   * raw causes to/cc/subject/body to be ignored. Every control we have reads
   * those fields: the recipient scope, the content binding, the approval card.
   * A call using `raw` carried its recipients and its text somewhere none of
   * them looked.
   *
   * Blocking is the narrow half of the defence: exact, but only for holes we
   * already know about. The general half is `requiredFor` in the profile, which
   * refuses any call hiding a dimension the grant constrains — including the
   * next escape hatch, which will not be called `raw`.
   *
   * Removing the argument is prevention, not enforcement: a schema is advice an
   * agent may ignore, so the call is refused as well.
   */
  blockedArgs?: string[];

  /**
   * Transport encoding to apply to an outgoing argument, per field.
   *
   * A content binding hashes what the human approved. If the transport mangles
   * a BOUND value on the way out, the receipt still verifies against the
   * approved bytes while the recipient — holding the mangled copy — cannot
   * reproduce it. The binding then cries wolf on honest mail, which is worse
   * than no binding.
   *
   * Live case: RFC 5322 headers are ASCII-only. Gmail's connector writes
   * `Subject: <raw utf-8>`, so an em-dash arrived as `Ã¢Â€Â”` and the subject
   * could not be verified. Declaring `{ subject: "rfc2047" }` makes the
   * gateway emit a proper encoded-word.
   *
   * The engine owns the encodings; the manifest only says which argument needs
   * which one — so a new connector with the same problem is a manifest line,
   * not a code change. Applied LAST, after the hash and the footer: encoding
   * before hashing would bind the wire form instead of what was approved.
   */
  argEncoding?: Record<string, string>;
}

/**
 * Configuration for a downstream MCP server integration.
 */
export interface IntegrationConfig {
  /** Unique integration identifier (e.g., "stripe", "sendgrid") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Command to spawn the MCP server (e.g., "npx", "node") */
  command: string;
  /** Arguments to the command (e.g., ["-y", "@stripe/mcp-server"]) */
  args: string[];
  /**
   * Environment variable mapping: { ENV_VAR_NAME: "vault.key.path" }
   * Resolved from serviceCredentials Map at spawn time.
   * Example: { "STRIPE_API_KEY": "stripe.apiKey" }
   */
  envKeys: Record<string, string>;
  /**
   * Optional environment variable mapping — same format as envKeys but
   * won't block startup if unresolved. Resolved if available in vault.
   */
  optionalEnvKeys?: Record<string, string>;
  /** Static environment variables for the MCP process (e.g., { PORT: "0" }) */
  env?: Record<string, string>;
  /** Suveren profile ID for tool gating (e.g., "charge"). Null = ungated. */
  profile: string | null;
  /** Tool gating from integration manifest (preferred over profile's toolGating). */
  toolGating?: ProfileToolGating;
  /** npm package to install on-demand (e.g., "@humanagencyp/crm-mcp") */
  npmPackage?: string;
  /** Whether this integration should be spawned on startup */
  enabled: boolean;
  /**
   * LOCAL read-age window (days) — how far back the agent may read on this
   * integration. Set here rather than in a signed grant because read policy is
   * enforced only by the local Gatekeeper: a limit lives in the same trust
   * domain as its enforcement (see `content/0.5/protocol.md` → *Bounds,
   * Context, and Read Policy*). Being local, it is live-editable — a change
   * applies to the next read, with no re-attestation.
   *
   * Undefined = not set here; the read path then falls back to the signed
   * `read_max_age_days` grant bound. If NEITHER is set, reads fail closed
   * (F11) — an unbounded read window is never inferred.
   *
   * 0 is meaningful and distinct from undefined: "read nothing".
   */
  readAgeDays?: number;
}

// ─── Persistence ────────────────────────────────────────────────────────────

interface IntegrationsFile {
  version: 1;
  integrations: IntegrationConfig[];
}

const DEFAULT_DATA_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');

export class IntegrationRegistry {
  private integrations = new Map<string, IntegrationConfig>();
  private filePath: string;

  constructor(dataDir?: string) {
    const dir = dataDir ?? DEFAULT_DATA_DIR;
    this.filePath = join(dir, 'integrations.json');
    this.load();
  }

  // ─── CRUD ───────────────────────────────────────────────────────────────

  get(id: string): IntegrationConfig | undefined {
    return this.integrations.get(id);
  }

  getAll(): IntegrationConfig[] {
    return Array.from(this.integrations.values());
  }

  getEnabled(): IntegrationConfig[] {
    return this.getAll().filter(i => i.enabled);
  }

  add(config: IntegrationConfig): void {
    this.integrations.set(config.id, config);
    this.save();
  }

  update(id: string, updates: Partial<Omit<IntegrationConfig, 'id'>>): boolean {
    const existing = this.integrations.get(id);
    if (!existing) return false;
    this.integrations.set(id, { ...existing, ...updates });
    this.save();
    return true;
  }

  remove(id: string): boolean {
    const deleted = this.integrations.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  // ─── Load / Save ────────────────────────────────────────────────────────

  private load(): void {
    if (!existsSync(this.filePath)) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      return;
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data: IntegrationsFile = JSON.parse(raw);
      // Migrate old format: toolGating.profile → profile
      const migrated = data.integrations.map(i => {
        if ('toolGating' in i && !('profile' in i)) {
          // Legacy shape (pre-`profile`): the typed config narrows `i` to never
          // in this branch, so read fields through a concrete legacy cast.
          const old = i as unknown as {
            id: string; name: string; command: string; args: string[];
            envKeys: Record<string, string>; enabled: boolean;
            toolGating?: { profile?: string } | null;
          };
          const config: IntegrationConfig = {
            id: old.id,
            name: old.name,
            command: old.command,
            args: old.args,
            envKeys: old.envKeys,
            profile: old.toolGating?.profile ?? null,
            enabled: old.enabled,
          };
          return config;
        }
        return i;
      });
      this.integrations = new Map(migrated.map(i => [i.id, i]));
    } catch {
      console.error(`[IntegrationRegistry] Could not parse ${this.filePath}, starting fresh`);
      this.integrations = new Map();
    }
  }

  private save(): void {
    const data: IntegrationsFile = {
      version: 1,
      integrations: Array.from(this.integrations.values()),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), { encoding: 'utf-8' });
  }
}
