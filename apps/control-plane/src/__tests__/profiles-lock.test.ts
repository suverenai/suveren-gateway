/**
 * The profile pin (DEC-77). `profiles.lock` names one hap-profiles commit and
 * the sha256 of every file; bundle/build.mjs checks the profiles it is about to
 * ship against it and fails the build on any difference. The checks run on a
 * temporary copy; the last test runs the REAL bundle/build.mjs against a
 * tampered copy and expects it to refuse before anything is built.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildLock, readLock, verifyProfilesAgainstLock, lockedFiles } from '../../../../bundle/lib/profiles-lock.mjs';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const COMMIT = 'a'.repeat(40);

/** A small hap-profiles stand-in: index.json + two profile files. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'profiles-lock-')); dirs.push(dir);
  const files: Record<string, string> = {
    'index.json': JSON.stringify({ repository: 'x', profiles: { 'h/p/email@0.1': 'email/0.1.profile.json', 'h/p/email@0.2': 'email/0.2.profile.json' } }),
    'email/0.1.profile.json': JSON.stringify({ id: 'h/p/email@0.1' }),
    'email/0.2.profile.json': JSON.stringify({ id: 'h/p/email@0.2' }),
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}
const lockFor = (dir: string) => buildLock({ repository: 'github.com/x/hap-profiles', commit: COMMIT, dir, files: ['index.json', 'email/0.1.profile.json', 'email/0.2.profile.json'] });

describe('verifyProfilesAgainstLock', () => {
  it('accepts exactly the locked bytes', () => {
    const dir = fixture();
    expect(verifyProfilesAgainstLock(dir, lockFor(dir))).toEqual([]);
  });

  it('names a tampered file', () => {
    const dir = fixture();
    const lock = lockFor(dir);
    writeFileSync(join(dir, 'email/0.2.profile.json'), JSON.stringify({ id: 'h/p/email@0.2', extra: 'changed' }));
    const problems = verifyProfilesAgainstLock(dir, lock);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^email\/0\.2\.profile\.json: sha256 is [0-9a-f]{64}, the lock says [0-9a-f]{64}$/);
  });

  it('names a missing file', () => {
    const dir = fixture();
    const lock = lockFor(dir);
    rmSync(join(dir, 'email/0.1.profile.json'));
    expect(verifyProfilesAgainstLock(dir, lock)).toEqual(['email/0.1.profile.json: missing']);
  });

  it('refuses an index that names a profile the lock does not pin', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'email/0.3.profile.json'), '{}');
    const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    idx.profiles['h/p/email@0.3'] = 'email/0.3.profile.json';
    writeFileSync(join(dir, 'index.json'), JSON.stringify(idx));
    // An index.json edited to add a file is caught by index.json's own hash first.
    expect(verifyProfilesAgainstLock(dir, lockFor(fixture())).some((p) => p.startsWith('index.json: sha256'))).toBe(true);
    // And a lock that pinned that index but not the file it names is caught too.
    const lock = buildLock({ repository: 'x/y', commit: COMMIT, dir, files: ['index.json', 'email/0.1.profile.json', 'email/0.2.profile.json'] });
    expect(verifyProfilesAgainstLock(dir, lock)).toEqual(['email/0.3.profile.json: named in index.json but not in the lock']);
  });

  it('ships only locked files: an extra file in the folder is not in the list', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'email/0.9.profile.json'), '{"id":"smuggled"}');
    expect(lockedFiles(lockFor(dir))).not.toContain('email/0.9.profile.json');
  });
});

describe('readLock', () => {
  const write = (obj: unknown) => { const d = mkdtempSync(join(tmpdir(), 'lockfile-')); dirs.push(d); const p = join(d, 'profiles.lock'); writeFileSync(p, JSON.stringify(obj)); return p; };
  const good = { repository: 'github.com/x/y', commit: COMMIT, files: { 'index.json': 'b'.repeat(64) } };

  it('reads a valid lock', () => { expect(readLock(write(good)).commit).toBe(COMMIT); });
  it('refuses a short commit', () => { expect(() => readLock(write({ ...good, commit: 'main' }))).toThrow(/40-character/); });
  it('refuses a path that leaves the folder', () => { expect(() => readLock(write({ ...good, files: { ...good.files, '../x': 'b'.repeat(64) } }))).toThrow(/unsafe path/); });
  it('refuses a bad hash', () => { expect(() => readLock(write({ ...good, files: { 'index.json': 'zz' } }))).toThrow(/no valid sha256/); });
  it('refuses a lock without index.json', () => { expect(() => readLock(write({ ...good, files: { 'a.json': 'b'.repeat(64) } }))).toThrow(/index\.json/); });
});

describe('the checked-in profiles.lock', () => {
  it('is well formed and pins index.json', () => {
    const lock = readLock(join(ROOT, 'profiles.lock'));
    expect(Object.keys(lock.files).length).toBeGreaterThan(10);
  });
});

describe('the profiles the suites run against', () => {
  // In CI test.yml checks out exactly the pinned commit, so the suites test what ships. On a
  // developer machine the sibling checkout may legitimately be ahead of the lock: not checked there.
  it.skipIf(!process.env.CI)('are the pinned ones (CI only)', () => {
    const dir = process.env.SUVEREN_PROFILES_DIR ?? join(ROOT, '..', 'hap-profiles');
    expect(verifyProfilesAgainstLock(dir, readLock(join(ROOT, 'profiles.lock')))).toEqual([]);
  });
});

describe('bundle/build.mjs', () => {
  it('refuses profiles that differ from profiles.lock, before building anything', () => {
    // Every locked file present, none with the locked bytes (independent of any local hap-profiles checkout).
    const real = readLock(join(ROOT, 'profiles.lock'));
    const dir = mkdtempSync(join(tmpdir(), 'tampered-profiles-')); dirs.push(dir);
    for (const rel of Object.keys(real.files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), rel === 'index.json' ? '{"profiles":{}}' : '{"tampered":true}');
    }
    const victim = Object.keys(real.files).find((r) => r.endsWith('.profile.json'))!;
    const run = spawnSync(process.execPath, [join(ROOT, 'bundle', 'build.mjs')], { env: { ...process.env, HAP_PROFILES_SRC: dir }, encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/not the ones profiles\.lock pins/);
    expect(run.stderr).toContain(`${victim}: sha256 is`);
    // Refused at the pin, not at a later missing-build step.
    expect(run.stderr).not.toMatch(/missing .* build at/);
  }, 60_000);
});
