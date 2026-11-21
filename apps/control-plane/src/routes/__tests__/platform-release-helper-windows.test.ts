/**
 * The RELEASE Windows helper (packages/unlock-helper/windows/build.mjs), started the way the gateway starts it: found by
 * `locateHelper` in helper/windows-<arch>, hashed against the gateway's own list, its list of callers written beside
 * the .exe, then `hello`. The Windows sibling of platform-release-helper.test.ts.
 *
 * Runs only on 64-bit Windows with SUVEREN_WINDOWS_HELPER_RELEASE naming the output folder of build.mjs (the Windows CI
 * job sets it); otherwise skipped. What it shows on a real Windows machine: the helper's parent check (image path,
 * command line and environment of the parent, read from Windows) accepts the gateway's own plain node process, and
 * refuses any other. What it cannot show: Windows Hello. Until that is measured on real hardware the release helper
 * reports `tpm-platform-crypto-unmeasured` and no secure hardware, and the gateway keeps the password (DESIGN.md 8).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { cpSync, existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpDir } from '../../__tests__/helpers/device-rig';
import { WINDOWS_HELPER_EXECUTABLE, WINDOWS_HELPER_CALLERS_FILE } from '../../lib/platform-helper';

const BUILD = process.env.SUVEREN_WINDOWS_HELPER_RELEASE;
const ARCH = process.arch;
const run = describe.skipIf(!BUILD || process.platform !== 'win32' || (ARCH !== 'x64' && ARCH !== 'arm64') || !existsSync(join(BUILD ?? 'C:\\nonexistent', `windows-${ARCH}`)));
const CP = fileURLToPath(new URL('../../../', import.meta.url));

let gatewayDir = '';
beforeAll(() => {
  if (!BUILD || process.platform !== 'win32') return;
  gatewayDir = tmpDir();
  // tsup by its entry script: `npx` is a .cmd on Windows and needs a shell.
  const tsup = join(CP, 'node_modules', 'tsup', 'dist', 'cli-default.js');
  const r = spawnSync(process.execPath, [tsup, 'src/lib/platform-helper.ts', '--format', 'esm', '--out-dir', gatewayDir, '--no-dts'], { cwd: CP, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tsup failed: ${r.stderr}`);
  writeFileSync(join(gatewayDir, 'main.mjs'), `
    import { PlatformHelper, locateHelper } from './platform-helper.mjs';
    const host = new PlatformHelper({ locate: () => locateHelper({ here: process.argv[2], env: {} }) });
    console.log(JSON.stringify(await host.status()));
    host.close();`);
}, 120_000);

/** A copy of the build laid out like the package: helper/windows-<arch>/ and dist/control-plane/helper-manifest-windows-<arch>.json. */
function install() {
  const root = tmpDir();
  const here = join(root, 'dist', 'control-plane');
  const folder = join(root, 'helper', `windows-${ARCH}`);
  mkdirSync(here, { recursive: true });
  mkdirSync(folder, { recursive: true });
  cpSync(join(BUILD!, `windows-${ARCH}`, WINDOWS_HELPER_EXECUTABLE), join(folder, WINDOWS_HELPER_EXECUTABLE));
  cpSync(join(BUILD!, `helper-manifest-windows-${ARCH}.json`), join(here, `helper-manifest-windows-${ARCH}.json`));
  return { here, folder };
}
const asGateway = (here: string) => {
  const r = spawnSync(process.execPath, [join(gatewayDir, 'main.mjs'), here], { encoding: 'utf8' });
  return JSON.parse(r.stdout) as { available: boolean; reason?: string; backend?: string; platform?: string; secureHardware?: boolean };
};

run('the release Windows helper, started like the gateway starts it', () => {
  it('is found, hashed, accepted as the gateway\'s helper, and says it has no secure hardware until Hello is measured', () => {
    const { here, folder } = install();
    const s = asGateway(here);
    expect(s).toMatchObject({ available: false, reason: 'no_secure_hardware', platform: 'windows', backend: 'tpm-platform-crypto-unmeasured' });
    expect(existsSync(join(folder, WINDOWS_HELPER_CALLERS_FILE))).toBe(true);
  });

  it('accepts the gateway started with its entry script relative to its working folder (as `node apps/control-plane/dist/index.mjs`)', () => {
    const { here } = install();
    // the helper is started from another folder, so only the parent's own working folder resolves the script
    const r = spawnSync(process.execPath, ['main.mjs', here], { cwd: gatewayDir, encoding: 'utf8' });
    expect(JSON.parse(r.stdout)).toMatchObject({ platform: 'windows', reason: 'no_secure_hardware' });
  });

  it('refuses a binary that is not the one in the gateway\'s list, and starts again once it is restored', () => {
    const { here, folder } = install();
    const exe = join(folder, WINDOWS_HELPER_EXECUTABLE);
    const original = readFileSync(exe);
    appendFileSync(exe, 'x');
    expect(asGateway(here)).toMatchObject({ available: false, reason: 'helper_modified' });
    writeFileSync(exe, original);
    expect(asGateway(here)).toMatchObject({ platform: 'windows', reason: 'no_secure_hardware' });
  });

  it('serves no other program: a node program that is not in the list of callers is refused (exit 77)', () => {
    const { folder } = install();
    const code = `
      const { spawn } = require('node:child_process');
      const c = spawn(${JSON.stringify(join(folder, WINDOWS_HELPER_EXECUTABLE))}, ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
      let out = '';
      c.stdout.on('data', d => out += d);
      c.stdin.on('error', () => {});
      c.stdin.write(JSON.stringify({ id: 1, op: 'hello' }) + '\\n');
      c.on('exit', code => { console.log(JSON.stringify({ code, out })); });
      setTimeout(() => c.stdin.end(), 1500);`;
    const none = JSON.parse(spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' }).stdout);
    expect(none.code).toBe(77);
    // `node -e`: the parent has no script inside a gateway install, whatever the list says
    writeFileSync(join(folder, WINDOWS_HELPER_CALLERS_FILE), JSON.stringify({ v: 1, callers: [{ exe: process.execPath, scriptPrefix: folder }] }));
    const other = JSON.parse(spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' }).stdout);
    expect(other.code).toBe(77);
    expect(other.out).not.toContain('"ok":true');
    // and a release helper takes no test switches: --allow-any-caller is ignored, the caller is still refused
    const sw = code.replace("['serve']", "['serve', '--allow-any-caller', '--backend', 'software']");
    expect(JSON.parse(spawnSync(process.execPath, ['-e', sw], { encoding: 'utf8' }).stdout).code).toBe(77);
  });
});
