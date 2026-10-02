/**
 * Saved gateway config (`<dataDir>/config.json`) — the CLI's copy.
 *
 * Mirrors `apps/mcp-server/src/lib/as-config.ts` / `apps/control-plane/src/lib/as-config.ts`
 * (same file shape, same validation rules) but written in plain JS: this
 * runs as bundle/bin/suveren-gateway.js and bundle/server.js, which are
 * hand-authored ESM shipped as-is (not built by tsup like the apps), so
 * there is no shared runtime package to import the TS version from. Keep
 * all three in step if the shape or validation rules change.
 *
 * Not secret — an Authority Server URL and a CA file path are not
 * credentials — so this is plain JSON, same trust level as the rest of
 * config.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const DEFAULT_AS_URL = 'https://www.suveren.ai';

function configPath(dataDir) {
  return join(dataDir, 'config.json');
}

/** Tolerant of a missing or corrupt file — both degrade to "{}", never throw. */
export function readConfig(dataDir) {
  const path = configPath(dataDir);
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const out = {};
    if (typeof data.asUrl === 'string') out.asUrl = data.asUrl;
    if (typeof data.caFile === 'string') out.caFile = data.caFile;
    if (typeof data.pinTls === 'boolean') out.pinTls = data.pinTls;
    if (typeof data.pinTlsExpectedFingerprint === 'string') out.pinTlsExpectedFingerprint = data.pinTlsExpectedFingerprint;
    if (typeof data.simulation === 'boolean') out.simulation = data.simulation;
    return out;
  } catch {
    return {};
  }
}

/**
 * Strict counterpart used only by resolveAsUrl: distinguishes "genuinely
 * absent" (fine — falls through to the default) from "present but
 * unparsable" (must refuse to start, not silently behave like an empty
 * file — see resolveAsUrl's doc comment).
 */
function readConfigStrict(dataDir) {
  const path = configPath(dataDir);
  if (!existsSync(path)) return {};
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Could not parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const out = {};
  if (typeof data.asUrl === 'string') out.asUrl = data.asUrl;
  if (typeof data.caFile === 'string') out.caFile = data.caFile;
  if (typeof data.pinTls === 'boolean') out.pinTls = data.pinTls;
  if (typeof data.pinTlsExpectedFingerprint === 'string') out.pinTlsExpectedFingerprint = data.pinTlsExpectedFingerprint;
  if (typeof data.simulation === 'boolean') out.simulation = data.simulation;
  return out;
}

export function writeConfig(dataDir, patch) {
  const merged = { ...readConfig(dataDir), ...patch };
  const path = configPath(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 });
  return merged;
}

/**
 * Validate + normalize a candidate Authority Server URL.
 * https only, except http://localhost / http://127.0.0.1; trailing slash
 * stripped rather than rejected. Returns `{ ok, url }` or `{ ok: false, error }`.
 */
