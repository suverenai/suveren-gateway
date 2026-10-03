/**
 * Managed-settings policy — IT-controlled overrides that an employee cannot
 * change locally (W3 of the Windows installer track; see
 * suveren-as/docs/work-plan.md, "Added 2026-10-02 — Windows installer").
 *
 * Sources, highest precedence first:
 *   1. Windows registry `HKLM\SOFTWARE\Policies\Suveren\Gateway`, then
 *      `HKCU\SOFTWARE\Policies\Suveren\Gateway` (HKLM wins over HKCU).
 *      Read via `reg query` (child_process) — no native modules. Skipped
 *      entirely on non-Windows.
 *   2. A JSON file: `%ProgramData%\Suveren\gateway-policy.json` (Windows),
 *      `/Library/Application Support/Suveren/gateway-policy.json` (macOS),
 *      `/etc/suveren/gateway-policy.json` (Linux) — overridable for tests
 *      via `SUVEREN_POLICY_FILE`.
 *
 * A key present in EITHER source is LOCKED: every resolver in this codebase
 * (as-config.ts's resolveAsUrl/resolveCaFile/resolvePinTls,
 * simulation-mode.ts's isSimulationMode) must return the policy value
 * regardless of env var, saved config.json, or CLI flag. Overall
 * precedence: policy > env > saved config > defaults.
 *
 * `Proxy` is the one key that OVERRIDES an environment variable rather than
 * merely out-ranking a saved value: on a Windows company laptop the proxy is
 * set in system settings, not `HTTP_PROXY`/`HTTPS_PROXY` — see
 * bundle/server.js, which sets both env vars from the policy value
 * unconditionally when `Proxy` is locked (every other locked key has no env
 * tier to override in the first place; the apps themselves never read this
 * key directly — they only ever see `HTTP_PROXY`/`HTTPS_PROXY` via
 * proxy-env.ts, already resolved by the time they start — `proxy`/`noProxy`
 * exist on `GatewayPolicy` here purely so `/health`'s `policyLocked` can
 * report them). `NoProxy` is read the same way but has no saved-config/CLI
 * counterpart at all — NO_PROXY stays env-only except for this one override.
 *
 * Registry value names = JSON file keys (PascalCase, matching what an IT
 * admin would see in either place): AsUrl, CaFile, PinTls, Proxy, NoProxy,
 * Simulation, InstallMethod.
 *
 * Mirrored (same logic, duplicated — no shared runtime package between the
 * CLI and the two apps, see as-config.ts's doc comment for the established
 * pattern) in `bundle/lib/policy.mjs` and
 * `apps/control-plane/src/lib/policy.ts`. Keep all three in step.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export type PolicyKey = 'asUrl' | 'caFile' | 'pinTls' | 'proxy' | 'noProxy' | 'simulation' | 'installMethod';

export interface GatewayPolicy {
  asUrl?: string;
  caFile?: string;
  pinTls?: boolean;
  proxy?: string;
  noProxy?: string;
  simulation?: boolean;
  installMethod?: 'managed';
}

export interface ResolvedPolicy {
  policy: GatewayPolicy;
  /** Keys present in policy — these are LOCKED: the employee cannot
   *  override them locally. */
  locked: Set<PolicyKey>;
}

const POLICY_KEYS = ['AsUrl', 'CaFile', 'PinTls', 'Proxy', 'NoProxy', 'Simulation', 'InstallMethod'] as const;

/** The documented production path, relative to the hive — never changes for
 *  a real install. Overridable ONLY via `SUVEREN_POLICY_REGISTRY_KEY`, which
 *  exists purely so `gateway-policy-windows-registry.test.ts` can point at a
 *  unique per-run key instead of the real one: `pnpm -r test` runs every
 *  workspace package in parallel, so a test writing to the REAL key would
 *  race every OTHER package's tests reading the real registry on the same
 *  Windows CI runner at the same time (this raced in practice — see
 *  `SUVEREN_POLICY_REGISTRY` below for the other half of the fix). */
