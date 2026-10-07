/**
 * Install settings — the gateway's two ports and its data folder, saved per
 * user so a chosen value survives a reboot and every command agrees on it.
 *
 * Before this, all three were environment-only (SUVEREN_CP_PORT,
 * SUVEREN_MCP_PORT, SUVEREN_DATA_DIR). That never reached the login task on
 * Windows (Task Scheduler carries no environment), so a custom port or
 * folder was silently lost after a reboot; and `status`/`stop`/the Start
 * Menu entry looked at 3400 unless the variable was set in that very shell.
 *
 * They cannot live in `<dataDir>/config.json` like the other settings — the
 * gateway has to know the data folder before it can read anything in it.
 * So they get their own place outside it:
 *
 *   - Windows: `HKCU\Software\Suveren\Gateway`, values `Port`, `McpPort`,
 *     `DataDir` (REG_SZ). The installer writes them from its PORT /
 *     MCP_PORT / DATA_DIR properties (bundle/windows/wix/Product.wxs);
 *     `config set` writes the same values with `reg add`.
 *   - macOS: `~/Library/Application Support/Suveren/gateway.json`
 *   - Linux: `$XDG_CONFIG_HOME/suveren/gateway.json` (default ~/.config)
 *   - Any platform: `SUVEREN_INSTALL_SETTINGS_FILE` forces the JSON file at
 *     that path — tests set it (see each app's vitest.setup.ts) so they never
 *     touch the real registry or the real per-user file.
 *
 * Precedence, per setting: IT policy (`Port`, `McpPort`, `DataDir` — see
 * policy.mjs; locked) > env var > saved install setting > default.
 *
 * Resolved ONLY here, by the CLI and by bundle/server.js. server.js passes
 * the result to its children as SUVEREN_CP_PORT / SUVEREN_MCP_PORT /
 * SUVEREN_DATA_DIR, so the two apps keep reading plain env vars and need no
 * copy of this module (unlike config.mjs / policy.mjs, which they mirror).
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readPolicy } from './policy.mjs';

export const DEFAULT_CP_PORT = 3400;
export const DEFAULT_MCP_PORT = 3430;

export function defaultDataDir() {
  return join(homedir(), '.suveren');
}

/** Saved-setting name ↔ registry value name ↔ env var. */
const FIELDS = {
  cpPort: { reg: 'Port', env: 'SUVEREN_CP_PORT', label: 'port' },
  mcpPort: { reg: 'McpPort', env: 'SUVEREN_MCP_PORT', label: 'mcp-port' },
  dataDir: { reg: 'DataDir', env: 'SUVEREN_DATA_DIR', label: 'data-dir' },
};

// ─── Validation ─────────────────────────────────────────────────────────

/**
 * A port someone chose to SAVE (CLI, installer, IT policy): 1024–65535.
 * Below 1024 needs root on macOS/Linux and is reserved for system services —
 * a gateway that silently cannot bind there is worse than a refusal now.
 */
export function validatePort(candidate) {
  const raw = String(candidate ?? '').trim();
  if (!/^\d+$/.test(raw)) return { ok: false, error: `"${raw}" is not a port number.` };
  const port = Number(raw);
  if (port < 1024 || port > 65535) {
    return { ok: false, error: `${port} is outside 1024–65535.` };
  }
  return { ok: true, port };
}

/**
 * An env-var port: any valid TCP port (1–65535). Looser than validatePort on
 * purpose — the Docker image runs on 3000/3030 and dev setups have always
 * been free to pick anything; only "not a number at all" is refused.
 */
function validateEnvPort(candidate) {
  const raw = String(candidate).trim();
  if (!/^\d+$/.test(raw)) return { ok: false, error: `"${raw}" is not a port number.` };
  const port = Number(raw);
  if (port < 1 || port > 65535) return { ok: false, error: `${port} is outside 1–65535.` };
  return { ok: true, port };
}

/**
 * A data folder someone chose to SAVE: must be an ABSOLUTE path (a relative
 * one would resolve differently for the login service than for the shell
 * that saved it), and must not be an existing file. It need not exist yet —
 * the gateway creates it on start.
 */
