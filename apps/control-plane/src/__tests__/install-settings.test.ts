/**
 * Saved ports + data folder (bundle/lib/install-settings.mjs) — the resolver
 * the CLI and bundle/server.js share. Imported across the package boundary,
 * same convention as gateway-cli-config.test.ts.
 *
 * File mode only (SUVEREN_INSTALL_SETTINGS_FILE): the registry path is
 * exercised for real by the Windows installer test in publish-windows.yml.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validatePort,
  validateDataDir,
  readInstallSettings,
  writeInstallSettings,
  resolveInstallSettings,
  parseInstallSettingsRegQuery,
} from '../../../../bundle/lib/install-settings.mjs';
import { _resetPolicyCacheForTests } from '../../../../bundle/lib/policy.mjs';

const ENV_KEYS = ['SUVEREN_CP_PORT', 'SUVEREN_MCP_PORT', 'SUVEREN_DATA_DIR', 'SUVEREN_POLICY_FILE', 'SUVEREN_INSTALL_SETTINGS_FILE'];
let saved: Record<string, string | undefined> = {};
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'install-settings-'));
  dirs.push(d);
  return d;
};

let settingsFile = '';

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  settingsFile = join(tmp(), 'gateway.json');
  process.env.SUVEREN_INSTALL_SETTINGS_FILE = settingsFile;
  // No policy unless a test writes one.
  process.env.SUVEREN_POLICY_FILE = join(tmp(), 'no-policy.json');
  _resetPolicyCacheForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetPolicyCacheForTests();
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function policy(contents: unknown) {
  const path = join(tmp(), 'gateway-policy.json');
  writeFileSync(path, JSON.stringify(contents), 'utf8');
  process.env.SUVEREN_POLICY_FILE = path;
  _resetPolicyCacheForTests();
}

describe('validatePort / validateDataDir', () => {
  it('accepts 1024–65535, refuses the rest and non-numbers', () => {
    expect(validatePort('3500')).toEqual({ ok: true, port: 3500 });
    expect(validatePort(1024)).toEqual({ ok: true, port: 1024 });
    expect(validatePort('65535').ok).toBe(true);
    for (const bad of ['80', '1023', '65536', 'abc', '', '35.5', '-3500']) {
      expect(validatePort(bad).ok, bad).toBe(false);
    }
  });

  it('a data folder must be a full path and not a file', () => {
    const dir = tmp();
    expect(validateDataDir(dir)).toEqual({ ok: true, path: dir });
    expect(validateDataDir(join(dir, 'not-yet-there')).ok).toBe(true);
    expect(validateDataDir('relative/data').ok).toBe(false);
    expect(validateDataDir('').ok).toBe(false);
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');
    expect(validateDataDir(file).ok).toBe(false);
  });
});

describe('resolveInstallSettings — precedence', () => {
  it('nothing saved → defaults', () => {
    const r = resolveInstallSettings();
    expect(r.cpPort).toBe(3400);
    expect(r.mcpPort).toBe(3430);
    expect(r.dataDir).toBe(join(homedir(), '.suveren'));
    expect(r.source).toEqual({ cpPort: 'default', mcpPort: 'default', dataDir: 'default' });
  });

  it('saved values are used', () => {
    const dataDir = tmp();
    writeInstallSettings({ cpPort: 3500, mcpPort: 3530, dataDir });
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({ cpPort: 3500, mcpPort: 3530, dataDir });
    const r = resolveInstallSettings();
    expect([r.cpPort, r.mcpPort, r.dataDir]).toEqual([3500, 3530, dataDir]);
    expect(r.source).toEqual({ cpPort: 'saved', mcpPort: 'saved', dataDir: 'saved' });
  });

  it('env wins over saved', () => {
    writeInstallSettings({ cpPort: 3500 });
    process.env.SUVEREN_CP_PORT = '3600';
    const r = resolveInstallSettings();
    expect(r.cpPort).toBe(3600);
    expect(r.source.cpPort).toBe('env');
  });

  it('IT policy wins over env and saved', () => {
    const policyDir = tmp();
    writeInstallSettings({ cpPort: 3500, dataDir: tmp() });
    process.env.SUVEREN_CP_PORT = '3600';
    process.env.SUVEREN_DATA_DIR = tmp();
    policy({ Port: 3700, McpPort: '3730', DataDir: policyDir });
    const r = resolveInstallSettings();
    expect([r.cpPort, r.mcpPort, r.dataDir]).toEqual([3700, 3730, policyDir]);
    expect(r.source).toEqual({ cpPort: 'policy', mcpPort: 'policy', dataDir: 'policy' });
  });

  it('clearing a saved value goes back to the default', () => {
    writeInstallSettings({ cpPort: 3500, mcpPort: 3530 });
    writeInstallSettings({ cpPort: null });
    expect(readInstallSettings()).toEqual({ mcpPort: '3530' });
    expect(resolveInstallSettings().cpPort).toBe(3400);
  });
});

describe('REFUSAL: invalid values never start on a guess', () => {
  it('an invalid saved port throws, naming the value and where it is', () => {
    writeFileSync(settingsFile, JSON.stringify({ cpPort: 80 }));
    expect(() => resolveInstallSettings()).toThrow(/Invalid saved port "80".*1024–65535/);
  });

  it('a relative saved data folder throws', () => {
    writeFileSync(settingsFile, JSON.stringify({ dataDir: 'data' }));
    expect(() => resolveInstallSettings()).toThrow(/Invalid saved data-dir/);
  });

  it('an unparsable settings file throws (does not silently fall back to defaults)', () => {
    writeFileSync(settingsFile, '{ not json');
    expect(() => resolveInstallSettings()).toThrow(/Could not parse/);
  });

  it('equal ports throw — also when one is the OTHER one\'s default', () => {
    writeInstallSettings({ cpPort: 3430 });
    expect(() => resolveInstallSettings()).toThrow(/must differ/);
  });

  it('an invalid policy port throws, naming the policy source', () => {
    policy({ Port: 80 });
    expect(() => resolveInstallSettings()).toThrow(/Invalid policy Port \("80"\)/);
  });

  it('a non-numeric env port throws', () => {
    process.env.SUVEREN_MCP_PORT = 'abc';
    expect(() => resolveInstallSettings()).toThrow(/Invalid SUVEREN_MCP_PORT/);
  });

  it('tolerant mode (config/help only) reports instead of throwing, and falls back', () => {
    writeFileSync(settingsFile, JSON.stringify({ cpPort: 80, mcpPort: 3530 }));
    const r = resolveInstallSettings({ tolerant: true });
    expect(r.cpPort).toBe(3400);
    expect(r.mcpPort).toBe(3530);
    expect(r.errors.join('\n')).toMatch(/Invalid saved port "80"/);
  });
});

describe('parseInstallSettingsRegQuery', () => {
  it('reads Port / McpPort / DataDir, ignores other values and empty ones', () => {
    const out = [
      '',
      'HKEY_CURRENT_USER\\Software\\Suveren\\Gateway',
      '    Installed    REG_DWORD    0x1',
      '    Port    REG_SZ    3500',
      '    McpPort    REG_SZ    ',
      '    DataDir    REG_SZ    D:\\Suveren Data',
      '',
    ].join('\r\n');
    expect(parseInstallSettingsRegQuery(out)).toEqual({ cpPort: '3500', dataDir: 'D:\\Suveren Data' });
  });
});
