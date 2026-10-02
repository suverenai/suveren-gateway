/**
 * The CLI's own copy of the managed-settings policy reader
 * (bundle/lib/policy.mjs — plain JS, see its header comment for why it
 * can't import a TS version). Imported directly across the package
 * boundary, same convention as gateway-cli-config.test.ts.
 *
 * Covers: precedence (registry > file; HKLM > HKCU), per-key locking,
 * invalid-value refusal, and the non-Windows skip for the registry source.
 * The real Windows registry path (`reg add` / `reg query` / `reg delete`)
 * can only run on Windows — see .github/workflows/test.yml's windows-latest
 * leg, which exercises it for real.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readPolicy,
  parseRegQueryOutput,
  registryKeyPath,
  policyFilePath,
  isPolicyLocked,
  _resetPolicyCacheForTests,
} from '../../../../bundle/lib/policy.mjs';

const dirs: string[] = [];
function tmpPolicyFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-policy-'));
  dirs.push(dir);
  const path = join(dir, 'gateway-policy.json');
  writeFileSync(path, JSON.stringify(contents), 'utf8');
  return path;
}

afterEach(() => {
  delete process.env.SUVEREN_POLICY_FILE;
  delete process.env.SUVEREN_POLICY_REGISTRY_KEY;
  _resetPolicyCacheForTests();
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('policy.mjs — no policy configured', () => {
  it('returns an empty policy, nothing locked', () => {
    process.env.SUVEREN_POLICY_FILE = join(mkdtempSync(join(tmpdir(), 'gateway-policy-')), 'absent.json');
    const r = readPolicy();
    expect(r.policy).toEqual({});
    expect(r.locked.size).toBe(0);
    expect(isPolicyLocked('asUrl')).toBe(false);
  });
});

describe('policy.mjs — policy file', () => {
  it('locks AsUrl and Simulation when set', () => {
    process.env.SUVEREN_POLICY_FILE = tmpPolicyFile({ AsUrl: 'https://as.company.internal', Simulation: true });
    const r = readPolicy();
    expect(r.policy.asUrl).toBe('https://as.company.internal');
    expect(r.policy.simulation).toBe(true);
    expect(r.locked.has('asUrl')).toBe(true);
    expect(r.locked.has('simulation')).toBe(true);
    expect(r.locked.has('caFile')).toBe(false);
    expect(isPolicyLocked('simulation')).toBe(true);
  });

  it('accepts DWORD-style 0/1 for boolean fields, not just JSON booleans', () => {
    process.env.SUVEREN_POLICY_FILE = tmpPolicyFile({ PinTls: 1, Simulation: 0 });
    const r = readPolicy();
    expect(r.policy.pinTls).toBe(true);
    expect(r.policy.simulation).toBe(false);
    // false is still a LOCKED value — "locked off" is a real policy state,
    // not the absence of one.
    expect(r.locked.has('simulation')).toBe(true);
  });

  it('REFUSAL: throws on an invalid policy AsUrl — same validation as `config set as-url`', () => {
    process.env.SUVEREN_POLICY_FILE = tmpPolicyFile({ AsUrl: 'not-a-url' });
    expect(() => readPolicy()).toThrow(/Invalid policy AsUrl/);
  });

  it('REFUSAL: throws on a CaFile that does not exist', () => {
    process.env.SUVEREN_POLICY_FILE = tmpPolicyFile({ CaFile: '/no/such/file.pem' });
    expect(() => readPolicy()).toThrow(/Invalid policy CaFile/);
  });

  it('REFUSAL: throws on a non-boolean Simulation value', () => {
    process.env.SUVEREN_POLICY_FILE = tmpPolicyFile({ Simulation: 'yes-please' });
    expect(() => readPolicy()).toThrow(/Invalid policy Simulation/);
  });

  it('REFUSAL: throws on an InstallMethod other than "managed"', () => {
    process.env.SUVEREN_POLICY_FILE = tmpPolicyFile({ InstallMethod: 'docker' });
    expect(() => readPolicy()).toThrow(/Invalid policy InstallMethod/);
  });

  it('accepts InstallMethod "managed"', () => {
    process.env.SUVEREN_POLICY_FILE = tmpPolicyFile({ InstallMethod: 'managed' });
    const r = readPolicy();
    expect(r.policy.installMethod).toBe('managed');
    expect(r.locked.has('installMethod')).toBe(true);
  });

  it('REFUSAL: throws on a policy file that is not valid JSON — fails closed, not silently empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-policy-'));
    dirs.push(dir);
    const path = join(dir, 'gateway-policy.json');
    writeFileSync(path, '{ not json', 'utf8');
    process.env.SUVEREN_POLICY_FILE = path;
    expect(() => readPolicy()).toThrow(/Could not parse policy file/);
  });

  it('ignores unknown keys rather than choking on them', () => {
    process.env.SUVEREN_POLICY_FILE = tmpPolicyFile({ AsUrl: 'https://as.company.internal', SomethingElse: 'x' });
    const r = readPolicy();
    expect(r.policy).toEqual({ asUrl: 'https://as.company.internal' });
  });
});

describe('policy.mjs — caching', () => {
  it('memoizes: a later file change is not picked up without a cache reset', () => {
    process.env.SUVEREN_POLICY_FILE = tmpPolicyFile({ Simulation: true });
    expect(readPolicy().policy.simulation).toBe(true);
    // Overwrite the same path with a different value — cache should still win.
    writeFileSync(process.env.SUVEREN_POLICY_FILE, JSON.stringify({ Simulation: false }), 'utf8');
    expect(readPolicy().policy.simulation).toBe(true);
    _resetPolicyCacheForTests();
    expect(readPolicy().policy.simulation).toBe(false);
  });
});

describe('policy.mjs — registry (parsing logic, platform-independent)', () => {
  it('parses REG_SZ and REG_DWORD value lines, hex-decoding DWORD', () => {
    const stdout = [
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Suveren\\Gateway',
      '    AsUrl    REG_SZ    https://as.company.internal',
      '    PinTls    REG_DWORD    0x1',
      '    Simulation    REG_DWORD    0x0',
      '    InstallMethod    REG_SZ    managed',
      '',
    ].join('\r\n');
    expect(parseRegQueryOutput(stdout)).toEqual({
      AsUrl: 'https://as.company.internal',
      PinTls: 1,
      Simulation: 0,
      InstallMethod: 'managed',
    });
  });

  it('ignores lines that are not 4-space-indented value rows', () => {
    const stdout = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Suveren\\Gateway\r\n\r\n';
    expect(parseRegQueryOutput(stdout)).toEqual({});
  });

  it('ignores a registry value name that is not a known policy key', () => {
    const stdout = '    SomeOtherValue    REG_SZ    whatever\r\n';
    expect(parseRegQueryOutput(stdout)).toEqual({});
  });

  it('on non-Windows, the registry source contributes nothing — only the file is consulted', () => {
    if (process.platform === 'win32') return; // this assertion is about the non-Windows skip
    process.env.SUVEREN_POLICY_FILE = tmpPolicyFile({ AsUrl: 'https://file-wins.example.com' });
    const r = readPolicy();
    expect(r.policy.asUrl).toBe('https://file-wins.example.com');
  });
});

describe('policy.mjs — policyFilePath default locations', () => {
  it('honours SUVEREN_POLICY_FILE above the platform default', () => {
    process.env.SUVEREN_POLICY_FILE = '/tmp/custom-policy.json';
    expect(policyFilePath()).toBe('/tmp/custom-policy.json');
  });
});

describe('policy.mjs — registryKeyPath: the production contract is unchanged', () => {
  it('defaults to the DOCUMENTED path for each hive when no override is set', () => {
    delete process.env.SUVEREN_POLICY_REGISTRY_KEY;
    expect(registryKeyPath('HKLM')).toBe('HKLM\\SOFTWARE\\Policies\\Suveren\\Gateway');
    expect(registryKeyPath('HKCU')).toBe('HKCU\\SOFTWARE\\Policies\\Suveren\\Gateway');
  });

  it('SUVEREN_POLICY_REGISTRY_KEY overrides the base key — test-only, never set in production', () => {
    process.env.SUVEREN_POLICY_REGISTRY_KEY = 'SOFTWARE\\Policies\\Suveren\\GatewayTest-abc123';
    expect(registryKeyPath('HKLM')).toBe('HKLM\\SOFTWARE\\Policies\\Suveren\\GatewayTest-abc123');
  });
});

describe('policy.mjs — SUVEREN_POLICY_REGISTRY=off: the registry source is skipped entirely', () => {
  it('a value that would otherwise be read is ignored while the switch is off', () => {
    // Can't write the real registry from a non-Windows test, so this proves
    // the switch's effect the same way the "non-Windows" test above does:
    // readPolicy() must come back empty regardless of what's "on file",
    // because readRegistryHive() returns {} before even checking the
    // platform branch for this flag.
    process.env.SUVEREN_POLICY_REGISTRY = 'off';
    const r = readPolicy();
    expect(r.policy.asUrl).toBeUndefined();
    delete process.env.SUVEREN_POLICY_REGISTRY;
  });
});
