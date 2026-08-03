/**
 * Integration Manager — spawns downstream MCP servers, discovers their tools,
 * manages lifecycle, and proxies tool calls.
 *
 * Each downstream server runs as a child process communicating via stdio.
 */

import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import { existsSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
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
  // Use the platform PATH separator (';' on Windows, ':' on POSIX). Hardcoding
  // ':' mangled PATH on Windows — drive letters (C:) contain colons — so
  // cross-spawn couldn't find the connector .cmd shims in the integrations
  // .bin folder, and every "Activate" silently failed to spawn.
  return [INTEGRATIONS_BIN, base].join(delimiter);
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
  /**
   * Local read-age window (days), or null when unset (the read path then falls
   * back to the signed grant bound). Null and 0 are different answers — 0 is
   * "read nothing" — so the UI must not collapse them.
   */
  readAgeDays: number | null;
}

/**
 * The one definition of "this config carries a usable local read age".
 *
 * Guards on type, not truthiness: `0` ("read nothing") is a real setting and
 * must not be read as "unset", which would silently fall back to the grant
 * bound and read MORE than the owner asked for.
 */
export function readAgeOf(config: Pick<IntegrationConfig, 'readAgeDays'>): number | null {
  const days = config.readAgeDays;
  return typeof days === 'number' && Number.isFinite(days) && days >= 0 ? days : null;
}

/**
 * A copy of `schema` with `blocked` properties removed, including any mention
 * in `required`. Non-destructive: the original belongs to the downstream
 * server, and a leftover `required` entry naming a property that no longer
 * exists makes the schema invalid for strict clients.
 */
