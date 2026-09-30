/**
 * Authority Server URL resolver + validation.
 *
 * Precedence (flag > env > saved config > default) is the whole point of
 * `--as-url` existing at all — a customer's self-hosted AS has to win over
 * whatever suveren.ai default ships. Validation is a security boundary, not
 * a UX nicety: it's what stops a plaintext http:// URL (other than
 * localhost) from ever becoming "the server that issues tickets".
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_AS_URL,
  readAsConfig,
  writeAsConfig,
  validateAsUrl,
  resolveAsUrl,
  resolveCaFile,
} from '../src/lib/as-config';

const tmp = () => mkdtempSync(join(tmpdir(), 'as-config-'));
const dirs: string[] = [];
function dataDir(): string {
  const d = tmp();
  dirs.push(d);
  return d;
}

afterEach(() => {
  delete process.env.SUVEREN_AS_URL;
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('validateAsUrl', () => {
  it('accepts https URLs', () => {
    expect(validateAsUrl('https://as.example.com')).toEqual({ ok: true, url: 'https://as.example.com' });
  });

  it('rejects plain http for a non-local host', () => {
    const v = validateAsUrl('http://as.example.com');
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/https/);
  });

  it('allows http://localhost and http://127.0.0.1 for development', () => {
    expect(validateAsUrl('http://localhost:4100').ok).toBe(true);
    expect(validateAsUrl('http://127.0.0.1:4100').ok).toBe(true);
  });

  it('strips exactly one trailing slash', () => {
    expect(validateAsUrl('https://as.example.com/').url).toBe('https://as.example.com');
    expect(validateAsUrl('https://as.example.com/sub/').url).toBe('https://as.example.com/sub');
  });

  it('rejects garbage input', () => {
    expect(validateAsUrl('not a url').ok).toBe(false);
    expect(validateAsUrl('').ok).toBe(false);
  });
});

describe('resolveAsUrl — precedence', () => {
  it('defaults to suveren.ai when nothing is configured', () => {
    const dir = dataDir();
    expect(resolveAsUrl(dir)).toBe(DEFAULT_AS_URL);
  });

  it('saved config beats the default', () => {
    const dir = dataDir();
    writeAsConfig(dir, { asUrl: 'https://as.company.internal' });
    expect(resolveAsUrl(dir)).toBe('https://as.company.internal');
  });

  it('env beats saved config', () => {
    const dir = dataDir();
    writeAsConfig(dir, { asUrl: 'https://as.company.internal' });
    process.env.SUVEREN_AS_URL = 'https://env-wins.example.com';
    expect(resolveAsUrl(dir)).toBe('https://env-wins.example.com');
  });

  it('an explicit flag beats env and saved config', () => {
    const dir = dataDir();
    writeAsConfig(dir, { asUrl: 'https://as.company.internal' });
    process.env.SUVEREN_AS_URL = 'https://env.example.com';
    expect(resolveAsUrl(dir, 'https://flag-wins.example.com')).toBe('https://flag-wins.example.com');
  });

  it('throws on an invalid env value — fails closed, does not fall back silently', () => {
    const dir = dataDir();
    process.env.SUVEREN_AS_URL = 'http://not-localhost.example.com';
    expect(() => resolveAsUrl(dir)).toThrow(/Invalid SUVEREN_AS_URL/);
  });

  it('throws on an invalid flag value', () => {
    const dir = dataDir();
    expect(() => resolveAsUrl(dir, 'ftp://nope')).toThrow(/Invalid --as-url/);
  });

  it('a corrupt saved config degrades to the default rather than throwing', () => {
    const dir = dataDir();
    writeAsConfig(dir, {});
    // Hand-corrupt: an invalid URL saved directly (bypassing validation),
    // simulating a hand-edited file.
    writeAsConfig(dir, { asUrl: 'not-a-url' });
    expect(resolveAsUrl(dir)).toBe(DEFAULT_AS_URL);
  });
});

describe('readAsConfig / writeAsConfig', () => {
  it('round-trips asUrl and caFile', () => {
    const dir = dataDir();
    writeAsConfig(dir, { asUrl: 'https://a.example.com' });
    writeAsConfig(dir, { caFile: '/etc/ssl/company-ca.pem' });
    expect(readAsConfig(dir)).toEqual({ asUrl: 'https://a.example.com', caFile: '/etc/ssl/company-ca.pem' });
    expect(resolveCaFile(dir)).toBe('/etc/ssl/company-ca.pem');
  });

  it('tolerates a missing file', () => {
    const dir = dataDir();
    expect(readAsConfig(dir)).toEqual({});
    expect(resolveCaFile(dir)).toBeUndefined();
  });
});
