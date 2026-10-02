/**
 * Control-plane's copy of the AS URL resolver (mirrors
 * apps/mcp-server/src/lib/as-config.ts, see its test file for the full
 * precedence + validation matrix). This file exists so a divergence between
 * the two copies — which nothing but code review otherwise catches — fails
 * a test instead.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AS_URL, writeAsConfig, validateAsUrl, resolveAsUrl, resolveCaFile, resolvePinTls } from '../lib/as-config';
import { _resetPolicyCacheForTests } from '../lib/policy';

const tmp = () => mkdtempSync(join(tmpdir(), 'as-config-cp-'));
const dirs: string[] = [];

function tmpPolicyFile(contents: unknown): string {
  const dir = tmp(); dirs.push(dir);
  const path = join(dir, 'gateway-policy.json');
  writeFileSync(path, JSON.stringify(contents), 'utf8');
  return path;
}

afterEach(() => {
  delete process.env.SUVEREN_AS_URL;
  delete process.env.SUVEREN_POLICY_FILE;
  _resetPolicyCacheForTests();
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('control-plane as-config — IT policy locking', () => {
  it('REFUSAL: policy AsUrl wins over flag, env, and saved config — locked means locked', () => {
    const dir = tmp(); dirs.push(dir);
    writeAsConfig(dir, { asUrl: 'https://saved.example.com' });
    process.env.SUVEREN_AS_URL = 'https://env.example.com';
    process.env.SUVEREN_POLICY_FILE = tmpPolicyFile({ AsUrl: 'https://policy.example.com' });
    expect(resolveAsUrl(dir, 'https://flag.example.com')).toBe('https://policy.example.com');
  });

  it('policy CaFile wins over the saved value', () => {
    const dir = tmp(); dirs.push(dir);
    const caPath = join(dir, 'ca.pem');
    writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\n...', 'utf8');
    writeAsConfig(dir, { caFile: '/some/other/saved-ca.pem' });
    process.env.SUVEREN_POLICY_FILE = tmpPolicyFile({ CaFile: caPath });
    expect(resolveCaFile(dir)).toBe(caPath);
  });

  it('policy PinTls wins over the saved value', () => {
    const dir = tmp(); dirs.push(dir);
    writeAsConfig(dir, { pinTls: false });
    process.env.SUVEREN_POLICY_FILE = tmpPolicyFile({ PinTls: true });
    expect(resolvePinTls(dir)).toBe(true);
  });

  it('no policy configured — behaves exactly as before (unaffected)', () => {
    const dir = tmp(); dirs.push(dir);
    process.env.SUVEREN_POLICY_FILE = join(dir, 'absent.json');
    writeAsConfig(dir, { asUrl: 'https://saved.example.com' });
    expect(resolveAsUrl(dir)).toBe('https://saved.example.com');
  });
});

describe('control-plane as-config (mirror)', () => {
  it('defaults to suveren.ai', () => {
    const dir = tmp(); dirs.push(dir);
    expect(resolveAsUrl(dir)).toBe(DEFAULT_AS_URL);
  });

  it('precedence: flag > env > saved > default', () => {
    const dir = tmp(); dirs.push(dir);
    writeAsConfig(dir, { asUrl: 'https://saved.example.com' });
    expect(resolveAsUrl(dir)).toBe('https://saved.example.com');

    process.env.SUVEREN_AS_URL = 'https://env.example.com';
    expect(resolveAsUrl(dir)).toBe('https://env.example.com');

    expect(resolveAsUrl(dir, 'https://flag.example.com')).toBe('https://flag.example.com');
  });

  it('rejects non-local http', () => {
    expect(validateAsUrl('http://as.example.com').ok).toBe(false);
  });

  it('accepts http://localhost for development', () => {
    expect(validateAsUrl('http://localhost:4100').ok).toBe(true);
  });
});
