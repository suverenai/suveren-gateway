/**
 * Integration Manager — spawns downstream MCP servers, discovers their tools,
 * manages lifecycle, and proxies tool calls.
 *
 * Each downstream server runs as a child process communicating via stdio.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getProfile } from '@hap/core';
import type { ProfileToolGating } from '@hap/core';
import type { IntegrationConfig, ToolGatingConfig } from './integration-registry';

const DEFAULT_DATA_DIR = process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
// Runtime INSTALL directory for downstream MCP npm packages (e.g. crm-mcp,
// records-mcp). We write package.json here and run `npm install` to land
// node_modules/.
//
// Must NOT be pointed at the checked-in manifest source dir
// (content/integrations/) — doing so leaks package.json, package-lock.json,
// and ~53 MB of node_modules/ straight into the repo. The two concerns used
// to share one env var; now manifest-loader uses SUVEREN_MANIFESTS_DIR and this
// module owns SUVEREN_INTEGRATIONS_DIR exclusively.
//
// Integration node_modules (native binaries like better-sqlite3) are arch-
// specific. In docker, SUVEREN_INTEGRATIONS_DIR should point outside the mounted
// host volume so a macOS ↔ Linux host never sees the other's .node files.
// Defaults to DEFAULT_DATA_DIR/integrations (~/.suveren/integrations) for local
// dev, which is fine because the host arch never changes.
const INTEGRATIONS_DIR = process.env.SUVEREN_INTEGRATIONS_DIR ?? join(DEFAULT_DATA_DIR, 'integrations');
const INTEGRATIONS_BIN = join(INTEGRATIONS_DIR, 'node_modules', '.bin');

/**
 * Build PATH that includes the managed integrations directory
 * so on-demand installed MCP server binaries are found.
 */
function buildPath(): string {
  const base = process.env.PATH ?? '';
  return [INTEGRATIONS_BIN, base].join(':');
}

/**
 * Ensure the integrations directory has a package.json.
 */
function ensureIntegrationsDir(): void {
  if (!existsSync(INTEGRATIONS_DIR)) {
    mkdirSync(INTEGRATIONS_DIR, { recursive: true });
  }
  const pkgPath = join(INTEGRATIONS_DIR, 'package.json');
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, JSON.stringify({ name: 'suveren-integrations', version: '1.0.0', private: true }, null, 2));
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DiscoveredTool {
  originalName: string;
  namespacedName: string;
  integrationId: string;
  description: string;
  inputSchema: Record<string, unknown>;
  gating: ToolGatingConfig | null;
}

export interface IntegrationStatus {
  id: string;
  name: string;
  running: boolean;
  toolCount: number;
  error?: string;
}

interface RunningIntegration {
  config: IntegrationConfig;
  client: Client;
  transport: StdioClientTransport;
  tools: DiscoveredTool[];
  respawnAttempts: number;
}

// ─── Manager ────────────────────────────────────────────────────────────────

const RESPAWN_DELAYS = [2000, 4000, 6000]; // backoff delays in ms
const MAX_RESPAWN_ATTEMPTS = 3;

export class IntegrationManager {
  private running = new Map<string, RunningIntegration>();
  private onToolsChanged: (() => void) | null = null;

  constructor(private serviceCredentials: Map<string, Record<string, string>>) {}

  /**
   * Register a callback invoked when the tool set changes
   * (integration started, stopped, or crashed).
   */
  setOnToolsChanged(cb: () => void): void {
    this.onToolsChanged = cb;
  }

  /**
   * Install an npm package into the managed integrations directory if not already present.
   * Called automatically before spawning when config.npmPackage is set.
   */
  private ensureInstalled(npmPackage: string): void {
    ensureIntegrationsDir();

    // Check if already installed
    const binName = npmPackage.split('/').pop()?.replace(/^@/, '') ?? npmPackage;
    const installed = existsSync(join(INTEGRATIONS_DIR, 'node_modules', ...npmPackage.split('/')));
    if (installed) return;

    console.error(`[IntegrationManager] Installing ${npmPackage}...`);
    try {
      execSync(`npm install --no-fund --no-audit ${npmPackage}`, {
        cwd: INTEGRATIONS_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000,
      });
      console.error(`[IntegrationManager] Installed ${npmPackage}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to install ${npmPackage}: ${message}`);
    }
  }