export function validateDataDir(candidate) {
  const raw = String(candidate ?? '').trim();
  if (!raw) return { ok: false, error: 'The data folder path is empty.' };
  if (!isAbsolute(raw)) return { ok: false, error: `"${raw}" is not a full path (it must start at a drive or at /).` };
  const path = resolve(raw);
  if (existsSync(path) && !statSync(path).isDirectory()) {
    return { ok: false, error: `"${path}" is a file, not a folder.` };
  }
  return { ok: true, path };
}

// ─── Storage ────────────────────────────────────────────────────────────

export function installSettingsFilePath() {
  if (process.env.SUVEREN_INSTALL_SETTINGS_FILE) return process.env.SUVEREN_INSTALL_SETTINGS_FILE;
  if (process.platform === 'win32') return null; // registry — see installSettingsRegistryKey
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Suveren', 'gateway.json');
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'suveren', 'gateway.json');
}

/** Where the settings live, for messages. */
export function installSettingsLocation() {
  const file = installSettingsFilePath();
  return file ?? `the registry (${installSettingsRegistryKey()})`;
}

export function installSettingsRegistryKey() {
  return 'HKCU\\Software\\Suveren\\Gateway';
}

/** Parse `reg query` output down to the three values this module owns. */
export function parseInstallSettingsRegQuery(stdout) {
  const out = {};
  const lineRe = /^ {4}(\S+)\s+(REG_SZ|REG_EXPAND_SZ|REG_DWORD)\s*(.*)$/;
  for (const line of stdout.split(/\r?\n/)) {
    const m = lineRe.exec(line);
    if (!m) continue;
    const [, name, type, rawValue] = m;
    const field = Object.keys(FIELDS).find((k) => FIELDS[k].reg === name);
    if (!field) continue;
    const value = type === 'REG_DWORD' ? String(parseInt(rawValue, 16)) : rawValue.trim();
    // The installer writes an empty value when a field was left blank —
    // that means "not set", not "set to nothing".
    if (value !== '') out[field] = value;
  }
  return out;
}

/**
 * Raw saved values (strings, unvalidated). Throws when the JSON file exists
 * but cannot be parsed — fail closed and audibly, same rule as config.mjs's
 * readConfigStrict: silently falling back to defaults would start a second,
 * empty gateway on the default port next to the one the person configured.
 */
export function readInstallSettings() {
  const file = installSettingsFilePath();
  if (file) {
    if (!existsSync(file)) return {};
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Could not parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const out = {};
    for (const key of Object.keys(FIELDS)) {
      const v = data?.[key];
      if (v !== undefined && v !== null && String(v).trim() !== '') out[key] = String(v);
    }
    return out;
  }
  let result;
  try {
    result = spawnSync('reg', ['query', installSettingsRegistryKey()], { encoding: 'utf8', windowsHide: true });
  } catch {
    return {};
  }
  // Exit 1 = key absent: the normal "nothing saved" case.
  if (!result || result.status !== 0 || !result.stdout) return {};
  return parseInstallSettingsRegQuery(result.stdout);
}

/**
 * Save or clear settings. `patch` maps cpPort/mcpPort/dataDir to a value
 * (saved) or null (cleared — back to the default). Values must already be
 * validated by the caller.
 */
export function writeInstallSettings(patch) {
  const file = installSettingsFilePath();
  if (file) {
    let current = {};
    if (existsSync(file)) {
      try { current = JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch { current = {}; }
    }
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in FIELDS)) continue;
      if (value === null || value === undefined) delete current[key];
      else current[key] = key === 'dataDir' ? String(value) : Number(value);
    }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(current, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    return;
  }
  const key = installSettingsRegistryKey();
  for (const [field, value] of Object.entries(patch)) {
    if (!(field in FIELDS)) continue;
    const name = FIELDS[field].reg;
    const clearing = value === null || value === undefined;
    const args = clearing
      ? ['delete', key, '/v', name, '/f']
      : ['add', key, '/v', name, '/t', 'REG_SZ', '/d', String(value), '/f'];
    const r = spawnSync('reg', args, { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) continue;
    // Clearing a value that was never there fails `reg delete` — that is
    // the result we wanted. (Checked by reading back, not by matching the
    // error text, which Windows localizes.)
    if (clearing && readInstallSettings()[field] === undefined) continue;
    throw new Error(`Could not save ${FIELDS[field].label} to ${key}: ${(r.stderr || r.stdout || '').trim()}`);
  }
}

