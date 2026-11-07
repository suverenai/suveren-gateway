/**
 * A retired connector replaced by another one (MCP-server side; see
 * control-plane/src/lib/connector-replacement.ts for the vault side).
 *
 * Pure planning over the registry: what the registry looks like after the swap.
 * The decision follows what the person had:
 *   - old connector enabled   -> the replacement is registered and enabled, carrying
 *                                the old local read window (a setting the person chose)
 *   - old connector disabled  -> only the old entry goes; nothing is switched on unasked
 *   - old connector not there -> nothing
 *   - `enableTarget: false`   -> only the old entry goes (no credentials were moved)
 * The replacement already registered stays as it is (its own read window, its
 * own settings); it is only switched on.
 */
import type { IntegrationConfig } from './integration-registry';
import type { IntegrationManifest } from './manifest-loader';

/** A registry entry for a manifest, as the card's Activate writes it (control-plane/mcp-bridge.ts activateIntegration). */
export function configFromManifest(manifest: IntegrationManifest, over: { readAgeDays?: number } = {}): IntegrationConfig {
  const optionalKeys = new Set(manifest.credentials.fields.filter(f => f.optional).map(f => f.key));
  // A sign-in used by only one data-source option has no token under the others: it must not block a start there.
  if (manifest.oauth?.forOption) optionalKeys.add(manifest.oauth.tokenStorage);
  const envKeys: Record<string, string> = {};
  const optionalEnvKeys: Record<string, string> = {};
  for (const [envVar, credKey] of Object.entries(manifest.credentials.envMapping)) {
    (optionalKeys.has(credKey) ? optionalEnvKeys : envKeys)[envVar] = `${manifest.id}.${credKey}`;
  }
  const readAgeDays = over.readAgeDays ?? (manifest as { readPolicy?: { defaultAgeDays?: number } }).readPolicy?.defaultAgeDays;
  return {
    id: manifest.id,
    name: manifest.name,
    command: manifest.mcp.command,
    args: manifest.mcp.args,
    ...(manifest.mcp.env ? { env: manifest.mcp.env } : {}),
    envKeys,
    ...(Object.keys(optionalEnvKeys).length > 0 ? { optionalEnvKeys } : {}),
    profile: manifest.profile,
    toolGating: manifest.toolGating as IntegrationConfig['toolGating'],
    npmPackage: manifest.npmPackage,
    ...(typeof readAgeDays === 'number' ? { readAgeDays } : {}),
    enabled: true,
  };
}

export type TargetAction = 'added' | 'enabled' | 'none';

export interface ReplacementPlan {
  removeOld: boolean;
  targetAction: TargetAction;
  /** For 'added': the entry to register. */
  add?: IntegrationConfig;
}

export function planReplacement(
  registry: IntegrationConfig[],
  manifest: IntegrationManifest,
  fromId: string,
  enableTarget: boolean,
): ReplacementPlan {
  const old = registry.find(c => c.id === fromId);
  if (!old) return { removeOld: false, targetAction: 'none' };
  if (!old.enabled || !enableTarget) return { removeOld: true, targetAction: 'none' };
  const existing = registry.find(c => c.id === manifest.id);
  if (existing) return { removeOld: true, targetAction: existing.enabled ? 'none' : 'enabled' };
  return { removeOld: true, targetAction: 'added', add: configFromManifest(manifest, { readAgeDays: old.readAgeDays }) };
}
