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
export interface ToolGatingConfig {
  profile: string | null;
  executionMapping: Record<string, ExecutionMappingValue>;
  staticExecution?: Record<string, string | number>;
  /** Read-only tools: require authorization but no execution context checks */
  category?: 'read';
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
          const old = i as unknown as Record<string, unknown>;
          const toolGating = old.toolGating as { profile?: string } | null;
          const config: IntegrationConfig = {
            id: i.id,
            name: i.name,
            command: i.command,
            args: i.args,
            envKeys: i.envKeys,
            profile: toolGating?.profile ?? null,
            enabled: i.enabled,
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
