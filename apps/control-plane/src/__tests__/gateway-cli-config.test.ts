/**
 * The CLI's own copy of the AS-URL resolver (bundle/lib/config.mjs — plain
 * JS, see its header comment for why it can't import the TS version).
 * Imported directly across the package boundary, same convention as
 * autostart-templates.test.ts, which tests the CLI's autostart string
 * builders the same way.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_AS_URL,
  readConfig,
  writeConfig,
  validateAsUrl,
  validateCaFile,
  validateProxyUrl,
  resolveAsUrl,
  resolveCaFile,
  resolveProxyUrl,
  resolveSimulation,
} from '../../../../bundle/lib/config.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'cli-config-'));
const dirs: string[] = [];

afterEach(() => {
  delete process.env.SUVEREN_AS_URL;
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('bundle/lib/config.mjs — validateAsUrl', () => {
  it('accepts https, rejects non-local http, allows localhost/127.0.0.1 http', () => {
    expect(validateAsUrl('https://as.example.com').ok).toBe(true);
    expect(validateAsUrl('http://as.example.com').ok).toBe(false);
    expect(validateAsUrl('http://localhost:4100').ok).toBe(true);
    expect(validateAsUrl('http://127.0.0.1:4100').ok).toBe(true);
  });

  it('strips a trailing slash', () => {
    expect(validateAsUrl('https://as.example.com/').url).toBe('https://as.example.com');
  });

  it('rejects garbage', () => {
    expect(validateAsUrl('nope').ok).toBe(false);
    expect(validateAsUrl('').ok).toBe(false);
  });
});

describe('bundle/lib/config.mjs — validateCaFile', () => {
  it('rejects a path that does not exist', () => {
    expect(validateCaFile('/no/such/file.pem').ok).toBe(false);
  });

  it('accepts an existing file', () => {
    const dir = tmp(); dirs.push(dir);
    const path = join(dir, 'ca.pem');
    writeConfig(dir, {}); // just to create the dir via the same helper
    writeFileSync(path, '-----BEGIN CERTIFICATE-----\n...');
    expect(validateCaFile(path)).toEqual({ ok: true, path });
  });
});

describe('bundle/lib/config.mjs — resolveAsUrl / resolveCaFile precedence', () => {
  it('default, then saved, then env', () => {
    const dir = tmp(); dirs.push(dir);
    expect(resolveAsUrl(dir)).toBe(DEFAULT_AS_URL);

    writeConfig(dir, { asUrl: 'https://saved.example.com' });
    expect(resolveAsUrl(dir)).toBe('https://saved.example.com');

    process.env.SUVEREN_AS_URL = 'https://env.example.com';
    expect(resolveAsUrl(dir)).toBe('https://env.example.com');
  });

  it('throws on an invalid env value', () => {
    const dir = tmp(); dirs.push(dir);
    process.env.SUVEREN_AS_URL = 'ftp://nope';
    expect(() => resolveAsUrl(dir)).toThrow(/Invalid SUVEREN_AS_URL/);
  });

  it('REFUSAL: throws on an invalid saved as-url — never falls back to the public default', () => {
    const dir = tmp(); dirs.push(dir);
    writeConfig(dir, { asUrl: 'not-a-url' });
    expect(() => resolveAsUrl(dir)).toThrow(/Invalid saved as-url/);
  });

  it('REFUSAL: throws on a config.json that is not valid JSON', () => {
    const dir = tmp(); dirs.push(dir);
    writeConfig(dir, {}); // create the dir
    writeFileSync(join(dir, 'config.json'), '{ not json', 'utf-8');
    expect(() => resolveAsUrl(dir)).toThrow(/Could not parse/);
  });

  it('round-trips a saved ca-file', () => {
    const dir = tmp(); dirs.push(dir);
    writeConfig(dir, { caFile: '/etc/ssl/company-ca.pem' });
    expect(resolveCaFile(dir)).toBe('/etc/ssl/company-ca.pem');
    expect(readConfig(dir)).toEqual({ caFile: '/etc/ssl/company-ca.pem' });
  });
});

describe('bundle/lib/config.mjs — validateProxyUrl / resolveProxyUrl', () => {
  it('accepts http:// and https://, rejects other schemes and garbage', () => {
    expect(validateProxyUrl('http://proxy.corp.example:8080').ok).toBe(true);
    expect(validateProxyUrl('https://proxy.corp.example:8443').ok).toBe(true);
    expect(validateProxyUrl('socks5://proxy.corp.example:1080').ok).toBe(false);
    expect(validateProxyUrl('not-a-url').ok).toBe(false);
    expect(validateProxyUrl('').ok).toBe(false);
  });

  it('accepts a proxy URL carrying basic-auth credentials', () => {
    expect(validateProxyUrl('http://user:pass@proxy.corp.example:8080').ok).toBe(true);
  });

  it('round-trips a saved proxy URL', () => {
    const dir = tmp(); dirs.push(dir);
    expect(resolveProxyUrl(dir)).toBeUndefined();
    writeConfig(dir, { proxyUrl: 'http://proxy.corp.example:8080' });
    expect(resolveProxyUrl(dir)).toBe('http://proxy.corp.example:8080');
    expect(readConfig(dir)).toEqual({ proxyUrl: 'http://proxy.corp.example:8080' });
  });
});

describe('bundle/lib/config.mjs — resolveSimulation', () => {
  it('defaults to false — a normal install is unaffected', () => {
    const dir = tmp(); dirs.push(dir);
    expect(resolveSimulation(dir)).toBe(false);
  });

  it('round-trips true and false', () => {
    const dir = tmp(); dirs.push(dir);
    writeConfig(dir, { simulation: true });
    expect(resolveSimulation(dir)).toBe(true);
    writeConfig(dir, { simulation: false });
    expect(resolveSimulation(dir)).toBe(false);
  });

  it('a corrupt config.json degrades to false rather than throwing (readConfig, not readConfigStrict)', () => {
    const dir = tmp(); dirs.push(dir);
    writeConfig(dir, {});
    writeFileSync(join(dir, 'config.json'), '{ not json', 'utf-8');
    expect(resolveSimulation(dir)).toBe(false);
  });
});
