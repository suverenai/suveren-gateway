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
import { getManifest, isExactSemver } from './manifest-loader';
import { remotePreflightTarget, preflightRemoteAuth } from './remote-auth-preflight';
import { isSimulationMode, manifestIsSimulated, SIMULATION_BLOCK_REASON } from './simulation-mode';
import type { BuiltinIntegration } from './builtin-integration';

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

/**
 * Offline mode — the Windows installer (and any other fully offline
 * installation) ships INTEGRATIONS_DIR pre-populated with every manifest's
 * pinned connector, installed with the SAME Node binary that will run them
 * (so native modules like better-sqlite3 get the matching prebuilt binary).
 * On a company laptop the public npm registry is typically unreachable, so
 * `npm install` must never even be attempted there — not "try npm, fall back
 * to the shipped copy", because a slow/odd failure from a half-blocked
 * registry (hangs, a captive portal page, a corporate proxy's HTML error
 * page) is worse than refusing instantly. With this on, `ensureInstalled`
 * either confirms the shipped connector is at the exact pinned version, or
 * refuses to start it with a clear reason — it never shells out to npm.
 */
const OFFLINE_MODE = process.env.SUVEREN_OFFLINE === '1';

/**
 * Serializes npm installs across ALL integrations.
 *
 * Every integration installs into the SAME prefix (`INTEGRATIONS_DIR`), and
 * `npm install` is not safe to run twice in one prefix: it rewrites the
 * dependency tree and the `node_modules/.bin` shims for the whole directory.
 * Two installs racing there means one can prune or relink the other's files
 * while that other package is being spawned.
 *
 * The per-id operation queue does not help — it serializes operations for one
 * integration, and this is a collision between DIFFERENT integrations.
 *
 * Observed as two faces of the same bug in CI: `Cannot find module
 * '…/node_modules/.bin/crm-mcp'` (the shim vanished mid-flight), and a
 * connector that connected, was restarted, and never came back
 * (`Connection closed`) while a second integration was installing. It hides
 * on a developer machine because the packages are usually already installed
 * and the fast path never reaches an install at all — the race needs a cold
 * directory, which is the state a real user's FIRST run is in, with boot
 * auto-restore starting several integrations at once.
 *
 * Module-scoped rather than instance-scoped because the directory is
 * process-wide: two managers in one process would still collide.
 */
let installLock: Promise<unknown> = Promise.resolve();

export function withInstallLock<T>(task: () => Promise<T>): Promise<T> {
  const run = installLock.then(task, task);
  // Settled-safe tail, so one failed install never wedges every later one.
  installLock = run.then(() => undefined, () => undefined);
  return run;
}
const INTEGRATIONS_BIN = join(INTEGRATIONS_DIR, 'node_modules', '.bin');

/**
 * The same `node_modules/.bin` directory this module puts on PATH before
 * spawning a connector as an MCP server — exported so another caller that
 * needs to run a connector's own CLI (report/connector-export.ts's `<bin>
 * export`) resolves the SAME installed binary, without duplicating
 * `INTEGRATIONS_DIR`'s resolution logic (env override, docker note, etc.) a
 * second time.
 */
export function getIntegrationsBinDir(): string {
  return INTEGRATIONS_BIN;
}

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
  /**
   * A REAL problem — the subprocess crashed, failed to spawn, etc. Never set
   * for the simulation block (see `paused` below): paused-by-design is not an
   * error, and collapsing the two made every blocked connector read as broken
   * in the UI (Dashboard "Needs your attention", red "Crashed" chip, a Start
   * button that could never succeed).
   */
  error?: string;
  /**
   * Set instead of `error` when this connector is not running SOLELY because
   * simulation mode is on and its manifest carries no `simulation` marker —
   * the exact condition `startIntegrationLocked` refuses under. Structured
   * rather than text so the UI never has to parse `error` to tell "paused by
   * design" from "actually broken". The only value today is 'simulation';
   * typed as a union (not boolean) so a second cause, if one is ever added,
   * doesn't need a breaking shape change.
   */
  paused?: 'simulation';
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

