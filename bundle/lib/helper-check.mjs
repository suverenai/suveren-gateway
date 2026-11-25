/**
 * Is this build of the native helper fit to ship? (device-keys step 5a; packages/unlock-helper/DESIGN.md)
 *
 * A DEBUG helper has a software key backend and `--allow-any-caller` compiled in: it serves any program and
 * keeps keys in plain files' worth of memory. It must never go into the npm package. The release build
 * compiles all of that out (`#if DEBUG`), so these strings are absent from it; any of them in the binary
 * means a debug build. Checked on the bytes, not on a flag or a folder name.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEBUG_MARKERS = ['software-test', '--allow-any-caller', '--allowed-callers', '--backend'];

/** The debug markers found in a binary (empty: a release build). */
export function debugMarkersIn(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  return DEBUG_MARKERS.filter((m) => text.includes(m));
}

/**
 * Checks a folder made by packages/unlock-helper/macos/build-app.sh: the app and the list of hashes are there,
 * every file matches the list, and the executable is a release build. Returns a list of problems (empty: fine).
 */
export function checkHelperBuild(dir) {
  const problems = [];
  const app = join(dir, 'Suveren.app');
  const manifestPath = join(dir, 'helper-manifest.json');
  if (!existsSync(app)) problems.push(`${app} is missing. Run packages/unlock-helper/macos/build-app.sh first.`);
  if (!existsSync(manifestPath)) problems.push(`${manifestPath} is missing. Run packages/unlock-helper/macos/build-app.sh first.`);
  if (problems.length) return problems;
  const exe = join(app, 'Contents', 'MacOS', 'suveren-unlock-helper');
  if (!existsSync(exe)) return [`${exe} is missing.`];
  const found = debugMarkersIn(readFileSync(exe));
  if (found.length) problems.push(`${exe} is a DEBUG helper (it contains ${found.join(', ')}). Only a release build may ship: run packages/unlock-helper/macos/build-app.sh without CONFIG=debug.`);
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { return [...problems, `${manifestPath} is not readable.`]; }
  const files = manifest?.files;
  if (manifest?.v !== 1 || !files || typeof files !== 'object' || !('Contents/MacOS/suveren-unlock-helper' in files)) return [...problems, `${manifestPath} is not a helper manifest.`];
  for (const [rel, want] of Object.entries(files)) {
    const p = join(app, rel);
    if (!existsSync(p) || createHash('sha256').update(readFileSync(p)).digest('hex') !== want) problems.push(`${p} does not match helper-manifest.json (rebuild with build-app.sh).`);
  }
  return problems;
}

export const WINDOWS_ARCHS = ['x64', 'arm64'];
/** The capability string only the shipped-off (unmeasured) Windows build carries (tpm_windows.go). */
export const UNMEASURED_MARKER = 'tpm-platform-crypto-unmeasured';

/**
 * Checks a folder made by packages/unlock-helper/windows/build.mjs: for each architecture the .exe and its hash list
 * are there, the .exe matches the list, and it is a release build. Returns a list of problems (empty: fine).
 */
export function checkWindowsHelperBuild(dir) {
  const problems = [];
  for (const arch of WINDOWS_ARCHS) {
    const exe = join(dir, `windows-${arch}`, 'suveren-unlock-helper.exe');
    const manifestPath = join(dir, `helper-manifest-windows-${arch}.json`);
    if (!existsSync(exe) || !existsSync(manifestPath)) {
      problems.push(`${exe} or ${manifestPath} is missing. Run node packages/unlock-helper/windows/build.mjs first.`);
      continue;
    }
    const bytes = readFileSync(exe);
    const found = debugMarkersIn(bytes);
    if (found.length) problems.push(`${exe} is a DEBUG helper (it contains ${found.join(', ')}). Only a release build may ship: run build.mjs without CONFIG=debug.`);
    // DEC-99 / DESIGN.md section 8: until Windows Hello is measured on a real machine, only the build that reports
    // "no secure hardware" may ship. A `-tags hellomeasured` build lacks this marker and is refused here.
    if (!bytes.includes(Buffer.from(UNMEASURED_MARKER))) problems.push(`${exe} is not the unmeasured build (it lacks "${UNMEASURED_MARKER}"). Windows Hello is not verified yet (DEC-99): build without -tags hellomeasured.`);
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { problems.push(`${manifestPath} is not readable.`); continue; }
    const files = manifest?.files;
    if (manifest?.v !== 1 || !files || typeof files !== 'object' || Object.keys(files).join() !== 'suveren-unlock-helper.exe') { problems.push(`${manifestPath} is not a Windows helper manifest.`); continue; }
    if (createHash('sha256').update(bytes).digest('hex') !== files['suveren-unlock-helper.exe']) problems.push(`${exe} does not match ${manifestPath} (rebuild with build.mjs).`);
  }
  return problems;
}