const DEFAULT_REGISTRY_BASE_KEY = 'SOFTWARE\\Policies\\Suveren\\Gateway';

/** The full `HIVE\base\key` path `reg query`/`reg add` operate on. A pure
 *  function (no I/O) so a test can assert the default without mocking
 *  anything — see gateway-policy.test.ts's "documented default paths". */
export function registryKeyPath(hive: 'HKLM' | 'HKCU'): string {
  const baseKey = process.env.SUVEREN_POLICY_REGISTRY_KEY || DEFAULT_REGISTRY_BASE_KEY;
  return `${hive}\\${baseKey}`;
}
type RawPolicyKey = (typeof POLICY_KEYS)[number];
type RawPolicy = Partial<Record<RawPolicyKey, string | number | boolean>>;

/**
 * Validate + normalize a candidate Authority Server URL — the SAME rule
 * `config set as-url` enforces (see as-config.ts's validateAsUrl),
 * duplicated rather than imported so this module has no dependency on
 * as-config.ts.
 */
function validateAsUrl(candidate: string): { ok: boolean; url?: string; error?: string } {
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
  let normalized = `${parsed.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (normalized.endsWith('/') && normalized !== `${parsed.origin}/`) {
    normalized = normalized.slice(0, -1);
  } else if (normalized === `${parsed.origin}/`) {
    normalized = parsed.origin;
  }
  return { ok: true, url: normalized };
}

/** Same rule as as-config.ts's validateCaFile: must exist on disk. */
function validateCaFile(candidate: string): { ok: boolean; path?: string; error?: string } {
  const trimmed = candidate.trim();
  if (!trimmed) return { ok: false, error: 'The CA file path is empty.' };
  if (!existsSync(trimmed)) return { ok: false, error: `No file at "${trimmed}".` };
  return { ok: true, path: trimmed };
}

/** Same rule as proxy-env.ts's companion in config.mjs's validateProxyUrl:
 *  http:// or https:// only. */
function validateProxyUrl(candidate: string): { ok: boolean; url?: string; error?: string } {
  const trimmed = candidate.trim();
  if (!trimmed) return { ok: false, error: 'The proxy URL is empty.' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: `"${trimmed}" is not a valid URL.` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `"${trimmed}" must use http:// or https://.` };
  }
  return { ok: true, url: trimmed };
}

/** Accepts a JSON boolean, or the DWORD-style 0/1 (as a number OR a string,
 *  since the registry parser below hands back numbers but a hand-edited
 *  JSON file might use either). Returns undefined — not a default — for
 *  anything else, so the caller can tell "not a boolean" from "false". */
function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 0) return false;
    if (value === 1) return true;
    return undefined;
  }
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  return undefined;
}

// ─── Registry (Windows only) ────────────────────────────────────────────

/**
 * Parse `reg query "HKLM\...\Gateway"` stdout. Real output looks like:
 *
 *   HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Suveren\Gateway
 *       AsUrl    REG_SZ    https://as.company.internal
 *       PinTls    REG_DWORD    0x1
 *
 * Value lines are 4-space-indented; columns are separated by runs of
 * whitespace. REG_DWORD values print as hex ("0x1"), parsed to a number
 * here so coerceBoolean can treat it like any other 0/1.
 */
export function parseRegQueryOutput(stdout: string): RawPolicy {
  const out: RawPolicy = {};
  const lineRe = /^ {4}(\S+)\s+(REG_SZ|REG_EXPAND_SZ|REG_DWORD|REG_QWORD|REG_BINARY|REG_MULTI_SZ)\s+(.*)$/;
  for (const line of stdout.split(/\r?\n/)) {
    const m = lineRe.exec(line);
    if (!m) continue;
    const [, name, type, rawValue] = m;
    if (!(POLICY_KEYS as readonly string[]).includes(name)) continue;
    const key = name as RawPolicyKey;
    if (type === 'REG_DWORD' || type === 'REG_QWORD') {
      out[key] = parseInt(rawValue, 16);
    } else {
      out[key] = rawValue;
    }
  }
  return out;
}

