/**
 * How this gateway was installed — decides which update message the UI shows
 * (update-checker.ts, UpdateBanner.tsx).
 *
 *   managed → IT-provisioned: SUVEREN_INSTALL_METHOD=managed, or IT policy
 *             InstallMethod=managed (lib/policy.ts). Banner: neutral, "updates
 *             come from your IT", no action.
 *   msi     → the Windows installer, installed by the person themselves. The
 *             installer ships a marker file (INSTALL_MARKER) in the bundle root,
 *             so this holds however the gateway was started (Start menu,
 *             scheduled task, by hand). Banner: red, "Download installer".
 *   docker  → /.dockerenv present.
 *   npm     → a global npm install (path), and the fallback.
 *   dev     → a git checkout above the running code.
 *
 * Order matters: IT's managed setting wins over the installer's marker.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type InstallMethod = 'docker' | 'npm' | 'dev' | 'managed' | 'msi';

/** Written by bundle/windows/build-payload.mjs into the gateway bundle root. */
export const INSTALL_MARKER = 'install-method.json';

/** The marker's `method`, or null when absent or unreadable. */
export function readInstallMarker(bundleRoot: string): string | null {
  const file = join(bundleRoot, INSTALL_MARKER);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { method?: unknown };
    return typeof parsed.method === 'string' ? parsed.method : null;
  } catch {
    return null;
  }
}

export interface DetectInput {
  /** Directory of the running control-plane code (…/dist/control-plane). */
  dir: string;
  /** /.dockerenv exists. */
  dockerEnv: boolean;
  /** SUVEREN_INSTALL_METHOD=managed or IT policy InstallMethod=managed. */
  managed: boolean;
}

export function detectInstallMethod({ dir, dockerEnv, managed }: DetectInput): InstallMethod {
  if (managed) return 'managed';

  // dist/control-plane → bundle root (where server.js and the marker live).
  if (readInstallMarker(dirname(dirname(dir))) === 'msi') return 'msi';

  if (dockerEnv) return 'docker';

  if (dir.includes('/node_modules/@suveren/gateway/')) return 'npm';

  // Walk up looking for a .git — the only thing that makes the dev check meaningful.
  let cursor = dir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cursor, '.git'))) return 'dev';
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return 'npm';
}
