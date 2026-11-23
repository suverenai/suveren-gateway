/**
 * The RELEASE helper (an ad-hoc signed Suveren.app made by packages/unlock-helper/macos/build-app.sh), started
 * the way the gateway starts it: found by `locateHelper`, hashed against the gateway's own list, its list of
 * callers written, then `hello`. NO touch is asked and no key is made: only what needs no touch.
 *
 * The control plane's own code (lib/platform-helper.ts) is compiled with tsup into a temp folder and run by a
 * plain `node main.mjs` there, because the release helper serves only a plain node program whose entry script
 * is in the folder its list names (vitest's workers start with `--conditions`, so they would be refused, which
 * is the point of that rule). Runs only when SUVEREN_HELPER_BUILD names the output folder of build-app.sh
 * (Suveren.app and helper-manifest.json); otherwise skipped. A release build has no software backend and no
 * --allow-any-caller, so this is the real Secure Enclave helper.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { cpSync, existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpDir } from '../../__tests__/helpers/device-rig';
import { HELPER_EXECUTABLE, HELPER_CALLERS_FILE } from '../../lib/platform-helper';

const BUILD = process.env.SUVEREN_HELPER_BUILD;
const run = describe.skipIf(!BUILD || process.platform !== 'darwin' || process.arch !== 'arm64' || !existsSync(join(BUILD ?? '/nonexistent', 'Suveren.app')));
const CP = fileURLToPath(new URL('../../../', import.meta.url));

let gatewayDir = '';
beforeAll(() => {
  if (!BUILD) return;
  gatewayDir = tmpDir();
  const r = spawnSync('npx', ['tsup', 'src/lib/platform-helper.ts', '--format', 'esm', '--out-dir', gatewayDir, '--no-dts'], { cwd: CP, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tsup failed: ${r.stderr}`);
  writeFileSync(join(gatewayDir, 'main.mjs'), `
    import { PlatformHelper, locateHelper } from './platform-helper.mjs';
    const host = new PlatformHelper({ platform: 'darwin',  locate: () => locateHelper({ here: process.argv[2], env: {} }) });
    console.log(JSON.stringify(await host.status()));
    host.close();`);
}, 120_000);

/** A copy of the build laid out like the package: helper/Suveren.app and dist/control-plane/helper-manifest.json. */
function install() {
  const root = tmpDir();
  const here = join(root, 'dist', 'control-plane');
  mkdirSync(here, { recursive: true });
  mkdirSync(join(root, 'helper'), { recursive: true });
  cpSync(join(BUILD!, 'Suveren.app'), join(root, 'helper', 'Suveren.app'), { recursive: true });
  cpSync(join(BUILD!, 'helper-manifest.json'), join(here, 'helper-manifest.json'));
  return { here, app: join(root, 'helper', 'Suveren.app') };
}
/** The control plane's code in a plain node process, as the gateway runs it. */
const asGateway = (here: string) => {
  const r = spawnSync(process.execPath, [join(gatewayDir, 'main.mjs'), here], { encoding: 'utf8' });
  return JSON.parse(r.stdout) as { available: boolean; reason?: string; backend?: string; platform?: string };
};

run('the release helper, started like the gateway starts it', () => {
  it('is found, hashed, started for the gateway process, and says what this computer has', () => {
    const { here, app } = install();
    // On a Mac with a Secure Enclave: available. On a virtual machine (CI) the helper still starts and answers
    // (hashes and caller accepted) and says it has no secure hardware: also fine here, it is what is checked.
    const s = asGateway(here);
    expect(s).toMatchObject({ platform: 'macos', backend: 'secure-enclave' });
    expect(s.available || s.reason === 'no_secure_hardware').toBe(true);
    // the list of callers was written beside the helper; the bundle still verifies with it there
    expect(existsSync(resolve(app, HELPER_CALLERS_FILE))).toBe(true);
    const v = spawnSync('codesign', ['--verify', '--strict', '--deep', app], { encoding: 'utf8' });
    expect(v.status, v.stderr).toBe(0);
  });

  it('refuses a binary that is not the one in the gateway\'s list, and starts again once it is restored', () => {
    const { here, app } = install();
    const exe = join(app, HELPER_EXECUTABLE);
    const original = readFileSync(exe);
    appendFileSync(exe, 'x');
    expect(asGateway(here)).toMatchObject({ available: false, reason: 'helper_modified' });
    writeFileSync(exe, original);
    expect(asGateway(here)).toMatchObject({ platform: 'macos', backend: 'secure-enclave' });   // started again
    // a missing file is "not installed", not "fine"
    const { here: here2, app: app2 } = install();
    writeFileSync(join(app2, 'Contents', 'Info.plist'), '<plist/>');
    expect(asGateway(here2)).toMatchObject({ available: false, reason: 'helper_modified' });
  });

  it('serves no other program: a node program that is not in the list of callers is refused (exit 77), with no list and with another list', () => {
    const { app } = install();
    const code = `
      const { spawn } = require('node:child_process');
      const c = spawn(${JSON.stringify(join(app, HELPER_EXECUTABLE))}, ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
      let out = '';
      c.stdout.on('data', d => out += d);
      c.stdin.on('error', () => {});
      c.stdin.write(JSON.stringify({ id: 1, op: 'hello' }) + '\\n');
      // The timer only ends stdin for a helper that serves; a refusing helper exits at once and must not wait for it.
      const t = setTimeout(() => c.stdin.end(), 1500);
      c.on('exit', code => { clearTimeout(t); console.log(JSON.stringify({ code, out })); });`;
    const none = JSON.parse(spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' }).stdout);
    expect(none.code).toBe(77);
    writeFileSync(resolve(app, HELPER_CALLERS_FILE), JSON.stringify({ v: 1, callers: [{ exe: process.execPath, scriptPrefix: '/nonexistent/gateway' }] }));
    const other = JSON.parse(spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' }).stdout);
    expect(other.code).toBe(77);
    expect(other.out).not.toContain('"ok":true');
  });
});
