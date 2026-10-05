/**
 * What the "Give a mandate" picker offers: one entry per installed connector, plus
 * one per built-in tool group of the gateway (its own tools, e.g. the test-setup
 * tools under the delegation profile). Built-ins have no manifest, so without this
 * nobody could give a mandate for them from the UI.
 *
 * Each entry carries the NEWEST version of its profile the Authority Server
 * serves — several versions can be served at once (kept for old grants); a new
 * mandate is always created under the newest.
 */
import type { ProfileSummary, IntegrationManifest, McpIntegrationStatus, BuiltinStatus } from './sp-client';

export interface PickerEntry {
  key: string;
  /** The name the person recognises — "Deploy (GitHub)", "Test setup". */
  name: string;
  description: string;
  profile: ProfileSummary;
  kind: 'connector' | 'builtin';
  /** Can a mandate be used right now (connector running / built-in available)? */
  ready: boolean;
  /** For a connector that is not running: the manifest id to set it up. */
  setupId?: string;
  /** For a built-in that is not available: why. */
  unavailableReason?: string;
}

const shortOf = (id: string): string => id.replace(/@.*$/, '').split('/').pop() ?? id;
const versionOf = (id: string): string => id.split('@')[1] ?? '';

function latestByShort(profiles: ProfileSummary[], wanted: Set<string>): Map<string, ProfileSummary> {
  const latest = new Map<string, ProfileSummary>();
  for (const p of profiles) {
    const s = shortOf(p.id);
    if (!wanted.has(s)) continue;
    const existing = latest.get(s);
    // Numeric-aware compare so 0.10 > 0.9.
    if (!existing || versionOf(p.id).localeCompare(versionOf(existing.id), undefined, { numeric: true }) > 0) {
      latest.set(s, p);
    }
  }
  return latest;
}

export function pickerEntries(
  profiles: ProfileSummary[],
  manifests: IntegrationManifest[],
  integrations: McpIntegrationStatus[],
  builtins: BuiltinStatus[],
): PickerEntry[] {
  const wanted = new Set<string>([
    ...manifests.filter(m => m.profile).map(m => m.profile as string),
    ...builtins.map(b => shortOf(b.profile)),
  ]);
  const latest = latestByShort(profiles, wanted);
  const entries: PickerEntry[] = [];

  // One entry per INSTALLED INTEGRATION, not per profile: several connectors can
  // share one profile, and a profile-keyed list loses all but one of them.
  for (const manifest of manifests) {
    const profile = manifest.profile ? latest.get(manifest.profile) : undefined;
    if (!profile) continue;
    entries.push({
      key: `connector:${manifest.id}`,
      name: manifest.name,
      description: manifest.description || profile.description,
      profile,
      kind: 'connector',
      ready: integrations.find(i => i.id === manifest.id)?.running === true,
      setupId: manifest.id,
    });
  }
  for (const b of builtins) {
    const profile = latest.get(shortOf(b.profile));
    if (!profile) continue; // the AS does not serve the profile (yet) — a mandate could not be signed
    entries.push({
      key: `builtin:${b.id}`,
      name: b.name,
      description: b.description || profile.description,
      profile,
      kind: 'builtin',
      ready: b.available,
      unavailableReason: b.available ? undefined : 'Available only while simulation mode is on.',
    });
  }
  return entries;
}
