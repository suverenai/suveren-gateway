/**
 * Authority Server URL + CA file — resolution and validation.
 *
 * Customers run their own Authority Server inside their network, so the
 * gateway must be told where it lives. Precedence, highest first:
 *
 *   1. an explicit flag (`suveren-gateway start --as-url <url>` — CLI only,
 *      collapses into the env tier below before any Node process using this
 *      module ever starts, see bundle/bin/suveren-gateway.js)
 *   2. env var `SUVEREN_AS_URL`
 *   3. saved config (`<dataDir>/config.json`, written by `config set as-url`)
 *   4. default `https://www.suveren.ai`
 *
 * Mirrors `apps/mcp-server/src/lib/as-config.ts` (same logic, duplicated
 * because the two apps are separate published bundles with no shared internal
 * runtime package — see client-version.ts for the established precedent).
 * Keep the two in step if either changes.
 *
 * Deliberately takes `dataDir` as an explicit parameter rather than reading
 * `process.env.SUVEREN_DATA_DIR` itself: every stateful module in this
 * codebase (Vault, GateStore, …) follows that shape so tests can point at a
 * disposable tmp directory instead of ever touching a real `~/.suveren`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_AS_URL = 'https://www.suveren.ai';

export interface AsConfig {
  asUrl?: string;
  caFile?: string;
  /** Opt-in TLS certificate pinning for every connection to the Authority
   *  Server (SPKI pin captured at pairing — see as-tls-pin.ts). Default
   *  false/absent. Refused at `config set pin-tls on` / `start --pin-tls`
   *  for an http:// AS URL, since there is no TLS to pin. */
  pinTls?: boolean;
  /** A fingerprint confirmed via `--expect-fingerprint` (the mandatory
   *  out-of-band check — see bundle/bin/suveren-gateway.js) BEFORE any
   *  signing-key pairing exists yet, so there is no as-pairing.json to
   *  attach a TLS pin to. Staged here until the first verified sign-in
   *  challenge, which MUST match it (enforced exactly like an
   *  already-stored pin — see auth.ts's checkAsKeyBeforeLogin); once it
   *  does, the value moves into as-pairing.json and this field is cleared.
   *  Never consulted once a real pairing with a TLS pin exists. */
  pinTlsExpectedFingerprint?: string;
}

function configPath(dataDir: string): string {
  return join(dataDir, 'config.json');
}

/**
 * Read the saved config file, distinguishing "genuinely absent" from
 * "present but unparsable" — resolveAsUrl needs that distinction (a corrupt
 * file must refuse to start, not silently behave like an empty one; see its
 * own doc comment). Other callers that don't care use readAsConfig below,
 * which flattens both cases to `{}`.
 */
function readAsConfigStrict(dataDir: string): AsConfig {
  const path = configPath(dataDir);
  if (!existsSync(path)) return {};
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Could not parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const out: AsConfig = {};
  if (typeof data.asUrl === 'string') out.asUrl = data.asUrl;
  if (typeof data.caFile === 'string') out.caFile = data.caFile;
  if (typeof data.pinTls === 'boolean') out.pinTls = data.pinTls;
  if (typeof data.pinTlsExpectedFingerprint === 'string') out.pinTlsExpectedFingerprint = data.pinTlsExpectedFingerprint;
  return out;
}

/** Read the saved config file. Tolerant of a missing or corrupt file — both
 *  degrade to "nothing saved", never to a thrown error. */
export function readAsConfig(dataDir: string): AsConfig {
  const path = configPath(dataDir);
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const out: AsConfig = {};
    if (typeof data.asUrl === 'string') out.asUrl = data.asUrl;
    if (typeof data.caFile === 'string') out.caFile = data.caFile;
    if (typeof data.pinTls === 'boolean') out.pinTls = data.pinTls;
    if (typeof data.pinTlsExpectedFingerprint === 'string') out.pinTlsExpectedFingerprint = data.pinTlsExpectedFingerprint;
    return out;
  } catch {
    return {};
  }
}

/** Merge `patch` into the saved config and persist it. Not secret — the AS
 *  URL and a CA file path carry nothing an attacker gains from reading, so
 *  (unlike vault.enc.json) this is plain JSON, matching config.json's role
 *  as ordinary settings rather than credentials. */
