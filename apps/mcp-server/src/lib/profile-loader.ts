/**
 * Profile Loader — reads Suveren profiles from disk and registers them.
 *
 * Reads hap-profiles/index.json, loads each profile JSON, and calls
 * registerProfile() from @hap/core.
 *
 * Configurable via SUVEREN_PROFILES_DIR env var (defaults to ../../hap-profiles
 * relative to cwd).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { registerProfile } from '@hap/core';
import type { AgentProfile } from '@hap/core';

interface ProfileIndex {
  repository: string;
  profiles: Record<string, string>;
}

/**
 * Load all profiles from the profiles directory and register them.
 * Returns the number of profiles loaded.
 */
export function loadProfiles(profilesDir?: string): number {
  // Default: ../../../../../hap-profiles relative to this file (src/lib → src → mcp-server → apps → hap-gateway → Suveren/hap-profiles)
  const dir = resolve(profilesDir ?? process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname ?? __dirname, '..', '..', '..', '..', '..', 'hap-profiles'));
  const indexPath = join(dir, 'index.json');

  if (!existsSync(indexPath)) {
    console.error(`[ProfileLoader] No index.json found at ${indexPath}, skipping profile loading`);
    return 0;
  }

  let index: ProfileIndex;
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf-8'));
  } catch (err) {
    console.error(`[ProfileLoader] Failed to parse ${indexPath}:`, err);
    return 0;
  }

  let loaded = 0;
  for (const [profileId, relativePath] of Object.entries(index.profiles)) {
    const profilePath = join(dir, relativePath);
    try {
      const profile: AgentProfile = JSON.parse(readFileSync(profilePath, 'utf-8'));
      registerProfile(profileId, profile);

      // Also register by short name (e.g., "charge") for easier lookup
      const shortName = profileId.split('/').pop()?.replace(/@.*$/, '');
      if (shortName && shortName !== profileId) {
        registerProfile(shortName, profile);
      }

      loaded++;
    } catch (err) {
      console.error(`[ProfileLoader] Failed to load profile ${profileId} from ${profilePath}:`, err);
    }
  }

  console.error(`[ProfileLoader] Loaded ${loaded} profile(s) from ${dir}`);
  return loaded;
}