/** Options for {@link IntegrationManager.startIntegration}. */
export interface StartIntegrationOptions {
  /**
   * When the queued start actually executes and the integration is ALREADY
   * running, keep the running instance (return its tools) instead of
   * restarting it. For opportunistic callers — boot restore, credential
   * arrival, crash respawn — whose config may be staler than whatever start
   * won the queue. An explicit start (add-integration, manual Start) omits
   * this and always wins by restarting.
   */
  skipIfRunning?: boolean;
}

export class IntegrationManager {
  private running = new Map<string, RunningIntegration>();
  /** In-process tool groups (see builtin-integration.ts) — kept apart from `running` on purpose. */
  private builtins = new Map<string, { def: BuiltinIntegration; tools: DiscoveredTool[] }>();
  private onToolsChanged: (() => void) | null = null;
  /**
   * Called when a persisted config was migrated to the manifest's command/args
   * (see `migrateNpxConfig`) so the caller can write the fix back to
   * `integrations.json` — the manager itself has no registry/persistence
   * handle, by design (mirrors `onToolsChanged`). Without a subscriber the
   * migration still takes effect for THIS start (the in-memory config is
   * still corrected before spawn); only the one-time persistence is skipped,
   * so every later start keeps re-migrating in memory, which is safe, if
   * redundant.
   */
  private onConfigMigrated: ((id: string, updates: Partial<IntegrationConfig>) => void) | null = null;
  /**
   * Per-integration operation queue. Start/stop for one id are serialized
   * through here; without it, a second start issued while the first is still
   * installing/handshaking sees `running.has(id) === false`, skips the stop,
   * and both children come up — last `running.set` wins, the loser's process
   * leaks, and the surviving GATING is whichever start happened to finish
   * last. That last-writer-wins gating is a fail-open: a permissive manifest
   * config can silently replace a stricter explicit one (observed as the
   * read-gate value-mismatch flake).
   */
  private opQueues = new Map<string, Promise<unknown>>();

  constructor(private serviceCredentials: Map<string, Record<string, string>>) {}