export function withoutBlockedArgs(
  schema: Record<string, unknown>,
  blocked: string[] | undefined,
): Record<string, unknown> {
  if (!blocked?.length) return schema;

  const props = schema.properties as Record<string, unknown> | undefined;
  if (!props) return schema;

  const kept = Object.fromEntries(Object.entries(props).filter(([k]) => !blocked.includes(k)));
  const out: Record<string, unknown> = { ...schema, properties: kept };

  if (Array.isArray(schema.required)) {
    out.required = (schema.required as unknown[]).filter(
      r => typeof r !== 'string' || !blocked.includes(r),
    );
  }
  return out;
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
// Upper bound on the MCP handshake. Generous because a just-installed server's
// first run can be slow (native module load, cold caches), but finite so a
// crashed child can't wedge the sequential boot loop forever.
const CONNECT_TIMEOUT_MS = 30_000;

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
   * Is `npmPackage` present AND usable?
   *
   * The directory existing is not enough: an install that was interrupted
   * (timeout, Ctrl+C, antivirus lock) leaves the package directory behind
   * with no package.json and no bin shim. Treating that as "installed" made
   * every later start fail instantly on a missing binary, with no way to
   * self-repair — the user saw "Not running" and a Start button that did
   * nothing, forever. So we verify the manifest parses and its entry points
   * exist, and treat anything else as not-installed (and reinstallable).
   */
  private isUsableInstall(npmPackage: string): boolean {
    const pkgDir = join(INTEGRATIONS_DIR, 'node_modules', ...npmPackage.split('/'));
    const pkgJson = join(pkgDir, 'package.json');
    if (!existsSync(pkgDir) || !existsSync(pkgJson)) return false;

    try {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as {
        name?: string;
        bin?: string | Record<string, string>;
        main?: string;
      };

      // A string bin is named after the package's last path segment.
      const defaultBinName = (pkg.name ?? npmPackage).split('/').pop() ?? '';
      const binMap: Record<string, string> = typeof pkg.bin === 'string'
        ? { [defaultBinName]: pkg.bin }
        : (pkg.bin ?? {});
      const binEntries = Object.entries(binMap);

      for (const [binName, target] of binEntries) {
        // 1. The package's own bin target must exist...
        if (!existsSync(join(pkgDir, target))) return false;
        // 2. ...AND so must the .bin shim npm links from it. The shim is what
        //    the integration is actually spawned through (config.command is
        //    resolved via PATH, which includes node_modules/.bin), so a missing
        //    shim — the archetypal half-finished install — means the spawn
        //    fails with ENOENT no matter how intact the package dir looks.
        if (!this.binShimExists(binName)) return false;
      }
      if (binEntries.length === 0 && pkg.main && !existsSync(join(pkgDir, pkg.main))) return false;
      return true;
    } catch {
      // Unparseable package.json — a truncated write. Reinstall.
      return false;
    }
  }

  /**
   * Does the node_modules/.bin shim for `binName` exist? On Windows npm writes
   * `<name>`, `<name>.cmd`, and `<name>.ps1`; the .cmd variant is what actually
   * runs, so any of them present counts.
   */
  private binShimExists(binName: string): boolean {
    if (!binName) return false;
    const candidates = process.platform === 'win32'
      ? [binName, `${binName}.cmd`, `${binName}.CMD`, `${binName}.ps1`]
      : [binName];
    return candidates.some(c => existsSync(join(INTEGRATIONS_BIN, c)));
  }

  /**
   * Install an npm package into the managed integrations directory if not
   * already present. Called automatically before spawning when
   * config.npmPackage is set.
   *
   * Asynchronous ON PURPOSE. This used to be execSync, which blocked the MCP
   * server's event loop for the entire install — the port stayed bound but
   * nothing was answered, so the control plane's /internal/manifests call
   * failed and the UI showed "Couldn't load integrations". Measured on clean
   * CI runners: ~3.6s (Linux), ~5.4s (macOS), ~14s (Windows), and far worse
   * on machines with real-time antivirus.
   */
  private async ensureInstalled(npmPackage: string): Promise<void> {
    ensureIntegrationsDir();

    if (this.isUsableInstall(npmPackage)) return;

    // A previous attempt may have left a partial directory behind. Remove it
    // so npm starts clean, otherwise the reinstall can fail on half-written
    // files that are still locked.
    const pkgDir = join(INTEGRATIONS_DIR, 'node_modules', ...npmPackage.split('/'));
    if (existsSync(pkgDir)) {
      console.error(`[IntegrationManager] Removing unusable install of ${npmPackage}`);
      try {
        rmSync(pkgDir, { recursive: true, force: true });
      } catch (err) {
        console.error(`[IntegrationManager] Could not clean ${pkgDir}:`, err);
      }
    }

    // npm is a batch script (npm.cmd) on Windows. Since the Node fix for
    // CVE-2024-27980, execFile refuses to spawn a .cmd without a shell and
    // throws EINVAL — which is exactly how the first async attempt failed on
    // windows-latest. So we run npm THROUGH a shell on Windows. That means the
    // package name reaches a command line, so validate it against the npm
    // package-name grammar first and refuse anything with shell metacharacters.
    if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(npmPackage)) {
      throw new Error(`Refusing to install unsafe package name: ${JSON.stringify(npmPackage)}`);
    }

    console.error(`[IntegrationManager] Installing ${npmPackage}...`);
    const startedAt = Date.now();
    const isWin = process.platform === 'win32';

    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        'npm',
        ['install', '--no-fund', '--no-audit', npmPackage],
        {
          cwd: INTEGRATIONS_DIR,
          // Windows: a shell so cmd.exe finds npm.cmd (see EINVAL note above).
          // POSIX: no shell — npm is a normal executable and keeping shell off
          // means the validated package name is still passed as a bare argv.
          shell: isWin,
          // No timeout: a slow install on a machine with antivirus is not an
          // error, and killing it midway is what created broken installs in
          // the first place. Progress is visible in the log.
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        },
        (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(`Failed to install ${npmPackage}: ${err.message}${stderr ? ` — ${stderr.trim()}` : ''}`));
            return;
          }
          resolve();
        },
      );
      child.on('error', err => reject(new Error(`Failed to run npm for ${npmPackage}: ${err.message}`)));
    });

    if (!this.isUsableInstall(npmPackage)) {
      throw new Error(
        `Installed ${npmPackage} but it is not usable — package.json or its bin target is missing. ` +
        `Check ${INTEGRATIONS_DIR} for a partial install.`,
      );
    }
    console.error(`[IntegrationManager] Installed ${npmPackage} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
  }

  /**
   * Connect a client to its transport, but never wait indefinitely. Resolves
   * on a successful handshake; rejects if the transport errors (child crash /
   * spawn failure) or the handshake exceeds CONNECT_TIMEOUT_MS. On failure the
   * transport is closed so the child process can't linger.
   */
  private async connectWithGuard(
    client: Client,
    transport: StdioClientTransport,
    config: IntegrationConfig,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const guard = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (settled) return;
        reject(new Error(
          `Timed out after ${CONNECT_TIMEOUT_MS}ms connecting to ${config.id} ` +
          `(${config.command} ${config.args.join(' ')}) — the downstream server ` +
          `did not complete the MCP handshake. It may have crashed on startup.`,
        ));
      }, CONNECT_TIMEOUT_MS);

      // If the child dies mid-handshake, the transport emits an error instead
      // of the connect promise ever resolving. Surface it as a rejection.
      transport.onerror = err => {
        if (settled) return;
        reject(new Error(`Transport error while connecting to ${config.id}: ${err.message}`));
      };
    });

    try {
      await Promise.race([client.connect(transport), guard]);
    } catch (err) {
      // Ensure the child is torn down on a failed/timed-out connect.
      try { await transport.close(); } catch { /* already gone */ }
      throw err;
    } finally {
      settled = true;
      if (timer) clearTimeout(timer);
      // Hand the crash watcher back over now that startup is done.
      transport.onerror = undefined;
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
      await this.ensureInstalled(config.npmPackage);
    }

    // Resolve environment variables from vault references
    const env = this.resolveEnvKeys(config);

    // Interpolate ${VAR} references in args from the resolved env. This lets a
    // manifest bake a credential into an argument (e.g. mcp-remote's
    // "Authorization: Bearer ${MOLLIE_ACCESS_TOKEN}" header) WITHOUT a shell —
    // the old approach spawned `sh -c "... $VAR"`, which doesn't exist on
    // Windows and left Mollie unstartable there. We spawn the binary directly
    // and do the substitution ourselves so it works on every platform.
    const interpolate = (s: string): string =>
      s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => env[name] ?? process.env[name] ?? '');
    const args = config.args.map(interpolate);

    // Create stdio transport (spawns child process)
    // PATH includes ~/.suveren/integrations/node_modules/.bin for on-demand installed packages.
    // HAP_DATA_DIR is the contract sub-MCPs (crm, records, linkedin) read — they are
    // HAP-tier reference integrations and don't know about the Suveren brand. We translate
    // our internal SUVEREN_DATA_DIR to HAP_DATA_DIR here so all sub-MCPs write their
    // SQLite DBs to the same directory the gateway uses — critical in docker where
    // HOME=/root but the mounted volume is /app/data.
    const transport = new StdioClientTransport({
      command: config.command,
      args,
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

    // A downstream that dies DURING the handshake (e.g. the Windows EPIPE
    // crash in @modelcontextprotocol/sdk's stdio server transport) can leave
    // client.connect() awaiting forever. Because the boot loop starts
    // integrations sequentially, one wedged connect blocks every integration
    // after it — the user sees the first stuck on "Starting" and the rest
    // permanently "Not running". Reject on transport error or timeout so the
    // loop can move on and report a real failure.
    await this.connectWithGuard(client, transport, config);
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
        // A downstream schema otherwise reaches the agent verbatim, so a
        // connector can offer a control-bypassing argument and we would pass it
        // straight on. Anything the manifest blocks is removed here, before the
        // agent ever sees it exists.
        inputSchema: withoutBlockedArgs(
          (tool.inputSchema ?? {}) as Record<string, unknown>,
          gating?.blockedArgs,
        ),
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
   * The LOCAL read-age window (days) for a running integration, or null when
   * none is set here (the read path then falls back to the signed grant bound
   * — see `IntegrationConfig.readAgeDays`).
   *
   * 0 is a real value ("read nothing") and MUST survive this call, so the
   * guard tests the type, never truthiness.
   */
  getReadAgeDays(integrationId: string): number | null {
    const config = this.running.get(integrationId)?.config;
    return config ? readAgeOf(config) : null;
  }

  /**
   * Apply a new local read-age window to the RUNNING snapshot, so the change
   * takes effect on the next read without restarting the subprocess. Read
   * policy is enforced gateway-side and never reaches the downstream MCP
   * server, so nothing has to be re-spawned.
   *
   * Persistence is the registry's job — callers update both. Returns false if
   * the integration is not running (registry-only update still applies).
   */
  setReadAgeDays(integrationId: string, days: number | null): boolean {
    const entry = this.running.get(integrationId);
    if (!entry) return false;
    if (days === null) delete entry.config.readAgeDays;
    else entry.config.readAgeDays = days;
    return true;
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
        readAgeDays: readAgeOf(entry.config),
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
            readAgeDays: readAgeOf(config),
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
      // Manifest entries may carry read-gate descriptors (boundField/
      // requiredValue) and a 'disabled' category that the base
      // ProfileToolGatingEntry type doesn't declare — read them from a
      // widened view (the base `override` keeps its type for the write return).
      const ext = (override ?? {}) as {
        category?: string;
        boundField?: string;
        requiredValue?: string;
        read?: import('./integration-registry').ReadAdapter;
        readGovernance?: 'none';
        readGovernanceReason?: string;
        contentField?: string;
        blockedArgs?: string[];
        argEncoding?: Record<string, string>;
        argNormalization?: Record<string, string>;
      };
      // 'disabled' = declared unavailable → block at the gating layer.
      if (ext.category === 'disabled') {
        return { profile: profileId, executionMapping: {}, category: 'disabled' };
      }
      // null override or { category: "read" } = read-only tool (still requires
      // authorization, plus any declared static read gate + per-item read adapter).
      if (override === null || ext.category === 'read') {
        return {
          profile: profileId,
          executionMapping: {},
          category: 'read',
          boundField: ext.boundField,
          requiredValue: ext.requiredValue,
          read: ext.read,
          readGovernance: ext.readGovernance,
          readGovernanceReason: ext.readGovernanceReason,
          blockedArgs: ext.blockedArgs,
        };
      }
      return {
        profile: profileId,
        executionMapping: override.executionMapping,
        staticExecution: override.staticExecution,
        // Which argument the receipt binds to. This resolver is an explicit
        // whitelist, so a field added to the manifest and the type but not
        // copied here is silently dropped — the receipt is still issued and
        // simply carries no binding, which only surfaces when a verifier asks.
        contentField: ext.contentField,
        blockedArgs: ext.blockedArgs,
        argEncoding: ext.argEncoding,
        argNormalization: ext.argNormalization,
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
