#!/usr/bin/env node
/**
 * A real, npm-free stand-in for `npm` used by ensure-installed-pin.test.ts.
 *
 * Invoked exactly as the production code invokes real npm:
 *   npm install --no-fund --no-audit <spec>
 * with `cwd` set to the (temp) integrations directory. It writes a fake
 * package into node_modules/<pkg>/ at the requested version and a matching
 * node_modules/.bin/<binName> shim, so `isUsableInstall`/`readInstalledVersion`
 * in integration-manager.ts see a real, on-disk install — without ever
 * touching the real npm registry.
 *
 * Controlled by env vars (set by the test, read fresh on every invocation):
 *   FAKE_NPM_LOG  — if set, the exact spec installed is appended here (one
 *                   per line), so a test can assert whether npm was called
 *                   at all, and with what spec.
 *   FAKE_NPM_FAIL — if "1", exits non-zero without writing anything, so the
 *                   test can exercise the "update failed" path.
 */
import { writeFileSync, mkdirSync, appendFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const spec = args[args.length - 1];

if (process.env.FAKE_NPM_LOG) {
  appendFileSync(process.env.FAKE_NPM_LOG, `${spec}\n`);
}

if (process.env.FAKE_NPM_FAIL === '1') {
  process.stderr.write('fake-npm: simulated registry/network failure\n');
  process.exit(1);
}

// "pkg@version" / "@scope/pkg@version" / bare "pkg" / "@scope/pkg" — mirror
// how npm itself splits a spec, i.e. the LAST "@" that isn't the leading
// scope marker.
let pkg = spec;
let version = '0.0.1';
const atIdx = spec.lastIndexOf('@');
if (atIdx > 0) {
  pkg = spec.slice(0, atIdx);
  version = spec.slice(atIdx + 1);
}

const cwd = process.cwd(); // the integrations dir — real npm installs are also cwd-relative
const pkgDir = join(cwd, 'node_modules', ...pkg.split('/'));
const binDir = join(cwd, 'node_modules', '.bin');
mkdirSync(pkgDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

const binName = pkg.split('/').pop();
writeFileSync(join(pkgDir, 'index.js'), '// fake-npm fixture package entry\n');
writeFileSync(
  join(pkgDir, 'package.json'),
  JSON.stringify({ name: pkg, version, bin: { [binName]: 'index.js' }, main: 'index.js' }, null, 2),
);
const shimPath = join(binDir, binName);
writeFileSync(shimPath, '#!/usr/bin/env node\n// fake-npm fixture bin shim\n');
try { chmodSync(shimPath, 0o755); } catch { /* best-effort on platforms that ignore it */ }

process.exit(0);
