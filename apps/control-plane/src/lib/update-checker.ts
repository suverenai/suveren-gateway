/**
 * Update checker — compares the running gateway against the latest
 * release in whichever registry distributed it.
 *
 *   docker  → GHCR manifest digest for ghcr.io/.../hap-gateway:latest
 *             vs. the running image's digest (looked up by short SHA).
 *   npm     → registry.npmjs.org "latest" version vs. the running
 *             bundle's package.json#version.
 *   dev     → always reports update available (warns the developer
 *             to pull).
 *
 * Boots with a 30s initial delay to avoid hammering the registry on
 * every restart, then re-checks once per hour as a safety net for
 * idle tabs. Callers can force an immediate check via forceCheck();
 * the UI does this on every mount/login so users who just opened the
 * app get an accurate update status in the same response.
 */

export type InstallMethod = 'docker' | 'npm' | 'dev';

const GHCR_IMAGE = 'humanagencyprotocol/hap-gateway';
const NPM_PACKAGE = '@humanagencyp/hap-gateway';
const CHECK_INTERVAL = 60 * 60 * 1000; // 60 minutes
const INITIAL_DELAY = 30_000; // 30 seconds after boot

let updateAvailable = false;
let lastCheckedAt = 0;
let installMethod: InstallMethod = 'docker';
let runningVersion = 'dev';
let latestVersion: string | null = null;

export function getUpdateStatus() {
  return { updateAvailable, runningSha: runningVersion, latestVersion, lastCheckedAt };
}

/** Force an immediate registry check, bypassing the cache. Used by
 *  /health?refresh=1 on UI mount. Swallows errors. */
export async function forceCheck(): Promise<void> {
  try {
    await check();
  } catch {
    // Registry unreachable — state stays at last-known value
  }
}

// ─── GHCR (Docker) check ────────────────────────────────────────────────

async function ghcrToken(): Promise<string> {
  const res = await fetch(`https://ghcr.io/token?scope=repository:${GHCR_IMAGE}:pull`);
  const data = (await res.json()) as { token: string };
  return data.token;
}

async function ghcrDigest(tag: string, token: string): Promise<string | null> {
  const res = await fetch(`https://ghcr.io/v2/${GHCR_IMAGE}/manifests/${tag}`, {
    method: 'HEAD',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.oci.image.index.v1+json',
    },
  });
  if (!res.ok) return null;
  return res.headers.get('docker-content-digest');
}

async function checkDocker(): Promise<void> {
  const token = await ghcrToken();
  const latestDigest = await ghcrDigest('latest', token);
  if (!latestDigest) return;

  // Running version is the git SHA from HAP_BUILD_SHA — used as the tag
  // to look up the running image's digest. Short the first 7 chars to
  // match the way publish.yml tags images.
  const runningDigest = await ghcrDigest(runningVersion.slice(0, 7), token);
  updateAvailable = !runningDigest || runningDigest !== latestDigest;
  latestVersion = latestDigest.slice(0, 19); // truncate sha256:… for display
  lastCheckedAt = Date.now();
}

// ─── npm registry check ─────────────────────────────────────────────────

async function checkNpm(): Promise<void> {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(NPM_PACKAGE)}/latest`);
  if (!res.ok) return;
  const data = (await res.json()) as { version: string };
  latestVersion = data.version;
  updateAvailable = compareSemver(data.version, runningVersion) > 0;
  lastCheckedAt = Date.now();
}

/** Naive semver compare (sufficient for our 0.x.y line). Returns
 *  >0 if a > b, <0 if a < b, 0 equal. Strips pre-release tags so
 *  '0.1.2-alpha' compares equal to '0.1.2' for the headline check. */
function compareSemver(a: string, b: string): number {
  const norm = (v: string) =>
    v.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const aa = norm(a);
  const bb = norm(b);
  for (let i = 0; i < 3; i++) {
    const av = aa[i] ?? 0;
    const bv = bb[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

// ─── Dispatcher ─────────────────────────────────────────────────────────

async function check(): Promise<void> {
  try {
    if (installMethod === 'dev') {
      updateAvailable = true;
      lastCheckedAt = Date.now();
      return;
    }
    if (installMethod === 'npm') {
      await checkNpm();
      return;
    }
    await checkDocker();
  } catch {
    // Registry unreachable — leave state alone
  }
}

export function startUpdateChecker(method: InstallMethod, version: string): void {
  installMethod = method;
  runningVersion = version;
  setTimeout(() => {
    check().catch(() => {});
    setInterval(() => check().catch(() => {}), CHECK_INTERVAL);
  }, INITIAL_DELAY);
}
