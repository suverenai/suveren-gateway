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
  // Default: ../../../../../hap-profiles relative to this file (src/lib → src → mcp-server → apps → suveren-gateway → Development/hap-profiles)
  const dir = resolve(profilesDir ?? process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname ?? __dirname, '..', '..', '..', '..', '..', 'hap-profiles'));
  const indexPath = join(dir, 'index.json');

  if (!existsSync(indexPath)) {
    warnNoProfiles(`No index.json at ${indexPath}`);
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

  if (loaded === 0) {
    warnNoProfiles(`index.json at ${indexPath} registered 0 profiles`);
  } else {
    console.error(`[ProfileLoader] Loaded ${loaded} profile(s) from ${dir}`);
  }
  return loaded;
}

/**
 * Loud, unmistakable warning when no profiles are registered. With zero
 * profiles the Gatekeeper rejects EVERY gated action with "Unknown profile"
 * (the 0.2.8 packaging bug). Make that obvious at startup, not only when a
 * user's first action is silently refused.
 */
function warnNoProfiles(reason: string): void {
  console.error(
    '\n' +
    '╔════════════════════════════════════════════════════════════════════╗\n' +
    '║  ⚠  NO PROFILES LOADED — every gated action will be REJECTED with   ║\n' +
    '║     "Unknown profile". This gateway is misconfigured.               ║\n' +
    `║     Reason: ${reason}\n` +
    '║     Fix: install a build that bundles profiles, or set              ║\n' +
    '║     SUVEREN_PROFILES_DIR to a hap-profiles checkout, then restart.  ║\n' +
    '╚════════════════════════════════════════════════════════════════════╝\n',
  );
}