  /** Run `task` after every previously queued operation for `id` has settled. */
  private runExclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const prev = this.opQueues.get(id) ?? Promise.resolve();
    const run = prev.then(task, task);
    // Store a settled-safe tail so one failed operation never wedges the queue.
    this.opQueues.set(id, run.then(() => undefined, () => undefined));
    return run;
  }

  /**
   * Register a callback invoked when the tool set changes
   * (integration started, stopped, or crashed).
   */
  setOnToolsChanged(cb: () => void): void {
    this.onToolsChanged = cb;
  }

  /**
   * Register a callback invoked when a persisted config is migrated off a
   * stale `npx` command to the current manifest's command/args (see
   * `migrateNpxConfig`). The caller is expected to persist `updates` against
   * `id` in `integrations.json` so the fix survives the next boot instead of
   * silently reapplying on every start.
   */
  setOnConfigMigrated(cb: (id: string, updates: Partial<IntegrationConfig>) => void): void {
    this.onConfigMigrated = cb;
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
   * The installed version of `npmPackage`, or null if it isn't usably
   * installed at all (see `isUsableInstall`) or its package.json has no
   * parseable `version`. Never throws — an unreadable version is treated the
   * same as "not installed", which is the safe direction: it drives a
   * (re)install rather than a false "already pinned".
   */
  private readInstalledVersion(npmPackage: string): string | null {
    if (!this.isUsableInstall(npmPackage)) return null;
    const pkgJson = join(INTEGRATIONS_DIR, 'node_modules', ...npmPackage.split('/'), 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as { version?: string };
      return typeof pkg.version === 'string' ? pkg.version : null;
    } catch {
      return null;
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
   * The exact version THIS gateway's CURRENTLY LOADED manifest pins
   * `config.npmPackage` to — or undefined when there's no npmPackage, no
   * manifest for this id, or the manifest's `npmPackage` no longer names the
   * same package as `config` (a manually re-pointed integration: nothing in
   * the manifest vouches for a version of config's actual package).
   *
   * Read fresh from `getManifest(config.id)` on every call, never from
   * anything persisted on `config` itself — manifests are reloaded fresh on
   * every boot, `integrations.json` is not, so this is what keeps the pin
   * from going stale the day after an integration was first activated. Used
   * both to decide the npm install/update (`ensureInstalled`) and to decide
   * whether a persisted `npx …` command must be refused/migrated
   * (`migrateNpxConfig`) — one definition of "pinned", so the two can't
   * disagree about which connectors it applies to.
   */
  private pinnedVersionFor(config: IntegrationConfig): string | undefined {
    if (!config.npmPackage) return undefined;
    const manifest = getManifest(config.id);
    return manifest?.npmPackage === config.npmPackage ? manifest.npmVersion : undefined;
  }

  /**
   * Install an npm package into the managed integrations directory if not
   * already present, and — when `config`'s manifest pins an exact
   * `npmVersion` for this same package — bring the installed copy to EXACTLY
   * that version, older or newer. Called automatically before spawning when
   * config.npmPackage is set.
   *
   * Asynchronous ON PURPOSE. This used to be execSync, which blocked the MCP
   * server's event loop for the entire install — the port stayed bound but
   * nothing was answered, so the control plane's /internal/manifests call
   * failed and the UI showed "Couldn't load integrations". Measured on clean
   * CI runners: ~3.6s (Linux), ~5.4s (macOS), ~14s (Windows), and far worse
   * on machines with real-time antivirus.
   */
  private async ensureInstalled(config: IntegrationConfig): Promise<void> {
    const npmPackage = config.npmPackage;
    if (!npmPackage) return;
    ensureIntegrationsDir();

    const pinnedVersion = this.pinnedVersionFor(config);

    if (OFFLINE_MODE) {
      // Never run npm — only verify what is already on disk. See OFFLINE_MODE
      // doc comment for why this refuses instead of attempting a fallback.
      const current = this.readInstalledVersion(npmPackage);
      if (pinnedVersion) {
        if (current === pinnedVersion) return;
        throw new Error(
          `${config.id}: connector ${npmPackage} version ${pinnedVersion} is not part of this installation ` +
          `(found ${current ?? 'nothing installed'} at ${INTEGRATIONS_DIR}; SUVEREN_OFFLINE=1 so no npm install was attempted).`,
        );
      }
      if (current !== null) return;
      throw new Error(
        `${config.id}: connector ${npmPackage} is not part of this installation ` +
        `(nothing installed at ${INTEGRATIONS_DIR}; SUVEREN_OFFLINE=1 so no npm install was attempted).`,
      );
    }

    if (pinnedVersion) {
      // Fast path: already at the pinned version. Deliberately outside the
      // lock — the common case (every subsequent start once pinned) must not
      // queue behind an unrelated install.
      if (this.readInstalledVersion(npmPackage) === pinnedVersion) return;

      return withInstallLock(async () => {
        // Re-check inside the lock: a concurrent call for the SAME package may
        // have already brought it to the pin while this one waited.
        const current = this.readInstalledVersion(npmPackage);
        if (current === pinnedVersion) return;
        console.error(
          `[IntegrationManager] ${npmPackage} ${current ?? '(not installed)'} → ${pinnedVersion} (pinned by manifest)`,
        );
        // Only force-clean first when the on-disk copy is itself broken or
        // absent. A USABLE install that's merely the wrong version is left in
        // place for npm to update over — exactly how `npm install pkg@x.y.z`
        // normally works — so that if the install fails (offline, registry
        // hiccup), the previously-working version is still there on disk
        // afterward. It still won't be STARTED (the version check above would
        // still see it as the wrong version), which is the fail-closed half of
        // this: wrong-version-but-intact beats neither-version-at-all.
        const cleanFirst = !this.isUsableInstall(npmPackage);
        await this.installNow(npmPackage, pinnedVersion, cleanFirst);
      });
    }

    // No pin (manually added integration, or a repointed package the
    // manifest no longer names) — unchanged legacy behaviour: install once,
    // then never touch it again on version grounds.
    if (this.isUsableInstall(npmPackage)) return;

    return withInstallLock(async () => {
      if (this.isUsableInstall(npmPackage)) return;
      await this.installNow(npmPackage);
    });
  }

  /**
   * The actual install. Callers MUST hold the install lock.
   *
   * `exactVersion`, when given, is a pin already validated as an exact semver
   * by the manifest loader (`isExactSemver`) — re-validated here anyway
   * because this method does not trust its caller's caller, and because the
   * version reaches a shell on Windows (see the package-name check below).
   *
   * `cleanFirst` (default true, i.e. today's behaviour for every caller
   * except a version-only pin correction): wipe any existing package
   * directory before installing. Needed for a genuinely broken/partial
   * install, where stale files can make the reinstall itself fail; skipped
   * for a USABLE install being corrected to a different pinned version, so a
   * failed update leaves the previously-working version on disk instead of
   * nothing at all.
   */
  private async installNow(npmPackage: string, exactVersion?: string, cleanFirst = true): Promise<void> {
    const pkgDir = join(INTEGRATIONS_DIR, 'node_modules', ...npmPackage.split('/'));
    if (cleanFirst && existsSync(pkgDir)) {
      console.error(`[IntegrationManager] Removing ${exactVersion ? 'outdated' : 'unusable'} install of ${npmPackage}`);
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
    if (exactVersion !== undefined && !isExactSemver(exactVersion)) {
      throw new Error(`Refusing to install ${npmPackage} at unsafe/non-exact version spec: ${JSON.stringify(exactVersion)}`);
    }

    const spec = exactVersion ? `${npmPackage}@${exactVersion}` : npmPackage;
    console.error(`[IntegrationManager] Installing ${spec}...`);
    const startedAt = Date.now();
    const isWin = process.platform === 'win32';

    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        'npm',
        ['install', '--no-fund', '--no-audit', spec],
        {
          cwd: INTEGRATIONS_DIR,
          // Windows: a shell so cmd.exe finds npm.cmd (see EINVAL note above).
          // POSIX: no shell — npm is a normal executable and keeping shell off
          // means the validated package spec is still passed as a bare argv.
          shell: isWin,
          // No timeout: a slow install on a machine with antivirus is not an
          // error, and killing it midway is what created broken installs in
          // the first place. Progress is visible in the log.
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        },
        (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(`Failed to install ${spec}: ${err.message}${stderr ? ` — ${stderr.trim()}` : ''}`));
            return;
          }
          resolve();
        },
      );
      child.on('error', err => reject(new Error(`Failed to run npm for ${spec}: ${err.message}`)));
    });

    if (!this.isUsableInstall(npmPackage)) {
      throw new Error(
        `Installed ${spec} but it is not usable — package.json or its bin target is missing. ` +
        `Check ${INTEGRATIONS_DIR} for a partial install.`,
      );
    }
    if (exactVersion !== undefined) {
      const installed = this.readInstalledVersion(npmPackage);
      if (installed !== exactVersion) {
        // `npm install pkg@1.2.3` should only ever land exactly 1.2.3. If it
        // didn't, something is wrong enough (registry inconsistency, a stale
        // cache, a non-exact resolution we failed to catch) that running
        // whatever DID land — a version the manifest never vouched for — is
        // the wrong failure mode. Refuse instead of silently proceeding.
        throw new Error(
          `Installed ${npmPackage} but got version ${installed ?? 'unknown'}, expected the pinned ${exactVersion}.`,
        );
      }
    }
    console.error(`[IntegrationManager] Installed ${spec} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
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
   *
   * Serialized per id: a start issued while another start/stop for the same
   * id is in flight waits for it, then applies its own semantics (restart, or
   * keep-if-running with `skipIfRunning`). See `opQueues`.
   */
  async startIntegration(
    config: IntegrationConfig,
    opts: StartIntegrationOptions = {},
  ): Promise<DiscoveredTool[]> {
    return this.runExclusive(config.id, () => this.startIntegrationLocked(config, opts));
  }

  private async startIntegrationLocked(
    config: IntegrationConfig,
    opts: StartIntegrationOptions,
  ): Promise<DiscoveredTool[]> {
    const existing = this.running.get(config.id);
    if (existing) {
      if (opts.skipIfRunning) return existing.tools;
      // Stop directly (not via the public queued method — that would deadlock
      // behind this very operation).
      await this.stopIntegrationLocked(config.id);
    }

    // Simulation mode: an integration whose manifest carries no `simulation`
    // marker is not started at all — including one registered directly via
    // /internal/add-integration with no manifest (getManifest returns
    // undefined, which manifestIsSimulated treats as "not simulated"). This
    // is the primary enforcement point; tool-proxy.ts refuses calls too
    // (defence in depth), in case some future path ever starts an
    // integration without going through here.
    if (isSimulationMode() && !manifestIsSimulated(getManifest(config.id))) {
      throw new Error(`${config.id}: ${SIMULATION_BLOCK_REASON}`);
    }

    // Install (or update to the manifest-pinned version) npm package on-demand
    // if specified. Throws — and the integration does not start — if the
    // manifest pins a version and bringing the install to it fails: running
    // whatever version happens to be on disk instead would be exactly the
    // "run a version nobody here vouches for" failure this feature exists to
    // prevent.
    if (config.npmPackage) {
      await this.ensureInstalled(config);
    }

    // A pinned connector's spawn command must come from the CURRENT manifest,
    // never a persisted copy that may predate the pin. This was the actual
    // bug behind the first version of this feature: deploy-github's manifest
    // moved from `npx -y @humanagencyp/deploy-mcp@latest` to the installed
    // `deploy-mcp` bin + an exact `npmVersion` pin, but EXISTING installs kept
    // their old registry entry forever — ensureInstalled correctly updated
    // the on-disk package to the pin, and then the spawn below ran the old
    // persisted `npx …@latest` anyway, fetching unvetted "latest" on every
    // single start regardless of what had just been installed.
    //
    // Only migrate when the persisted command is EXACTLY `npx`: that is the
    // one shape the old `npx -y pkg@latest` pattern used, and it is safe to
    // replace wholesale with the manifest's own command/args. Anything else
    // (e.g. mollie's `mcp-remote` with manifest-declared args containing a
    // `${MOLLIE_ACCESS_TOKEN}` template, interpolated from vault credentials
    // at spawn time) is already the manifest's own shape — not a leftover
    // `npx` invocation — and must be left alone.
    const pinnedVersion = this.pinnedVersionFor(config);
    if (pinnedVersion && config.command === 'npx') {
      const manifest = getManifest(config.id)!; // pinnedVersionFor already confirmed this exists and matches npmPackage
      const migrated: Pick<IntegrationConfig, 'command' | 'args' | 'env'> = {
        command: manifest.mcp.command,
        args: manifest.mcp.args,
        env: manifest.mcp.env ?? config.env,
      };
      console.error(
        `[IntegrationManager] ${config.id}: command migrated to manifest (was npx ${config.args.join(' ')})`,
      );
      config = { ...config, ...migrated };
      // Let the caller (http.ts owns the registry; this class deliberately
      // does not — see `onConfigMigrated`'s doc comment) persist the fix so
      // integrations.json stops disagreeing with the manifest from here on.
      this.onConfigMigrated?.(config.id, migrated);
    }

    // Defense in depth, independent of the migration above: whatever the
    // config says at this point, a PINNED connector must never actually be
    // spawned via npx — that would silently ignore the installed, pinned
    // version and fetch the package fresh (possibly "latest") on every start,
    // which is exactly the failure this whole feature exists to prevent. The
    // only way to reach this with `pinnedVersion` set is a manifest that
    // itself still declares `npx` as its `mcp.command` — shipped manifests
    // can't (manifest-npm-pin.test.ts lints it), but nothing stops a
    // third-party one from trying.
    if (pinnedVersion && config.command === 'npx') {
      throw new Error(
        `${config.id}: refusing to spawn a pinned connector ("${config.npmPackage}"@${pinnedVersion}) via npx — ` +
        `this would ignore the pinned local install and fetch the package fresh on every start. ` +
        `The manifest's mcp.command must name the installed binary, not "npx".`,
      );
    }

    // Resolve environment variables from vault references
    const env = this.resolveEnvKeys(config);

    // Simulation mode, for a connector that DOES declare a simulated mode
    // (guaranteed by the guard above — only simulated connectors reach this
    // line while simulation mode is on): force its mode env var to
    // "simulation", overriding whatever the stored credential says. A user
    // who set mode=live before simulation mode was turned on must not have
    // that live setting silently take effect while the gateway believes real
    // systems are off.
    if (isSimulationMode()) {
      const manifest = getManifest(config.id);
      const simDecl = manifest?.simulation;
      if (simDecl) {
        const envVar = Object.entries(manifest!.credentials.envMapping)
          .find(([, credKey]) => credKey === simDecl.field)?.[0];
        if (envVar) env[envVar] = 'simulation';
      }
    }

    // Interpolate ${VAR} references in args from the resolved env. This lets a
    // manifest bake a credential into an argument (e.g. mcp-remote's
    // "Authorization: Bearer ${MOLLIE_ACCESS_TOKEN}" header) WITHOUT a shell —
    // the old approach spawned `sh -c "... $VAR"`, which doesn't exist on
    // Windows and left Mollie unstartable there. We spawn the binary directly
    // and do the substitution ourselves so it works on every platform.
    const interpolate = (s: string): string =>
      s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => env[name] ?? process.env[name] ?? '');
    const args = config.args.map(interpolate);

    // A remote connector whose credential the remote rejects must not be
    // spawned: mcp-remote answers a 401 by opening the system browser on the
    // remote's login page (see remote-auth-preflight.ts). Fail here, named.
    const remote = remotePreflightTarget(config.command, args);
    if (remote) {
      const verdict = await preflightRemoteAuth(remote);
      if (!verdict.ok) throw new Error(`${config.id}: ${verdict.reason}`);
    }

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
      // `...process.env` is also how a saved `--ca-file` reaches an
      // integration: NODE_EXTRA_CA_CERTS (read by Node only at process
      // start) is already set on THIS process by bundle/server.js before
      // the MCP server ever starts, so every integration this manager spawns
      // inherits it here for free — no separate handling needed.
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

    // Watch for crashes. Guard on transport identity: only the CURRENT
    // entry's transport may trigger crash handling — a replaced or stopped
    // child closing later must never tear down (or respawn over) its
    // successor.
    transport.onclose = () => {
      if (this.running.get(config.id)?.transport !== transport) return;
      console.error(`[IntegrationManager] Transport closed for ${config.id}`);
      this.handleCrash(config.id);
    };

    this.onToolsChanged?.();
    return tools;
  }

  /**
   * Stop a running integration, closing its transport and removing its tools.
   *
   * Serialized per id: a stop issued while a start is in flight waits and
   * then stops the just-started instance, instead of silently doing nothing
   * because the entry wasn't in `running` yet.
   */
  async stopIntegration(id: string): Promise<void> {
    return this.runExclusive(id, () => this.stopIntegrationLocked(id));
  }

  private async stopIntegrationLocked(id: string): Promise<void> {
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
   * Register an in-process tool group (see builtin-integration.ts). Its tools are
   * listed, gated and executed through the same path as a connector's; only the
   * final call runs `handler` instead of a child MCP client. Refused when the id
   * is unusable or already taken, so a built-in can never shadow a connector.
   */
  registerBuiltin(def: BuiltinIntegration): void {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(def.id) || def.id.includes('__')) {
      throw new Error(`Built-in integration id "${def.id}" must be lowercase letters, digits and '-'.`);
    }
    if (this.builtins.has(def.id) || this.running.has(def.id) || getManifest(def.id)) {
      throw new Error(`Built-in integration id "${def.id}" is already in use.`);
    }
    const names = new Set<string>();
    const tools: DiscoveredTool[] = def.tools.map(tool => {
      if (names.has(tool.name)) throw new Error(`Built-in "${def.id}": tool "${tool.name}" is declared twice.`);
      names.add(tool.name);
      const gating = this.resolveToolGating(def.profile, def.toolGating, tool.name);
      return {
        originalName: tool.name,
        namespacedName: `${def.id}__${tool.name}`,
        integrationId: def.id,
        description: tool.description,
        inputSchema: withoutBlockedArgs(tool.inputSchema, gating?.blockedArgs),
        gating,
      };
    });
    this.builtins.set(def.id, { def, tools });
    console.error(`[IntegrationManager] Built-in ${def.id}: ${tools.length} tool(s) under profile ${def.profile}`);
    this.onToolsChanged?.();
  }

  /** Whether `id` names a built-in (in-process) integration. */
  isBuiltin(id: string): boolean {
    return this.builtins.has(id);
  }

  /**
   * Whether `id` may run while simulation mode is on: a connector whose manifest
   * carries the `simulation` marker, or a built-in that declares `simulation: true`.
   */
  isSimulationSafe(id: string): boolean {
    const builtin = this.builtins.get(id);
    if (builtin) return builtin.def.simulation === true;
    return manifestIsSimulated(getManifest(id));
  }

  /**
   * Proxy a tool call to a downstream MCP server (or a built-in's handler).
   */
  async callTool(
    integrationId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const builtin = this.builtins.get(integrationId);
    if (builtin) {
      const tool = builtin.def.tools.find(t => t.name === toolName);
      if (!tool) {
        return { content: [{ type: 'text', text: `Tool "${integrationId}__${toolName}" does not exist.` }], isError: true };
      }
      try {
        const result = await tool.handler(args);
        return { content: result.content.map(c => ({ type: c.type, text: c.text })), isError: result.isError };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Tool call failed: ${message}` }], isError: true };
      }
    }
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
    for (const entry of this.builtins.values()) {
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
            // Computed fresh, not cached: true whenever simulation mode is on
            // AND this connector has no manifest `simulation` marker, which is
            // exactly the condition startIntegrationLocked refuses under — so
            // the UI always reflects why a real connector never started,
            // without needing a separate tracking path for this one reason.
            // This is `paused`, NOT `error`: it is not a problem, it's the
            // mode working as designed (see IntegrationStatus.paused). Genuine
            // start failures still surface via the one-shot `warning` string
            // returned by /internal/add-integration — they never land here.
            paused: isSimulationMode() && !manifestIsSimulated(getManifest(config.id))
              ? 'simulation'
              : undefined,
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
    // The registry entry is a snapshot of the manifest taken when the
    // integration was activated. A credential field added to the manifest
    // later (deploy-github gained HAP_DEPLOY_ARTIFACT_PATH on 2026-09-05) is
    // therefore absent from envKeys/optionalEnvKeys on every existing install,
    // and the value the user saves in the vault never reaches the process —
    // silently, with the UI reporting "saved". So the CURRENT manifest's
    // mapping is consulted too, best-effort, for any env var the snapshot does
    // not already name. Required-ness is still judged from the snapshot
    // (canResolveEnvKeys), so this can only add variables, never block a start.
    const manifest = getManifest(config.id);
    for (const [envVar, credKey] of Object.entries(manifest?.credentials?.envMapping ?? {})) {
      if (envVar in env) continue;
      if (envVar in config.envKeys || envVar in (config.optionalEnvKeys ?? {})) continue;
      const creds = this.serviceCredentials.get(config.id);
      if (creds && credKey in creds) {
        env[envVar] = creds[credKey];
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
        hideUnlessAuthorized?: boolean;
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
          hideUnlessAuthorized: ext.hideUnlessAuthorized,
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
        hideUnlessAuthorized: ext.hideUnlessAuthorized,
      };
    }

    // No manifest entry ⇒ REFUSED. protocol.md → Tool-Gating Manifests: "The
    // Gatekeeper MUST refuse any tool that is not described in a loaded
    // manifest. There is no 'permissive default' and no ungated read access."
    //
    // `toolGating.default` used to answer here, which made it exactly that
    // permissive default: any tool a downstream server happened to expose —
    // including one added by a remote server after this manifest was written —
    // was gated by a generic entry nobody wrote for it. Its executionMapping is
    // empty by construction, so the call's real parameters (amount, recipient,
    // resource) mapped into nothing and were checked against nothing.
    //
    // `default` is NOT an inheritance template either: the override branch
    // above reads each entry's own executionMapping/staticExecution and merges
    // nothing. So nothing consumes it as a gate any more.
    return {
      profile: profileId,
      executionMapping: {},
      category: 'disabled',
      disabledReason: 'not described in manifest',
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
        // skipIfRunning: if a newer explicit start brought the integration
        // back while we waited, the respawn must not restart it with this
        // (possibly stale) config snapshot.
        await this.startIntegration(entry.config, { skipIfRunning: true });
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
