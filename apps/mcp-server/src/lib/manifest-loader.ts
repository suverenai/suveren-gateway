/**
 * Manifest Loader — reads integration manifests from disk.
 *
 * Reads content/integrations/index.json, loads each manifest JSON.
 * Pattern follows profile-loader.ts.
 *
 * Configurable via SUVEREN_MANIFESTS_DIR env var (defaults to
 * ../../../../content/integrations relative to this file — the repo's
 * checked-in manifest directory). Kept intentionally separate from
 * SUVEREN_INTEGRATIONS_DIR, which is the runtime install target for
 * downstream MCP npm packages — pointing that at the manifest dir used
 * to leak package.json + node_modules/ into the repo.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ProfileToolGating, ToolPreviewConfig } from './tool-gating-types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ManifestCredentialField {
  key: string;
  label: string;
  type: 'text' | 'password';
  placeholder?: string;
  optional?: boolean;
}

export interface ManifestOAuthConfig {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  credentialKeys: Record<string, string>;
  tokenStorage: string;
  extraParams?: Record<string, string>;
}

/**
 * Declares how to discover valid values for a context-scope field by
 * querying the connected service. Consumed by the wizard-only endpoint
 * GET /integrations/:id/discover/:field on the control plane — not
 * agent-reachable. See doc/hap-scope-discovery-proposal.md.
 */
export interface ManifestContextDiscovery {
  baseUrl: string;
  endpoint: string;
  /** Currently only "bearer" is supported — token from the integration's vault credential. */
  auth: 'bearer';
  /** Vault credential field holding the bearer (or refresh token to exchange). Defaults to oauth.tokenStorage. */
  credential?: string;
  /** Dotted path to the array in the response (e.g. "items"). */
  responsePath: string;
  /** Key on each array element for the option value. */
  valueField: string;
  /** Key for the human-readable label. */
  labelField: string;
  /** Optional extras surfaced to the wizard UI for each option (e.g. access role, timezone). */
  extraFields?: Record<string, string>;
}

export interface IntegrationManifest {
  id: string;
  name: string;
  /**
   * Starter text for the intent of a mandate for this integration — what a
   * person would typically want the agent to know here. The gateway UI seeds the
   * intent with it; the person edits it and signs their own words. Protocol 0.7:
   * profiles MUST NOT define the intent prompt; manifests MAY give this hint.
   */
  intentHint?: string;
  version: string;
  description: string;
  icon: string;
  profile: string;
  mcp: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    /** Names of gateway environment variables this connector reads (e.g. a
     *  seed file the operator sets). Everything else is withheld — see
     *  connector-env.ts. */
    passEnv?: string[];
  };
  credentials: {
    fields: ManifestCredentialField[];
    envMapping: Record<string, string>;
  };
  oauth: ManifestOAuthConfig | null;
  /**
   * The connector CAN answer from a simulated system: `field` is the credential
   * field holding the mode, `default` the mode when it is unset. Two consumers:
   *   1. Display — the UI badges a simulated connector (per its current
   *      credential value) so a forgotten switch after go-live is never silent.
   *   2. Enforcement — gateway-wide simulation mode (SUVEREN_SIMULATION=1, see
   *      simulation-mode.ts) refuses to START any connector with NO entry here
   *      at all, and FORCES this field's env var to "simulation" for every
   *      connector that does, overriding its stored credential value.
   * Absent simulation mode, the gateway's checks and tickets are identical in
   * both modes — this field alone changes nothing.
   */
  simulation?: { field: string; default: string } | null;
  /** npm package to install on-demand for this connector (e.g. "@humanagencyp/crm-mcp"). */
  npmPackage?: string;
  /**
   * The EXACT version of `npmPackage` this manifest is tested against and
   * vouches for — e.g. "0.3.3". Required whenever `npmPackage` is set.
   *
   * A gateway release ships a tested SET of connector versions, the same way
   * it ships a tested set of bundled profiles: nobody auto-pulls "latest" and
   * gets a connector nobody here has run. `ensureInstalled` in
   * integration-manager.ts brings the installed package to this exact
   * version (older OR newer) before the connector starts, and refuses to
   * start it if that install fails — never silently keeping a version the
   * manifest does not vouch for.
   *
   * Must be an EXACT semver: no ranges ("^1.2.3", "~1.2.0"), no dist-tags
   * ("latest", "next"), no git/URL/file specs. `isExactSemver` (below)
   * is the single definition of "valid"; `loadManifests` refuses the whole
   * manifest, named, if this is missing or fails it.
   */
  npmVersion?: string;
  personalDefault?: boolean;
  toolGating: ProfileToolGating;
  setupHint?: string;
  /** Optional per-context-field discovery config (wizard-only). */
  contextDiscovery?: Record<string, ManifestContextDiscovery>;
}

interface ManifestIndex {
  integrations: Record<string, string>;
}

// ─── npmVersion pin validation ──────────────────────────────────────────────

/**
 * An exact semver only — no ranges, no build-metadata-as-range tricks, no
 * dist-tags, no git/URL/file specs. Anything `npm install <pkg>@<this>` could
 * resolve to something OTHER than one specific published version is rejected:
 * the whole point of the pin is that every gateway release installs the exact
 * bytes it was tested against.
 */
const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isExactSemver(value: unknown): value is string {
  return typeof value === 'string' && EXACT_SEMVER_RE.test(value);
}

/**
 * Returns a human-readable refusal reason if `manifest`'s npm pin is invalid,
 * or null if it's fine (including "no npmPackage at all" — nothing to pin).
 * Shared by the loader (refuses the manifest) and the lint test (fails CI) so
 * the two can never disagree about what counts as a valid pin.
 */
