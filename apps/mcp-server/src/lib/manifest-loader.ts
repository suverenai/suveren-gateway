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
import type { ProfileToolGating } from '@hap/core';

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
  version: string;
  description: string;
  icon: string;
  profile: string;
  mcp: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  credentials: {
    fields: ManifestCredentialField[];
    envMapping: Record<string, string>;
  };
  oauth: ManifestOAuthConfig | null;
  npmPackage?: string;
  personalDefault?: boolean;
  toolGating: ProfileToolGating;
  setupHint?: string;
  /** Optional per-context-field discovery config (wizard-only). */
  contextDiscovery?: Record<string, ManifestContextDiscovery>;
}

interface ManifestIndex {
  integrations: Record<string, string>;
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