interface SourcedRaw {
  values: RawPolicy;
  source: string;
}

/** `{ values, source }` for one registry hive, or `{ values: {}, source }`
 *  on any failure (key absent — the normal "no policy set" case — missing
 *  `reg` binary, or a platform that isn't Windows at all). Never throws: an
 *  operator without IT policy must see the gateway behave exactly as it
 *  always has.
 *
 *  `SUVEREN_POLICY_REGISTRY=off` skips the registry entirely, returning
 *  `{}` without even spawning `reg` — unit tests set this globally (see
 *  vitest.setup.ts) so a real IT policy on the machine running the suite,
 *  or another package's test writing to the registry concurrently, cannot
 *  change what these tests see. Production never sets this. */
function readRegistryHive(hive: 'HKLM' | 'HKCU'): SourcedRaw {
  const path = registryKeyPath(hive);
  const source = `the registry policy (${path})`;
  // Checked BEFORE the platform branch so the switch is testable on any OS,
  // not just Windows — see gateway-policy.test.ts.
  if (process.env.SUVEREN_POLICY_REGISTRY === 'off') return { values: {}, source };
  if (process.platform !== 'win32') return { values: {}, source };
  let result;
  try {
    result = spawnSync('reg', ['query', path], { encoding: 'utf8' });
  } catch {
    return { values: {}, source };
  }
  if (!result || result.status !== 0 || !result.stdout) return { values: {}, source };
  return { values: parseRegQueryOutput(result.stdout), source };
}

// ─── Policy file ────────────────────────────────────────────────────────

export function policyFilePath(): string {
  if (process.env.SUVEREN_POLICY_FILE) return process.env.SUVEREN_POLICY_FILE;
  if (process.platform === 'win32') {
    const programData = process.env.ProgramData || process.env.PROGRAMDATA || 'C:\\ProgramData';
    return join(programData, 'Suveren', 'gateway-policy.json');
  }
  if (process.platform === 'darwin') {
    return '/Library/Application Support/Suveren/gateway-policy.json';
  }
  return '/etc/suveren/gateway-policy.json';
}

/** Throws (fail closed, audibly — same rule as as-config.ts's
 *  readAsConfigStrict) when the file exists but is not valid JSON. A
 *  missing file is the normal "no policy set" case and returns `{}`. */
function readPolicyFile(): SourcedRaw {
  const path = policyFilePath();
  const source = `the policy file (${path})`;
  if (!existsSync(path)) return { values: {}, source };
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Could not parse policy file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const values: RawPolicy = {};
  for (const key of POLICY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      values[key] = data[key] as string | number | boolean;
    }
  }
  return { values, source };
}

// ─── Merge + validate ───────────────────────────────────────────────────

/** First entry (in precedence order) that defines each key wins. Returns
 *  the merged raw values plus, per key, which source they came from (for
 *  error messages). */
function mergeBySource(entries: SourcedRaw[]): { merged: RawPolicy; sourceOf: Partial<Record<RawPolicyKey, string>> } {
  const merged: RawPolicy = {};
  const sourceOf: Partial<Record<RawPolicyKey, string>> = {};
  for (const key of POLICY_KEYS) {
    for (const entry of entries) {
      if (Object.prototype.hasOwnProperty.call(entry.values, key) && entry.values[key] !== undefined) {
        merged[key] = entry.values[key];
        sourceOf[key] = entry.source;
        break;
      }
    }
  }
  return { merged, sourceOf };
}

let cached: ResolvedPolicy | null = null;

