/**
 * Control-plane's copy of the AS URL resolver (mirrors
 * apps/mcp-server/src/lib/as-config.ts, see its test file for the full
 * precedence + validation matrix). This file exists so a divergence between
 * the two copies — which nothing but code review otherwise catches — fails
 * a test instead.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AS_URL, writeAsConfig, validateAsUrl, resolveAsUrl } from '../lib/as-config';

const tmp = () => mkdtempSync(join(tmpdir(), 'as-config-cp-'));
const dirs: string[] = [];

afterEach(() => {
  delete process.env.SUVEREN_AS_URL;
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
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
