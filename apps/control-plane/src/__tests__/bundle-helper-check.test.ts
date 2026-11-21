/**
 * `node bundle/build.mjs --with-helper` refuses a DEBUG helper (software keys, serves any caller) and a helper
 * whose files do not match its hash list, before it cleans or builds anything (step 5a, item 8 of the review).
 * The synthetic cases always run; the cases with the real binaries run where the helper was built
 * (packages/unlock-helper/macos: `swift build` for the debug one, `./build-app.sh` for packages/unlock-helper/macos/dist).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHelperBuild, checkWindowsHelperBuild, debugMarkersIn } from '../../../../bundle/lib/helper-check.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const RELEASE_DIR = join(ROOT, 'packages/unlock-helper/macos/dist');
const DEBUG_EXE = join(ROOT, 'packages/unlock-helper/macos/.build/debug/suveren-unlock-helper');
const EXE_REL = 'Contents/MacOS/suveren-unlock-helper';
const haveRelease = existsSync(join(RELEASE_DIR, 'Suveren.app')) && existsSync(join(RELEASE_DIR, 'helper-manifest.json'));
const haveDebug = existsSync(DEBUG_EXE);

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
/** A folder like build-app.sh makes, with `exe` as the executable and a hash list that matches it. */
function fakeBuild(exeBytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'helper-build-'));
  const app = join(dir, 'Suveren.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(app, EXE_REL), exeBytes);
  writeFileSync(join(app, 'Contents', 'Info.plist'), '<plist/>');
  writeFileSync(join(dir, 'helper-manifest.json'), JSON.stringify({ v: 1, files: { [EXE_REL]: sha(join(app, EXE_REL)), 'Contents/Info.plist': sha(join(app, 'Contents/Info.plist')) } }));
  return dir;
}
const buildJs = (dir: string) => spawnSync(process.execPath, [join(ROOT, 'bundle/build.mjs'), '--with-helper'], { env: { ...process.env, SUVEREN_HELPER_BUILD_DIR: dir }, encoding: 'utf8' });

describe('a debug helper never goes into the package', () => {
  it('finds each debug marker in bytes, and none in a release-like binary', () => {
    expect(debugMarkersIn(Buffer.from('xx software-test yy'))).toEqual(['software-test']);
    expect(debugMarkersIn(Buffer.from('--allow-any-caller'))).toEqual(['--allow-any-caller']);
    expect(debugMarkersIn(Buffer.from('--allowed-callers'))).toEqual(['--allowed-callers']);
    expect(debugMarkersIn(Buffer.from('--backend'))).toEqual(['--backend']);
    expect(debugMarkersIn(Buffer.from('suveren-unlock-helper serve allowed-callers.json'))).toEqual([]);
  });

  it('refuses a build whose executable has a marker, and a file that does not match the hash list; accepts a clean one', () => {
    expect(checkHelperBuild(fakeBuild(Buffer.from('clean release binary')))).toEqual([]);
    const dbg = checkHelperBuild(fakeBuild(Buffer.from('...serve --backend software --allow-any-caller...')));
    expect(dbg.join('\n')).toMatch(/DEBUG helper/);
    const dir = fakeBuild(Buffer.from('clean release binary'));
    writeFileSync(join(dir, 'Suveren.app', 'Contents', 'Info.plist'), '<plist>changed</plist>');
    expect(checkHelperBuild(dir).join('\n')).toMatch(/does not match helper-manifest\.json/);
    expect(checkHelperBuild(mkdtempSync(join(tmpdir(), 'helper-empty-'))).join('\n')).toMatch(/is missing/);
  });

  it('build.mjs --with-helper exits 1 for a debug helper, before it cleans or builds anything', () => {
    const r = buildJs(fakeBuild(Buffer.from('serve --backend software software-test')));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/DEBUG helper/);
    expect(r.stdout).not.toMatch(/assembling/);
  });

  it.skipIf(!haveRelease)('the real release build from build-app.sh passes the check and has no marker', () => {
    expect(checkHelperBuild(RELEASE_DIR)).toEqual([]);
    expect(debugMarkersIn(readFileSync(join(RELEASE_DIR, 'Suveren.app', EXE_REL)))).toEqual([]);
  });

  it.skipIf(!haveDebug)('the real DEBUG binary is found out, alone and swapped into an otherwise clean bundle, and build.mjs refuses it', () => {
    expect(debugMarkersIn(readFileSync(DEBUG_EXE)).length).toBeGreaterThan(0);
    const dir = fakeBuild(readFileSync(DEBUG_EXE));          // a debug build with a hash list that matches it
    expect(checkHelperBuild(dir).join('\n')).toMatch(/DEBUG helper/);
    const r = buildJs(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/DEBUG helper/);
    if (haveRelease) {                                        // and a release bundle with the debug binary swapped in fails on both counts
      const swapped = mkdtempSync(join(tmpdir(), 'helper-swap-'));
      cpSync(RELEASE_DIR, swapped, { recursive: true });
      cpSync(DEBUG_EXE, join(swapped, 'Suveren.app', EXE_REL));
      const problems = checkHelperBuild(swapped).join('\n');
      expect(problems).toMatch(/DEBUG helper/);
      expect(problems).toMatch(/does not match/);
    }
  });
});