  /**
   * Start a downstream MCP server integration.
   * Installs npm package on-demand if needed, resolves envKeys,
   * spawns the process, connects as MCP client, and discovers tools.
   */
  async startIntegration(config: IntegrationConfig): Promise<DiscoveredTool[]> {
    // Stop if already running
    if (this.running.has(config.id)) {
      await this.stopIntegration(config.id);
    }

    // Install npm package on-demand if specified
    if (config.npmPackage) {
      this.ensureInstalled(config.npmPackage);
    }

    // Resolve environment variables from vault references
    const env = this.resolveEnvKeys(config);

    // Create stdio transport (spawns child process)
    // PATH includes ~/.suveren/integrations/node_modules/.bin for on-demand installed packages.
    // HAP_DATA_DIR is the contract sub-MCPs (crm, records, linkedin) read — they are
    // HAP-tier reference integrations and don't know about the Suveren brand. We translate
    // our internal SUVEREN_DATA_DIR to HAP_DATA_DIR here so all sub-MCPs write their
    // SQLite DBs to the same directory the gateway uses — critical in docker where
    // HOME=/root but the mounted volume is /app/data.
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: {
        ...process.env,
        PATH: buildPath(),
        HAP_DATA_DIR: DEFAULT_DATA_DIR,
        ...config.env,
        ...env,
      } as Record<string, string>,
    });

    // Create MCP client
    const client = new Client(
      { name: 'suveren-gateway', version: '0.1.0' },
      { capabilities: {} },
    );

    await client.connect(transport);
    console.error(`[IntegrationManager] Connected to ${config.id} (${config.command} ${config.args.join(' ')})`);

    // Discover tools and resolve gating — prefer manifest toolGating over profile's
    const toolsResult = await client.listTools();
    const profileGating = config.toolGating
      ?? (config.profile ? getProfile(config.profile)?.toolGating ?? null : null);

    const tools: DiscoveredTool[] = (toolsResult.tools ?? []).map(tool => {
      const gating = this.resolveToolGating(config.profile, profileGating, tool.name);

      return {
        originalName: tool.name,
        namespacedName: `${config.id}__${tool.name}`,
        integrationId: config.id,
        description: tool.description ?? '',
        inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
        gating,
      };
    });

    console.error(`[IntegrationManager] Discovered ${tools.length} tools from ${config.id}`);

    const entry: RunningIntegration = {
      config,
      client,
      transport,
      tools,
      respawnAttempts: 0,
    };
    this.running.set(config.id, entry);

    // Watch for crashes
    transport.onclose = () => {
      console.error(`[IntegrationManager] Transport closed for ${config.id}`);
      this.handleCrash(config.id);
    };

    this.onToolsChanged?.();
    return tools;
  }

  /**
   * Stop a running integration, closing its transport and removing its tools.
   */
  async stopIntegration(id: string): Promise<void> {
    const entry = this.running.get(id);
    if (!entry) return;

    // Prevent crash handler from firing during intentional stop
    entry.transport.onclose = undefined;

    try {
      await entry.client.close();
    } catch {
      // Transport may already be closed
    }

    this.running.delete(id);
    console.error(`[IntegrationManager] Stopped ${id}`);
    this.onToolsChanged?.();
  }

  /**
   * Proxy a tool call to a downstream MCP server.
   */
  async callTool(
    integrationId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const entry = this.running.get(integrationId);
    if (!entry) {
      return {
        content: [{ type: 'text', text: `Integration "${integrationId}" is not running.` }],
        isError: true,
      };
    }

    try {
      const result = await entry.client.callTool({ name: toolName, arguments: args });
      // Normalize result content to text items
      const content = (result.content as Array<{ type: string; text?: string; [k: string]: unknown }>)
        .map(item => ({
          type: item.type,
          text: item.text ?? JSON.stringify(item),
        }));
      return { content, isError: result.isError as boolean | undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Tool call failed: ${message}` }],
        isError: true,
      };
    }
  }

  /**
   * Get all discovered tools across all running integrations.
   */
  getAllTools(): DiscoveredTool[] {
    const tools: DiscoveredTool[] = [];
    for (const entry of this.running.values()) {
      tools.push(...entry.tools);
    }
    return tools;
  }

  /**
   * Get status info for all known integrations.
   */
  getStatus(allConfigs?: IntegrationConfig[]): IntegrationStatus[] {
    const statuses: IntegrationStatus[] = [];

    // Running integrations
    for (const entry of this.running.values()) {
      statuses.push({
        id: entry.config.id,
        name: entry.config.name,
        running: true,
        toolCount: entry.tools.length,
      });
    }

    // Add non-running configs if provided
    if (allConfigs) {
      for (const config of allConfigs) {
        if (!this.running.has(config.id)) {
          statuses.push({
            id: config.id,
            name: config.name,
            running: false,
            toolCount: 0,
          });
        }
      }
    }

    return statuses;
  }

  /**
   * Check if an integration is running.
   */
  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /**
   * Check if all required env keys for an integration can be resolved.
   */
  canResolveEnvKeys(config: IntegrationConfig): boolean {
    for (const vaultRef of Object.values(config.envKeys)) {
      const [serviceId, key] = vaultRef.split('.', 2);
      const creds = this.serviceCredentials.get(serviceId);
      if (!creds || !(key in creds)) return false;
    }
    return true;
  }

  /**
   * Read the credentials stored in memory for a given service id. Used by
   * startup diagnostics to report which keys are missing when an integration
   * cannot start — not a general read API.
   */
  getServiceCredentials(serviceId: string): Record<string, string> | undefined {
    return this.serviceCredentials.get(serviceId);
  }

  /**
   * Gracefully shut down all running integrations.
   */
  async shutdown(): Promise<void> {
    const ids = Array.from(this.running.keys());
    await Promise.allSettled(ids.map(id => this.stopIntegration(id)));
    console.error(`[IntegrationManager] All integrations shut down`);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * Resolve envKeys from serviceCredentials.
   * Format: { "STRIPE_API_KEY": "stripe.apiKey" } → looks up serviceCredentials.get("stripe")?.apiKey
   */
  private resolveEnvKeys(config: IntegrationConfig): Record<string, string> {
    const env: Record<string, string> = {};
    // Resolve required keys
    for (const [envVar, vaultRef] of Object.entries(config.envKeys)) {
      const [serviceId, key] = vaultRef.split('.', 2);
      const creds = this.serviceCredentials.get(serviceId);
      if (creds && key in creds) {
        env[envVar] = creds[key];
      }
    }
    // Resolve optional keys (best-effort, won't block startup)
    for (const [envVar, vaultRef] of Object.entries(config.optionalEnvKeys ?? {})) {
      const [serviceId, key] = vaultRef.split('.', 2);
      const creds = this.serviceCredentials.get(serviceId);
      if (creds && key in creds) {
        env[envVar] = creds[key];
      }
    }
    return env;
  }

  /**
   * Resolve gating config for a tool from the profile's toolGating section.
   * Returns the runtime ToolGatingConfig that tool-proxy.ts consumes.
   */
  private resolveToolGating(
    profileId: string | null,
    profileGating: ProfileToolGating | null,
    toolName: string,
  ): ToolGatingConfig | null {
    if (!profileId || !profileGating) return null;

    // Check overrides first
    if (profileGating.overrides && toolName in profileGating.overrides) {
      const override = profileGating.overrides[toolName];
      // null override or { category: "read" } = read-only tool (still requires authorization)
      if (override === null || (override as { category?: string }).category === 'read') {
        return {
          profile: profileId,
          executionMapping: {},
          category: 'read',
        };
      }
      return {
        profile: profileId,
        executionMapping: override.executionMapping,
        staticExecution: override.staticExecution,
      };
    }

    // Fall back to default
    return {
      profile: profileId,
      executionMapping: profileGating.default.executionMapping,
      staticExecution: profileGating.default.staticExecution,
    };
  }

  /**
   * Handle a downstream process crash — attempt respawn with backoff.
   */
  private handleCrash(id: string): void {
    const entry = this.running.get(id);
    if (!entry) return;

    const attempts = entry.respawnAttempts;
    this.running.delete(id);
    this.onToolsChanged?.();

    if (attempts >= MAX_RESPAWN_ATTEMPTS) {
      console.error(`[IntegrationManager] ${id} crashed ${MAX_RESPAWN_ATTEMPTS} times, giving up`);
      return;
    }

    const delay = RESPAWN_DELAYS[attempts] ?? RESPAWN_DELAYS[RESPAWN_DELAYS.length - 1];
    console.error(`[IntegrationManager] ${id} crashed, respawning in ${delay}ms (attempt ${attempts + 1}/${MAX_RESPAWN_ATTEMPTS})`);

    setTimeout(async () => {
      try {
        await this.startIntegration(entry.config);
        // Carry forward the respawn counter
        const newEntry = this.running.get(id);
        if (newEntry) {
          newEntry.respawnAttempts = attempts + 1;
        }
      } catch (err) {
        console.error(`[IntegrationManager] Failed to respawn ${id}:`, err);
        // Try again with incremented counter
        const fakeEntry: RunningIntegration = {
          config: entry.config,
          client: null as unknown as Client,
          transport: null as unknown as StdioClientTransport,
          tools: [],
          respawnAttempts: attempts + 1,
        };
        this.running.set(id, fakeEntry);
        this.handleCrash(id);
      }
    }, delay);
  }
}
