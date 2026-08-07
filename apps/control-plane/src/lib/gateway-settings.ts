/**
 * Local gateway preferences — `~/.suveren/settings.json`.
 *
 * Deliberately tiny and unencrypted: these are display preferences, not
 * credentials. Nothing here may ever hold a secret; the vault exists for that.
 *
 * Reads are forgiving (a missing or corrupt file yields defaults, because a
 * malformed preferences file must never stop the gateway serving); writes are
 * strict (unknown keys are dropped rather than persisted).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export interface GatewaySettings {
  /** Native OS notification when something is waiting for review. */
  desktopNotifications: boolean;
}

export const DEFAULT_SETTINGS: GatewaySettings = {
  desktopNotifications: true,
};

function settingsPath(dataDir?: string): string {
  const dir = dataDir ?? process.env.SUVEREN_DATA_DIR ?? join(homedir(), '.suveren');
  return join(dir, 'settings.json');
}

export function readSettings(dataDir?: string): GatewaySettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(dataDir), 'utf8')) as Record<string, unknown>;
    return {
      desktopNotifications:
        typeof raw.desktopNotifications === 'boolean'
          ? raw.desktopNotifications
          : DEFAULT_SETTINGS.desktopNotifications,
    };
  } catch {
    // Missing, unreadable, or malformed — defaults, silently. A preferences
    // file is not worth failing a startup over.
    return { ...DEFAULT_SETTINGS };
  }
}

/** Merge a partial update over the current values. Unknown keys are ignored. */
export function writeSettings(patch: Partial<GatewaySettings>, dataDir?: string): GatewaySettings {
  const next: GatewaySettings = {
    ...readSettings(dataDir),
    ...(typeof patch.desktopNotifications === 'boolean'
      ? { desktopNotifications: patch.desktopNotifications }
      : {}),
  };
  const path = settingsPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}
