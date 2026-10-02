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
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readPolicy, _resetPolicyCacheForTests } from '../lib/policy';

const REG_PATH = 'HKCU\\SOFTWARE\\Policies\\Suveren\\Gateway';

function regAdd(name: string, type: 'REG_SZ' | 'REG_DWORD', value: string): void {
  const res = spawnSync('reg', ['add', REG_PATH, '/v', name, '/t', type, '/d', value, '/f'], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`reg add ${name} failed (status ${res.status}): ${res.stderr || res.stdout}`);
  }
}

function regDeleteKey(): void {
  // /f suppresses the confirmation prompt; a missing key exits non-zero,
  // which is fine — there is nothing left to clean up either way.
  spawnSync('reg', ['delete', REG_PATH, '/f'], { encoding: 'utf8' });
}

describe.skipIf(process.platform !== 'win32')('policy.ts — real Windows registry (HKCU)', () => {
  afterEach(() => {
    regDeleteKey();
    delete process.env.SUVEREN_POLICY_FILE;
    _resetPolicyCacheForTests();
  });

  it('reads AsUrl (REG_SZ) and Simulation (REG_DWORD) written by `reg add`, end to end', () => {
    // No file source in play — isolates this to the registry path alone.
    delete process.env.SUVEREN_POLICY_FILE;
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
    delete process.env.SUVEREN_POLICY_FILE;
    regAdd('AsUrl', 'REG_SZ', 'not-a-url');
    _resetPolicyCacheForTests();
    expect(() => readPolicy()).toThrow(/Invalid policy AsUrl/);
  });

  it('`reg delete` removes the key — readPolicy reverts to unlocked on the next read', () => {
    delete process.env.SUVEREN_POLICY_FILE;
    regAdd('Simulation', 'REG_DWORD', '1');
    _resetPolicyCacheForTests();
    expect(readPolicy().policy.simulation).toBe(true);

    regDeleteKey();
    _resetPolicyCacheForTests();
    expect(readPolicy().policy.simulation).toBeUndefined();
    expect(readPolicy().locked.size).toBe(0);
  });
});
