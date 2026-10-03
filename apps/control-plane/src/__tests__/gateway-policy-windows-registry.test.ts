/**
 * The REAL Windows registry path — `reg add` → readPolicy() → `reg delete`.
 *
 * Everything else in gateway-policy.test.ts exercises `parseRegQueryOutput`
 * against captured fixture text, which proves the parser but nothing about
 * whether `reg query`'s actual output on a real Windows machine matches that
 * fixture, or whether `spawnSync('reg', …)` even works the way this module
 * assumes (quoting, exit codes, locale). Only a real `reg.exe` invocation on
 * a real Windows runner can catch that — see doc/engineering.md rule 7 ("CI
 * runs where users run"): a parser with no OS underneath it guards nothing.
 *
 * Writes to HKCU (no admin rights needed), always cleans up via `reg
 * delete`, and skips entirely on non-Windows — this is the one test in the
 * repo that cannot run on a developer's Mac, by design; .github/workflows/
 * bundle-smoke.yml's `unit` job runs `pnpm -r test` on windows-latest, which
 * is where this actually executes.
 *
 * Two isolation concerns this file owns, both learned from a real CI
 * failure (`pnpm -r test` runs every workspace package in parallel):
 *
 *   1. `vitest.setup.ts` sets `SUVEREN_POLICY_REGISTRY=off` globally so every
 *      OTHER test is hermetic against the real registry. This file is the
 *      one place that explicitly opts back IN (`SUVEREN_POLICY_REGISTRY`
 *      set to anything other than 'off').
 *   2. Every test here points `SUVEREN_POLICY_REGISTRY_KEY` at a UNIQUE
 *      per-test key, not the real documented one — an mcp-server test
 *      running at the same time (different process, same machine) was
 *      seeing this file's real HKCU writes mid-run, because both were
 *      reading/writing the one real key.
 *
 * `gateway-policy.test.ts` separately asserts that the DEFAULT key (no
 * override) is the documented production path — this file never exercises
 * that default, on purpose.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readPolicy, registryKeyPath, _resetPolicyCacheForTests } from '../lib/policy';

/** A fresh, never-before-used base key per test — set as
 *  SUVEREN_POLICY_REGISTRY_KEY so registryKeyPath()/readPolicy() use it
 *  instead of the real documented one. */
let baseKey: string;

function regAdd(name: string, type: 'REG_SZ' | 'REG_DWORD', value: string): void {
  const path = registryKeyPath('HKCU');
  const res = spawnSync('reg', ['add', path, '/v', name, '/t', type, '/d', value, '/f'], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`reg add ${name} failed (status ${res.status}): ${res.stderr || res.stdout}`);
  }
}

function regDeleteKey(): void {
  // /f suppresses the confirmation prompt; a missing key exits non-zero,
  // which is fine — there is nothing left to clean up either way.
  spawnSync('reg', ['delete', registryKeyPath('HKCU'), '/f'], { encoding: 'utf8' });
}

describe.skipIf(process.platform !== 'win32')('policy.ts — real Windows registry (HKCU)', () => {
  beforeEach(() => {
    baseKey = `SOFTWARE\\Policies\\Suveren\\GatewayTest-${randomUUID()}`;
    process.env.SUVEREN_POLICY_REGISTRY_KEY = baseKey;
    // Override vitest.setup.ts's global 'off' — this is the one file that
    // needs the real `reg` binary invoked, just never against the real key.
    process.env.SUVEREN_POLICY_REGISTRY = 'on';
    delete process.env.SUVEREN_POLICY_FILE;
    _resetPolicyCacheForTests();
  });

  afterEach(() => {
    regDeleteKey();
    delete process.env.SUVEREN_POLICY_FILE;
    delete process.env.SUVEREN_POLICY_REGISTRY_KEY;
    delete process.env.SUVEREN_POLICY_REGISTRY;
    _resetPolicyCacheForTests();
  });

  it('reads AsUrl (REG_SZ) and Simulation (REG_DWORD) written by `reg add`, end to end', () => {
    regAdd('AsUrl', 'REG_SZ', 'https://as.company.internal');
    regAdd('Simulation', 'REG_DWORD', '1');
    _resetPolicyCacheForTests();

    const r = readPolicy();
    expect(r.policy.asUrl).toBe('https://as.company.internal');
    expect(r.policy.simulation).toBe(true);
    expect(r.locked.has('asUrl')).toBe(true);
    expect(r.locked.has('simulation')).toBe(true);
  });

  it('REFUSAL: an invalid real registry AsUrl throws — not just the fixture-based parser test', () => {
    regAdd('AsUrl', 'REG_SZ', 'not-a-url');
    _resetPolicyCacheForTests();
    expect(() => readPolicy()).toThrow(/Invalid policy AsUrl/);
  });

  it('`reg delete` removes the key — readPolicy reverts to unlocked on the next read', () => {
    regAdd('Simulation', 'REG_DWORD', '1');
    _resetPolicyCacheForTests();
    expect(readPolicy().policy.simulation).toBe(true);

    regDeleteKey();
    _resetPolicyCacheForTests();
    expect(readPolicy().policy.simulation).toBeUndefined();
    expect(readPolicy().locked.size).toBe(0);
  });
});