/**
 * Read + validate the effective policy. Memoized for the life of the
 * process (registry reads spawn a child process — doing that on every
 * `isSimulationMode()` call, which runs per tool call, would be a
 * synchronous fork on the hot path). Policy changes take effect on the next
 * restart anyway, same as every other setting here — see
 * `_resetPolicyCacheForTests` for the one case that needs otherwise.
 *
 * Throws a named error — mentioning the key, the offending value, and which
 * source it came from — on an invalid value, exactly like a bad `config
 * set` input (see as-config.ts's resolveAsUrl doc comment on failing closed
 * and audibly rather than silently falling back).
 */
export function readPolicy(): ResolvedPolicy {
  if (cached) return cached;

  const hklm = readRegistryHive('HKLM');
  const hkcu = readRegistryHive('HKCU');
  const file = readPolicyFile(); // may throw — propagated, not swallowed

  const { merged, sourceOf } = mergeBySource([hklm, hkcu, file]);

  const policy: GatewayPolicy = {};
  const locked = new Set<PolicyKey>();

  if (merged.AsUrl !== undefined) {
    const v = validateAsUrl(String(merged.AsUrl));
    if (!v.ok) {
      throw new Error(`Invalid policy AsUrl ("${merged.AsUrl}") from ${sourceOf.AsUrl}: ${v.error}`);
    }
    policy.asUrl = v.url;
    locked.add('asUrl');
  }

  if (merged.CaFile !== undefined) {
    const v = validateCaFile(String(merged.CaFile));
    if (!v.ok) {
      throw new Error(`Invalid policy CaFile ("${merged.CaFile}") from ${sourceOf.CaFile}: ${v.error}`);
    }
    policy.caFile = v.path;
    locked.add('caFile');
  }

  if (merged.PinTls !== undefined) {
    const b = coerceBoolean(merged.PinTls);
    if (b === undefined) {
      throw new Error(
        `Invalid policy PinTls ("${String(merged.PinTls)}") from ${sourceOf.PinTls}: must be a boolean or 0/1.`,
      );
    }
    policy.pinTls = b;
    locked.add('pinTls');
  }

  if (merged.Proxy !== undefined) {
    const v = validateProxyUrl(String(merged.Proxy));
    if (!v.ok) {
      throw new Error(`Invalid policy Proxy ("${String(merged.Proxy)}") from ${sourceOf.Proxy}: ${v.error}`);
    }
    policy.proxy = v.url;
    locked.add('proxy');
  }

  // NoProxy has no saved-config/CLI counterpart — just a string, no URL
  // shape to validate (it's a NO_PROXY-style hostname list, same grammar as
  // the env var itself).
  if (merged.NoProxy !== undefined) {
    const raw = String(merged.NoProxy).trim();
    if (!raw) {
      throw new Error(`Invalid policy NoProxy ("${String(merged.NoProxy)}") from ${sourceOf.NoProxy}: must not be empty.`);
    }
    policy.noProxy = raw;
    locked.add('noProxy');
  }

  if (merged.Simulation !== undefined) {
    const b = coerceBoolean(merged.Simulation);
    if (b === undefined) {
      throw new Error(
        `Invalid policy Simulation ("${String(merged.Simulation)}") from ${sourceOf.Simulation}: must be a boolean or 0/1.`,
      );
    }
    policy.simulation = b;
    locked.add('simulation');
  }

  if (merged.InstallMethod !== undefined) {
    const raw = String(merged.InstallMethod).trim().toLowerCase();
    if (raw !== 'managed') {
      throw new Error(
        `Invalid policy InstallMethod ("${String(merged.InstallMethod)}") from ${sourceOf.InstallMethod}: only "managed" is supported.`,
      );
    }
    policy.installMethod = 'managed';
    locked.add('installMethod');
  }

  cached = { policy, locked };
  return cached;
}

/** Convenience: is this one key locked by policy? */
export function isPolicyLocked(key: PolicyKey): boolean {
  return readPolicy().locked.has(key);
}

/** Drop the memoized policy so the next `readPolicy()` call re-reads the
 *  registry/file. Test-only — a real process never needs this, since
 *  policy is only ever consulted again after a restart. */
export function _resetPolicyCacheForTests(): void {
  cached = null;
}