// The Windows helper (packages/unlock-helper/windows/build.mjs). SUVEREN_WINDOWS_HELPER_RELEASE / _DEBUG name real
// builds (the Windows CI job sets them); without them only the synthetic cases run.
describe('a debug Windows helper never goes into the package', () => {
  const winBuild = (exeBytes: Buffer): string => {
    const dir = mkdtempSync(join(tmpdir(), 'win-helper-build-'));
    for (const arch of ['x64', 'arm64']) {
      mkdirSync(join(dir, `windows-${arch}`));
      writeFileSync(join(dir, `windows-${arch}`, 'suveren-unlock-helper.exe'), exeBytes);
      writeFileSync(join(dir, `helper-manifest-windows-${arch}.json`), JSON.stringify({ v: 1, files: { 'suveren-unlock-helper.exe': createHash('sha256').update(exeBytes).digest('hex') } }));
    }
    return dir;
  };
  const winBuildJs = (dir: string) => spawnSync(process.execPath, [join(ROOT, 'bundle/build.mjs'), '--with-windows-helper'], { env: { ...process.env, SUVEREN_WINDOWS_HELPER_BUILD_DIR: dir }, encoding: 'utf8' });

  it('accepts a clean build, refuses a marker, a changed .exe and a missing architecture', () => {
    expect(checkWindowsHelperBuild(winBuild(Buffer.from('clean release exe')))).toEqual([]);
    expect(checkWindowsHelperBuild(winBuild(Buffer.from('serve --allow-any-caller software-test'))).join('\n')).toMatch(/DEBUG helper/);
    const dir = winBuild(Buffer.from('clean release exe'));
    writeFileSync(join(dir, 'windows-arm64', 'suveren-unlock-helper.exe'), 'other');
    expect(checkWindowsHelperBuild(dir).join('\n')).toMatch(/does not match/);
    const one = winBuild(Buffer.from('clean release exe'));
    rmSync(join(one, 'windows-x64'), { recursive: true });
    expect(checkWindowsHelperBuild(one).join('\n')).toMatch(/is missing/);
  });

  it('build.mjs --with-windows-helper exits 1 for a debug helper, before it cleans or builds anything', () => {
    const r = winBuildJs(winBuild(Buffer.from('serve --backend software software-test')));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--with-windows-helper: .*DEBUG helper/);
  });

  const REL = process.env.SUVEREN_WINDOWS_HELPER_RELEASE, DBG = process.env.SUVEREN_WINDOWS_HELPER_DEBUG;
  it.skipIf(!REL)('the real release build passes the check', () => { expect(checkWindowsHelperBuild(REL!)).toEqual([]); });
  it.skipIf(!DBG)('the real debug build is refused', () => { expect(checkWindowsHelperBuild(DBG!).join('\n')).toMatch(/DEBUG helper/); });
});