export function validateAsUrl(candidate) {
  const trimmed = (candidate ?? '').trim();
  if (!trimmed) return { ok: false, error: 'The Authority Server URL is empty.' };

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: `"${trimmed}" is not a valid URL.` };
  }

  const isLocalHttp =
    parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (parsed.protocol !== 'https:' && !isLocalHttp) {
    return {
      ok: false,
      error: `"${trimmed}" must use https:// (http:// is only allowed for http://localhost or http://127.0.0.1).`,
    };
  }

  let normalized = `${parsed.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (normalized.endsWith('/') && normalized !== `${parsed.origin}/`) {
    normalized = normalized.slice(0, -1);
  } else if (normalized === `${parsed.origin}/`) {
    normalized = parsed.origin;
  }

  return { ok: true, url: normalized };
}

/**
 * Validate a candidate CA file path: must exist and be readable. Returns an
 * ABSOLUTE path (resolved against the CURRENT working directory) — a
 * relative one saved as-is would resolve differently depending on where a
 * later `start`/autostart happens to run from (a login service's cwd is
 * rarely the directory someone typed the flag from). Does not check that it
 * PARSES as PEM — Node reports that itself, loudly, at TLS handshake time if
 * it's wrong, which is soon enough for a rare setup step.
 */
export function validateCaFile(candidate) {
  const trimmed = (candidate ?? '').trim();
  if (!trimmed) return { ok: false, error: 'The CA file path is empty.' };
  const absolute = resolve(process.cwd(), trimmed);
  if (!existsSync(absolute)) return { ok: false, error: `No file at "${absolute}".` };
  return { ok: true, path: absolute };
}

/**
 * Resolution order: env SUVEREN_AS_URL > saved config > default. Throws on
 * an explicitly-set-but-invalid env var, AND on a saved value that is
 * present but invalid or on a config.json that won't parse — fail closed,
 * audibly. For a self-hosted customer, silently falling back to the public
 * default here would mean their real API key gets sent to suveren.ai instead
 * of their own server. Only a genuinely ABSENT saved value (nothing was ever
 * set) falls through to the default.
 */
export function resolveAsUrl(dataDir) {
  const envUrl = process.env.SUVEREN_AS_URL;
  if (envUrl) {
    const v = validateAsUrl(envUrl);
    if (!v.ok) throw new Error(`Invalid SUVEREN_AS_URL: ${v.error}`);
    return v.url;
  }
  const saved = readConfigStrict(dataDir).asUrl;
  if (saved) {
    const v = validateAsUrl(saved);
    if (!v.ok) throw new Error(`Invalid saved as-url "${saved}" in ${dataDir}/config.json: ${v.error}`);
    return v.url;
  }
  return DEFAULT_AS_URL;
}

/** The saved CA file path, if any — no env/flag tier (see bundle/server.js,
 *  the one place that reads and acts on it). */
export function resolveCaFile(dataDir) {
  return readConfig(dataDir).caFile;
}

/**
 * Validate a candidate --pin-tls value against the EFFECTIVE Authority
 * Server URL: TLS pinning on an http:// AS (only ever localhost/127.0.0.1 —
 * see validateAsUrl) has nothing to pin, so enabling it there is refused
 * rather than silently accepted and then doing nothing.
 */
export function validatePinTls(effectiveAsUrl) {
  let parsed;
  try {
    parsed = new URL(effectiveAsUrl);
  } catch {
    return { ok: false, error: `"${effectiveAsUrl}" is not a valid URL.` };
  }
  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      error: `--pin-tls requires an https:// Authority Server URL (currently "${effectiveAsUrl}") — there is no TLS certificate to pin.`,
    };
  }
  return { ok: true };
}

/** The saved pin-tls setting. No env/flag tier — only ever set through
 *  `--pin-tls` / `config set pin-tls on|off`. Default false: opt-in,
 *  never silently on. */
export function resolvePinTls(dataDir) {
  return readConfig(dataDir).pinTls === true;
}

/**
 * A fingerprint confirmed via `--expect-fingerprint` BEFORE any signing-key
 * pairing exists yet (so there is no as-pairing.json to attach a TLS pin
 * to — see as-pairing.mjs's `recordTlsPin`, which needs an existing record).
 * Staged here until the first verified sign-in challenge: that challenge
 * MUST match this value (enforced exactly like an already-stored pin — see
 * the control plane's checkAsKeyBeforeLogin), and once it does, the value
 * moves into as-pairing.json and this staging field is cleared. Absent in
 * every other case — once a real pairing with a TLS pin exists, that record
 * is authoritative and this is never consulted again.
 */
export function resolvePinTlsExpectedFingerprint(dataDir) {
  return readConfig(dataDir).pinTlsExpectedFingerprint;
}

/**
 * The saved simulation-mode setting (default false — off, nothing changes for
 * a normal install). No env/flag tier of its own here: `start --simulation`
 * and `simulation on|off` both go through `writeConfig`, and bundle/server.js
 * is the one place that turns this saved value into `SUVEREN_SIMULATION` for
 * the children it spawns (see that file's doc comment) — mirroring how
 * `resolveCaFile` works, not how `resolveAsUrl` works (no env override here;
 * an operator who wants to force it for one run can still set
 * SUVEREN_SIMULATION directly, which server.js honours ahead of this).
 */
export function resolveSimulation(dataDir) {
  return readConfig(dataDir).simulation === true;
}