export function writeAsConfig(dataDir: string, patch: AsConfig): AsConfig {
  const merged = { ...readAsConfig(dataDir), ...patch };
  const path = configPath(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(merged, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return merged;
}

export interface AsUrlValidation {
  ok: boolean;
  /** Normalized value (trailing slash stripped) — only set when ok. */
  url?: string;
  error?: string;
}

/**
 * Validate + normalize a candidate Authority Server URL.
 *
 * Rules: https only, except `http://localhost` / `http://127.0.0.1` for
 * local development (a customer's internal AS during setup, or a dev loop);
 * no trailing slash in the stored/used value (a single trailing slash is
 * stripped rather than rejected — the common typo, not a violation worth
 * an error message for).
 */
export function validateAsUrl(candidate: string): AsUrlValidation {
  const trimmed = candidate.trim();
  if (!trimmed) return { ok: false, error: 'The Authority Server URL is empty.' };

  let parsed: URL;
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

  // Normalize: drop exactly one trailing slash (a bare origin's `/` pathname
  // is not a "trailing slash" in the sense this rule means — only strip when
  // there is more than just that).
  let normalized = `${parsed.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (normalized.endsWith('/') && normalized !== `${parsed.origin}/`) {
    normalized = normalized.slice(0, -1);
  } else if (normalized === `${parsed.origin}/`) {
    normalized = parsed.origin;
  }

  return { ok: true, url: normalized };
}

/**
 * Resolve the effective Authority Server URL for THIS process.
 *
 * `flag` is accepted for the rare in-process caller that already knows a
 * CLI-style override (there are none today — the CLI collapses its flag into
 * the `SUVEREN_AS_URL` env var it sets on the child process before this ever
 * runs — kept here so the precedence chain is documented in one place and
 * testable directly).
 *
 * Throws if ANY explicitly-set source — flag, env, OR a saved value that is
 * present but invalid/corrupt — is bad. An operator who typed a bad URL, or
 * whose config.json got hand-edited or corrupted, must be told loudly, never
 * silently redirected to the public default (see doc/engineering.md, "fail
 * closed, and audibly") — for a self-hosted customer, silently falling back
 * to `https://www.suveren.ai` means their real API key gets sent to the
 * public SaaS instead of their own server. Only a genuinely ABSENT saved
 * value (no config.json, or no `asUrl` key in it — nothing was ever set)
 * falls through to the default; that is the one case with nothing to have
 * gotten wrong.
 */
export function resolveAsUrl(dataDir: string, flag?: string): string {
  if (flag) {
    const v = validateAsUrl(flag);
    if (!v.ok) throw new Error(`Invalid --as-url: ${v.error}`);
    return v.url!;
  }

  const envUrl = process.env.SUVEREN_AS_URL;
  if (envUrl) {
    const v = validateAsUrl(envUrl);
    if (!v.ok) throw new Error(`Invalid SUVEREN_AS_URL: ${v.error}`);
    return v.url!;
  }

  // Strict: a config.json that exists but won't parse must not be treated
  // as "nothing saved" — see readAsConfigStrict's doc comment.
  const saved = readAsConfigStrict(dataDir).asUrl;
  if (saved) {
    const v = validateAsUrl(saved);
    if (!v.ok) throw new Error(`Invalid saved as-url "${saved}" in ${dataDir}/config.json: ${v.error}`);
    return v.url!;
  }

  return DEFAULT_AS_URL;
}

/** Resolve the saved CA file path, if any. No env/flag tier here — CA
 *  material is only ever set through `--ca-file` / `config set ca-file`,
 *  and propagated to child processes as `NODE_EXTRA_CA_CERTS` by the CLI /
 *  server.js (see bundle/server.js) rather than re-derived by each app. */
export function resolveCaFile(dataDir: string): string | undefined {
  return readAsConfig(dataDir).caFile;
}

/** Resolve the saved `pinTls` setting. No env/flag tier — only ever set
 *  through `--pin-tls` / `config set pin-tls on|off`. Default false:
 *  opt-in, never silently on. */
export function resolvePinTls(dataDir: string): boolean {
  return readAsConfig(dataDir).pinTls === true;
}

/**
 * Refuse to proceed (throws) when `pinTls` is on for a non-https Authority
 * Server URL — there is no TLS certificate to pin. Called at process
 * startup (control-plane's index.ts, mcp-server's bin/http.ts) so a
 * hand-edited config.json (not just the CLI's own `--pin-tls` / `config
 * set` validation, which only ever sees a value the USER just typed) is
 * caught too, loudly, before the gateway starts believing it is pinning
 * something it never checks.
 */
export function validatePinTlsForUrl(pinTls: boolean, asUrl: string): void {
  if (!pinTls) return;
  if (!asUrl.startsWith('https:')) {
    throw new Error(
      `config.json sets "pinTls": true, but the Authority Server URL (${asUrl}) is not https:// — ` +
        `there is no TLS certificate to pin. Fix the saved as-url, or turn pin-tls off: ` +
        `\`suveren-gateway config set pin-tls off\`.`,
    );
  }
}

/** Resolve the staged, not-yet-verified fingerprint, if any — see
 *  `AsConfig.pinTlsExpectedFingerprint`'s doc comment. Already lowercase,
 *  no separators (the CLI normalizes before saving). */
export function resolvePinTlsExpectedFingerprint(dataDir: string): string | undefined {
  return readAsConfig(dataDir).pinTlsExpectedFingerprint;
}

/** Remove the staged fingerprint once it has been captured into
 *  as-pairing.json for real (see auth.ts's checkAsKeyBeforeLogin) — a no-op
 *  when none is staged. `undefined` in the patch drops the key entirely
 *  (JSON.stringify omits undefined-valued properties). */
export function clearPinTlsExpectedFingerprint(dataDir: string): void {
  if (readAsConfig(dataDir).pinTlsExpectedFingerprint === undefined) return;
  writeAsConfig(dataDir, { pinTlsExpectedFingerprint: undefined });
}

