#!/usr/bin/env node
// Manual check of the GATEWAY'S OWN CODE with the REAL release helper and the REAL Secure Enclave.
// It asks for Touch ID four times, so it never runs in tests. Run from the repository root, after
//   pnpm -r build && packages/unlock-helper/macos/build-app.sh
//   node packages/unlock-helper/macos/manual-check-gateway.mjs
// It compiles the control plane's helper code into apps/control-plane/.manual-check/ (ignored by git) and runs it
// as a plain node program there, which is what the helper's caller check needs. It uses a throw-away vault in the
// system temp folder and your real Secure Enclave; it never touches a real gateway's data folder. Prints PASS / FAIL
// lines and the text each prompt showed; never a key. Keys live in memory (the check key) and in the throw-away vault.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cp = join(root, 'apps/control-plane');
const app = join(root, 'packages/unlock-helper/macos/dist/Suveren.app');
if (!existsSync(app)) { console.error('FAIL  no helper: run packages/unlock-helper/macos/build-app.sh first'); process.exit(1); }
if (!existsSync(join(root, 'packages/hap-core/dist'))) { console.error('FAIL  run pnpm -r build first'); process.exit(1); }

const out = join(cp, '.manual-check');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const b = spawnSync('npx', ['tsup', 'src/lib/vault.ts', 'src/lib/platform-helper.ts', 'src/lib/platform-checks.ts', '--format', 'esm', '--out-dir', out, '--no-dts'], { cwd: cp, encoding: 'utf8' });
if (b.status !== 0) { console.error('FAIL  could not compile the control plane code:\n' + b.stderr); process.exit(1); }

writeFileSync(join(out, 'run.mjs'), `
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from './vault.mjs';
import { PlatformHelper, locateHelper, unlockKeyService } from './platform-helper.mjs';
import { PlatformChecks } from './platform-checks.mjs';

let failed = 0;
const report = (ok, what) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + what); if (!ok) failed++; };
const host = new PlatformHelper({ locate: () => locateHelper({ here: ${JSON.stringify(out)}, env: { SUVEREN_HELPER_APP: ${JSON.stringify(app)} } }), idleMs: 600000 });
const s = await host.status();
console.log('helper:', JSON.stringify(s));
report(s.available === true && s.backend === 'secure-enclave', 'the release helper starts for this program (hashes match, caller accepted)');
if (!s.available) process.exit(1);

const dir = mkdtempSync(join(tmpdir(), 'suveren-manual-check-'));
const fast = { scrypt: { N: 1024, r: 8, p: 1 } };
try {
  const v1 = new Vault(dir, { ...fast, deviceKeys: true });
  await v1.createWithPassword('a long throw-away password', 'manual-check');
  v1.setPlatformService(unlockKeyService(host), { hasCheckKey: () => false, check: async () => {} });   // a throw-away vault has no check key
  const keyHex = v1.getVaultKeyHex();

  console.log('\\n>>> TOUCH 1 of 4 (turning unlock on): the prompt should say "... is trying to unlock the Suveren vault".');
  await v1.enablePlatformUnlock('a long throw-away password');
  report(v1.hasPlatformUnlock(), 'unlock by Touch ID is on (the test unwrap opened the wrap)');

  console.log('\\n>>> TOUCH 2 of 4 (a restart: a new vault object, locked): the same prompt text. Touch the sensor.');
  const v2 = new Vault(dir, { ...fast, deviceKeys: true });
  v2.setPlatformService(unlockKeyService(host), null);
  report(!v2.isUnlocked(), 'the new vault object is locked');
  await v2.unlockWithPlatform();
  report(v2.isUnlocked() && v2.getVaultKeyHex() === keyHex, 'Touch ID opened the vault with the same key, no password typed');
  report(await new Vault(dir, { ...fast, deviceKeys: true }).unlockWithPassword('a long throw-away password'), 'the password still opens it');

  const checks = new PlatformChecks(host);
  const key = await checks.createKey();
  const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
  console.log('\\n>>> TOUCH 3 of 4 (a change to a connector login): the prompt should say "... is trying to replace the login of \\"gmail\\"". Touch ID only.');
  const a = await checks.sign(key, enc({ request_id: 'manual', kind: 'replace', name: 'gmail', change_hash: 'x', gateway_key_id: null, expires_at: 1 }));
  report(a.reason === 'replace the login of "gmail"', 'signed after the touch; the helper says it showed: "' + a.reason + '" (hap-core verified the signature)');

  console.log('\\n>>> TOUCH 4 of 4 (setting up this computer): the prompt should say "... is trying to set up the device \\"This computer\\" with its own key".');
  const g = await checks.sign(key, enc({ typ: 'suveren-chain-entry', op: 'genesis', seq: 0, device: { label: 'This computer' }, check: null }));
  report(g.reason.startsWith('set up the device'), 'signed after the touch; the helper says it showed: "' + g.reason + '"');
} catch (e) {
  report(false, 'stopped: ' + (e && (e.code || e.name)) + (e && e.helperCode ? ' / ' + e.helperCode : ''));
} finally {
  host.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
`);

const r = spawnSync(process.execPath, [join(out, 'run.mjs')], { stdio: 'inherit' });
rmSync(out, { recursive: true, force: true });
process.exit(r.status ?? 1);
