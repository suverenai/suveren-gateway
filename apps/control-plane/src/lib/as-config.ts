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
}

function configPath(dataDir: string): string {
  return join(dataDir, 'config.json');
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
 * Throws if an EXPLICITLY given source (flag or env) is invalid — an
 * operator who typed a bad URL must be told loudly, not silently redirected
 * to the public default (see doc/engineering.md, "fail closed, and audibly").
 * A bad SAVED value is downgraded to a warning instead: it was validated when
 * it was written, so a bad value there means the file was hand-edited or
 * corrupted, and refusing to start on that is a worse failure mode than
 * falling back to the default.
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

  const saved = readAsConfig(dataDir).asUrl;
  if (saved) {
    const v = validateAsUrl(saved);
    if (v.ok) return v.url!;
    console.error(`[as-config] Ignoring saved as-url "${saved}" — ${v.error}`);
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