export function invalidNpmPinReason(
  manifest: Pick<IntegrationManifest, 'npmPackage' | 'npmVersion'>,
): string | null {
  if (!manifest.npmPackage) return null;
  if (manifest.npmVersion === undefined) {
    return `npmPackage "${manifest.npmPackage}" is set but npmVersion is missing — every connector manifest must pin an exact tested version`;
  }
  if (!isExactSemver(manifest.npmVersion)) {
    return `npmVersion ${JSON.stringify(manifest.npmVersion)} for "${manifest.npmPackage}" is not an exact semver (e.g. "1.2.3") — ranges, dist-tags like "latest", git specs, URLs, and file paths are not allowed`;
  }
  return null;
}

// ─── AU3 preview shape validation ──────────────────────────────────────────

/**
 * Returns a human-readable refusal reason if `entry.preview` (an override's
 * optional AU3 declaration — see tool-gating-types.ts) is malformed, or null
 * if it's absent or well-formed. Shape-only: whether `preview.tool` actually
 * exists on the integration is a RUNTIME question (the connector may not be
 * started yet when manifests load), checked at call time by the
 * `/internal/preview` route instead — see preview.ts's `readPreview`.
 */
export function invalidPreviewReason(toolName: string, entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object') return null; // read-tool shorthand, nothing to check
  const preview = (entry as { preview?: unknown }).preview;
  if (preview === undefined) return null;
  if (preview === null || typeof preview !== 'object' || Array.isArray(preview)) {
    return `override "${toolName}".preview must be an object`;
  }
  const p = preview as Record<string, unknown>;
  if (typeof p.tool !== 'string' || p.tool.length === 0) {
    return `override "${toolName}".preview.tool must be a non-empty string`;
  }
  if (p.args === undefined || p.args === null || typeof p.args !== 'object' || Array.isArray(p.args)) {
    return `override "${toolName}".preview.args must be an object mapping preview-tool arg names to action arg names`;
  }
  for (const [argName, source] of Object.entries(p.args as Record<string, unknown>)) {
    if (typeof source !== 'string' || source.length === 0) {
      return `override "${toolName}".preview.args.${argName} must name a non-empty source argument (string)`;
    }
  }
  if (p.version !== undefined) {
    if (p.version === null || typeof p.version !== 'object' || Array.isArray(p.version)) {
      return `override "${toolName}".preview.version must be an object`;
    }
    const v = p.version as Record<string, unknown>;
    if (typeof v.arg !== 'string' || v.arg.length === 0) {
      return `override "${toolName}".preview.version.arg must be a non-empty string`;
    }
    if (typeof v.field !== 'string' || v.field.length === 0) {
      return `override "${toolName}".preview.version.field must be a non-empty string`;
    }
  }
  return null;
}

/** Shared control type, exported so callers can narrow a validated entry. */
export type ValidatedPreviewConfig = ToolPreviewConfig;

/**
 * Checks every override's `preview` (if any) in one manifest. Returns the
 * first refusal reason found, or null if the whole manifest's overrides are
 * clean. Shares the single predicate above with any future lint test, same
 * reasoning as `invalidNpmPinReason`/`isExactSemver`.
 */
export function invalidManifestPreviewReason(manifest: Pick<IntegrationManifest, 'toolGating'>): string | null {
  const overrides = manifest.toolGating?.overrides ?? {};
  for (const [toolName, entry] of Object.entries(overrides)) {
    const reason = invalidPreviewReason(toolName, entry);
    if (reason) return reason;
  }
  return null;
}

// ─── Module state ───────────────────────────────────────────────────────────

const manifests = new Map<string, IntegrationManifest>();

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Load all integration manifests from disk.
 * Returns the number of manifests loaded.
 */
export function loadManifests(integrationsDir?: string): number {
  // Default: ../../../../content/integrations relative to this file (src/lib/ → apps/mcp-server → suveren-gateway/content/integrations)
  const dir = resolve(
    integrationsDir ??
    process.env.SUVEREN_MANIFESTS_DIR ??
    join(import.meta.dirname ?? __dirname, '..', '..', '..', '..', 'content', 'integrations'),
  );
  const indexPath = join(dir, 'index.json');

  if (!existsSync(indexPath)) {
    console.error(`[ManifestLoader] No index.json found at ${indexPath}, skipping manifest loading`);
    return 0;
  }

  let index: ManifestIndex;
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf-8'));
  } catch (err) {
    console.error(`[ManifestLoader] Failed to parse ${indexPath}:`, err);
    return 0;
  }

  let loaded = 0;
  for (const [id, relativePath] of Object.entries(index.integrations)) {
    const manifestPath = join(dir, relativePath);
    try {
      const manifest: IntegrationManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const pinReason = invalidNpmPinReason(manifest);
      if (pinReason) {
        console.error(`[ManifestLoader] Refusing manifest ${id} (${manifestPath}): ${pinReason}`);
        continue;
      }
      const previewReason = invalidManifestPreviewReason(manifest);
      if (previewReason) {
        console.error(`[ManifestLoader] Refusing manifest ${id} (${manifestPath}): ${previewReason}`);
        continue;
      }
      manifests.set(id, manifest);
      loaded++;
    } catch (err) {
      console.error(`[ManifestLoader] Failed to load manifest ${id} from ${manifestPath}:`, err);
    }
  }

  console.error(`[ManifestLoader] Loaded ${loaded} integration manifest(s) from ${dir}`);
  return loaded;
}

/**
 * Get a specific integration manifest by ID.
 */
export function getManifest(id: string): IntegrationManifest | undefined {
  return manifests.get(id);
}

/**
 * Get all loaded integration manifests.
 */
export function getAllManifests(): IntegrationManifest[] {
  return Array.from(manifests.values());
}