// ─── Resolution ─────────────────────────────────────────────────────────

/**
 * The effective ports + data folder, with where each one came from.
 *
 * Returns `{ cpPort, mcpPort, dataDir, source: { cpPort, mcpPort, dataDir },
 * errors }`, source being 'policy' | 'env' | 'saved' | 'default'.
 *
 * Strict (the default): throws a named error on any invalid value, or when
 * both ports end up equal — the gateway must not start on a guess.
 * `{ tolerant: true }`: an invalid value falls through to the next tier and
 * is reported in `errors` instead — used ONLY by `config`/`help`, so a bad
 * saved value can still be inspected and fixed with the CLI.
 */
export function resolveInstallSettings({ tolerant = false } = {}) {
  const errors = [];
  const fail = (msg) => {
    if (!tolerant) throw new Error(msg);
    errors.push(msg);
  };

  let policy = {};
  try {
    policy = readPolicy().policy;
  } catch (err) {
    if (!tolerant) throw err;
    errors.push(err instanceof Error ? err.message : String(err));
  }

  let saved = {};
  try {
    saved = readInstallSettings();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const where = installSettingsLocation();

  const out = { source: {}, errors };

  // Ports.
  for (const [field, policyKey, fallback] of [
    ['cpPort', 'port', DEFAULT_CP_PORT],
    ['mcpPort', 'mcpPort', DEFAULT_MCP_PORT],
  ]) {
    const { env, label } = FIELDS[field];
    if (policy[policyKey] !== undefined) {
      out[field] = policy[policyKey];
      out.source[field] = 'policy';
      continue;
    }
    const envValue = process.env[env];
    if (envValue !== undefined && envValue !== '') {
      const v = validateEnvPort(envValue);
      if (v.ok) { out[field] = v.port; out.source[field] = 'env'; continue; }
      fail(`Invalid ${env}: ${v.error}`);
    }
    if (saved[field] !== undefined) {
      const v = validatePort(saved[field]);
      if (v.ok) { out[field] = v.port; out.source[field] = 'saved'; continue; }
      fail(`Invalid saved ${label} "${saved[field]}" in ${where}: ${v.error}`);
    }
    out[field] = fallback;
    out.source[field] = 'default';
  }

  // Data folder.
  if (policy.dataDir !== undefined) {
    out.dataDir = policy.dataDir;
    out.source.dataDir = 'policy';
  } else if (process.env.SUVEREN_DATA_DIR) {
    // Env keeps its long-standing meaning: taken as given (relative to the
    // current folder if relative) — Docker and the dev scripts rely on it.
    out.dataDir = resolve(process.env.SUVEREN_DATA_DIR);
    out.source.dataDir = 'env';
  } else if (saved.dataDir !== undefined) {
    const v = validateDataDir(saved.dataDir);
    if (v.ok) {
      out.dataDir = v.path;
      out.source.dataDir = 'saved';
    } else {
      fail(`Invalid saved data-dir "${saved.dataDir}" in ${where}: ${v.error}`);
    }
  }
  if (!out.dataDir) {
    out.dataDir = defaultDataDir();
    out.source.dataDir = 'default';
  }

  if (out.cpPort === out.mcpPort) {
    fail(
      `The gateway port and the MCP port are both ${out.cpPort} — they must differ ` +
        `(port from ${out.source.cpPort}, mcp-port from ${out.source.mcpPort}).`,
    );
  }

  return out;
}

/** Human wording for a source, used in `config get` and error hints. */
export function describeSource(source, field) {
  if (source === 'policy') return 'set by your IT';
  if (source === 'env') return `from ${FIELDS[field].env}`;
  if (source === 'saved') return 'saved';
  return 'default';
}
