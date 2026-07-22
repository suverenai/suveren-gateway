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
  /** Dotted path to the item's timestamp in the provider response (get-by-id tools). */
  resultDatePath?: string;
  /** Search-query arg to inject age/scope ceilings into (list/search tools). */
  queryArg?: string;
  /** Provider template for the injected age clause, e.g. "newer_than:{days}d". */
  ageConstraint?: string;
  /** Dotted path to the participant headers array (`[{name,value}]`) in the response. */
  participantsPath?: string;
  /** Header names carrying correspondents, e.g. ["From","To"]. */
  participantHeaders?: string[];
  /** Provider template for a per-correspondent scope term, e.g. "(from:{v} OR to:{v})". */
  scopeTermTemplate?: string;
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
