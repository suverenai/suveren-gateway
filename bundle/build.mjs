#!/usr/bin/env node
/**
 * Assemble the publishable npm bundle in bundle/dist/.
 *
 * Reads:
 *   apps/ui/dist/                  (Vite production build)
 *   apps/control-plane/dist/       (tsup output)
 *   apps/mcp-server/dist/          (tsup output)
 *   apps/control-plane/package.json (for runtime deps)
 *   apps/mcp-server/package.json    (for runtime deps)
 *   bundle/package.json.tpl
 *   bundle/server.js
 *   bundle/bin/suveren-gateway.js
 *   package.json (root — for version)
 *
 * Writes:
 *   bundle/dist/
 *     ├── package.json
 *     ├── server.js
 *     ├── bin/suveren-gateway.js
 *     ├── dist/ui/
 *     ├── dist/control-plane/
 *     └── dist/mcp-server/
 *
 * Usage:
 *   node bundle/build.mjs                   # assume apps already built
 *   node bundle/build.mjs --build-apps      # also run pnpm build for each app
 *
 * From there:
 *   cd bundle/dist && npm install && node bin/suveren-gateway.js start
 *   cd bundle/dist && npm publish --access public
 */

import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHelperBuild, checkWindowsHelperBuild, WINDOWS_ARCHS } from './lib/helper-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const buildApps = process.argv.includes('--build-apps');

// The native helper (opt-in) is checked FIRST, before anything is cleaned or built: a debug helper (software keys,
// serves any caller) or a file that does not match its hash list never goes into the package.
const withHelper = process.argv.includes('--with-helper');
const HELPER_BUILT = process.env.SUVEREN_HELPER_BUILD_DIR ?? join(REPO_ROOT, 'packages/unlock-helper/macos/dist');
if (withHelper) {
  const problems = checkHelperBuild(HELPER_BUILT);
  if (problems.length) {
    for (const p of problems) console.error(`[bundle] --with-helper: ${p}`);
    process.exit(1);
  }
}
// The Windows helper (opt-in), from packages/unlock-helper/windows/build.mjs: the same checks.
const withWindowsHelper = process.argv.includes('--with-windows-helper');
const WINDOWS_HELPER_BUILT = process.env.SUVEREN_WINDOWS_HELPER_BUILD_DIR ?? join(REPO_ROOT, 'packages/unlock-helper/windows/dist');
if (withWindowsHelper) {
  const problems = checkWindowsHelperBuild(WINDOWS_HELPER_BUILT);
  if (problems.length) {
    for (const p of problems) console.error(`[bundle] --with-windows-helper: ${p}`);
    process.exit(1);
  }
}

const SRC = {
  ui: join(REPO_ROOT, 'apps/ui/dist'),
  cp:  join(REPO_ROOT, 'apps/control-plane/dist'),
  mcp: join(REPO_ROOT, 'apps/mcp-server/dist'),
};
const PKG_JSON = {
  cp:  join(REPO_ROOT, 'apps/control-plane/package.json'),
  mcp: join(REPO_ROOT, 'apps/mcp-server/package.json'),
};
const ROOT_PKG = join(REPO_ROOT, 'package.json');

const OUT = join(__dirname, 'dist');
const TPL = join(__dirname, 'package.json.tpl');

console.log('[bundle] assembling …');

if (buildApps) {
  console.log('[bundle] running pnpm build for each app');
  for (const appDir of ['apps/ui', 'apps/control-plane', 'apps/mcp-server']) {
    execSync('pnpm build', { cwd: join(REPO_ROOT, appDir), stdio: 'inherit' });
  }
}

for (const [name, dir] of Object.entries(SRC)) {
  if (!existsSync(dir)) {
    console.error(`[bundle] missing ${name} build at ${dir}. Run with --build-apps or \`pnpm build\` first.`);
    process.exit(1);
  }
}

// Clean output dir.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'dist'), { recursive: true });
mkdirSync(join(OUT, 'bin'), { recursive: true });

// Copy app dist trees.
cpSync(SRC.ui,  join(OUT, 'dist', 'ui'),            { recursive: true });
cpSync(SRC.cp,  join(OUT, 'dist', 'control-plane'), { recursive: true });
cpSync(SRC.mcp, join(OUT, 'dist', 'mcp-server'),    { recursive: true });

// ─── Native Touch ID helper (device-keys step 5a; opt-in) ───────────────────
// macOS on Apple silicon only: an ad-hoc signed Suveren.app and the hashes of its files. The app goes
// to helper/, the hashes into the control plane's own folder (NOT beside the helper): the gateway
// refuses a helper file that does not match them. Build it first:
//   packages/unlock-helper/macos/build-app.sh
// Without --with-helper nothing changes: the package carries no helper, and the gateway says so
// ("no helper here") and works with the password, as before.
if (withHelper) {
  const built = HELPER_BUILT;   // checked above
  cpSync(join(built, 'Suveren.app'), join(OUT, 'helper', 'Suveren.app'), { recursive: true });
  cpSync(join(built, 'helper-manifest.json'), join(OUT, 'dist', 'control-plane', 'helper-manifest.json'));
  chmodSync(join(OUT, 'helper', 'Suveren.app', 'Contents', 'MacOS', 'suveren-unlock-helper'), 0o755);
  console.log('[bundle] ✓ native helper (Suveren.app) included');
}
// Windows: helper/windows-<arch>/suveren-unlock-helper.exe, its hashes in the control plane's folder (not beside it).
// Until Windows Hello is measured (DESIGN.md section 8) this helper says "no secure hardware" and the password stays.
if (withWindowsHelper) {
  for (const arch of WINDOWS_ARCHS) {
    cpSync(join(WINDOWS_HELPER_BUILT, `windows-${arch}`, 'suveren-unlock-helper.exe'), join(OUT, 'helper', `windows-${arch}`, 'suveren-unlock-helper.exe'));
    cpSync(join(WINDOWS_HELPER_BUILT, `helper-manifest-windows-${arch}.json`), join(OUT, 'dist', 'control-plane', `helper-manifest-windows-${arch}.json`));
  }
  console.log('[bundle] ✓ Windows helper (x64, arm64) included');
}

// Ship integration manifests so the UI's Integrations page works
// out of the box (Docker copies these too via COPY content/integrations/).
const MANIFESTS_SRC = join(REPO_ROOT, 'content/integrations');
if (existsSync(MANIFESTS_SRC)) {
  cpSync(MANIFESTS_SRC, join(OUT, 'content', 'integrations'), { recursive: true });
}

// Ship the default setup guides (setup__get_guide, simulation setup S10).
// The Windows payload is built from this bundle, so it gets them too.
const GUIDES_SRC = join(REPO_ROOT, 'content/guides');
if (existsSync(GUIDES_SRC)) {
  cpSync(GUIDES_SRC, join(OUT, 'content', 'guides'), { recursive: true });
}

// Ship the profile catalog. Docker `git clone`s hap-profiles into
// /hap-profiles; for the npm bundle we resolve it from HAP_PROFILES_SRC
// (set by CI) or a sibling checkout (local dev). Without profiles the
// gateway registers ZERO profiles and every gated action fails with
// "Unknown profile" — so the guard below makes a missing source a hard
// build error instead of a silently-empty package (the 0.2.8 bug).
const PROFILES_SRC = process.env.HAP_PROFILES_SRC ?? join(REPO_ROOT, '..', 'hap-profiles');
if (existsSync(PROFILES_SRC)) {
  cpSync(PROFILES_SRC, join(OUT, 'profiles'), {
    recursive: true,
    filter: (src) => !src.includes('/.git') && !src.includes('/test-results'),
  });
}

// ─── Guard: essential catalogs MUST be present, or fail the build ──────────
// These ship empty only when a CI input is missing; a silent skip here once
// published a profile-less package. Fail loudly instead.
for (const [label, indexPath, hint] of [
  ['profiles', join(OUT, 'profiles', 'index.json'),
    `set HAP_PROFILES_SRC or check out hap-profiles next to the gateway (looked in ${PROFILES_SRC})`],
  ['integration manifests', join(OUT, 'content', 'integrations', 'index.json'),
    `expected ${MANIFESTS_SRC} to exist in-repo`],
  ['setup guides', join(OUT, 'content', 'guides', '1-interview.md'),
    `expected ${GUIDES_SRC} to exist in-repo`],
]) {
  if (!existsSync(indexPath)) {
    throw new Error(
      `[bundle] Missing ${label}: ${indexPath} not found. The bundle would ship ` +
      `incomplete and the gateway would reject every gated action. Fix: ${hint}.`,
    );
  }
}

// Copy bundle scaffold (CLI + production entry + scripts).
cpSync(join(__dirname, 'server.js'),         join(OUT, 'server.js'));
cpSync(join(__dirname, 'bin', 'suveren-gateway.js'), join(OUT, 'bin', 'suveren-gateway.js'));
// The CLI imports ../lib/autostart-templates.mjs — without this the bundled
// binary throws ERR_MODULE_NOT_FOUND on startup.
cpSync(join(__dirname, 'lib'), join(OUT, 'lib'), { recursive: true });
cpSync(join(__dirname, 'scripts'), join(OUT, 'scripts'), { recursive: true });
chmodSync(join(OUT, 'bin', 'suveren-gateway.js'), 0o755);
chmodSync(join(OUT, 'server.js'),                0o755);

// Optional README pass-through.
const rootReadme = join(REPO_ROOT, 'README.md');
if (existsSync(rootReadme)) cpSync(rootReadme, join(OUT, 'README.md'));

// ─── Render package.json from template + sources ────────────────────────

const rootPkg = JSON.parse(readFileSync(ROOT_PKG, 'utf8'));
const cpPkg   = JSON.parse(readFileSync(PKG_JSON.cp,  'utf8'));
const mcpPkg  = JSON.parse(readFileSync(PKG_JSON.mcp, 'utf8'));

// Aggregate runtime deps from CP + MCP. The workspace alias `@hap/core`
// is preserved as a key but rewritten to an npm-alias spec pointing at
// the published `@humanagencyp/hap-core`. That way the compiled
// `import from '@hap/core'` lines resolve at runtime without rewriting
// any JS — npm creates `node_modules/@hap/core` from the alias.
//
// We DO NOT also declare `@humanagencyp/hap-core` separately — the alias
// already pulls the same package. Declaring both makes npm fetch the
// manifest twice and resolve two trees for one package, wasting HTTPS
// round-trips.
const aggregate = {};
const corePin = readHapCoreVersionPin(REPO_ROOT) ?? '*';
for (const [name, ver] of Object.entries({ ...cpPkg.dependencies, ...mcpPkg.dependencies })) {
  if (name === '@hap/core') {
    aggregate['@hap/core'] = `npm:@humanagencyp/hap-core@${corePin}`;
  } else {
    // Prefer whichever is more specific (last writer wins is fine — both apps
    // tend to align since pnpm workspace dedupes).
    aggregate[name] = ver;
  }
}

const tpl = JSON.parse(readFileSync(TPL, 'utf8'));
tpl.version = rootPkg.version ?? '0.0.0';
tpl.dependencies = aggregate;
// Bundle every runtime dep into the published tarball. End users
// running `npm install -g @suveren/gateway` then extract a
// pre-populated node_modules without any further network fetches —
// install survives bad/flaky networks and finishes in seconds.
tpl.bundledDependencies = Object.keys(aggregate);

writeFileSync(join(OUT, 'package.json'), JSON.stringify(tpl, null, 2) + '\n', 'utf8');

// Pre-install the runtime deps so npm pack will include them via
// bundledDependencies. Skip if the dist already has node_modules from
// a prior smoke run (idempotent).
if (!existsSync(join(OUT, 'node_modules'))) {
  console.log('[bundle] installing runtime deps to embed in tarball …');
  execSync('npm install --omit=dev --no-audit --no-fund', {
    cwd: OUT,
    stdio: 'inherit',
  });
}

console.log(`[bundle] ✓ wrote ${OUT}`);
console.log(`[bundle]   version:       ${tpl.version}`);
console.log(`[bundle]   deps:          ${Object.keys(aggregate).join(', ')}`);
console.log(`[bundle]   bundled:       yes (deps shipped inside the tarball)`);
console.log(`[bundle]
[bundle] To smoke-test (no install needed — deps already present):
[bundle]   node ${OUT}/bin/suveren-gateway.js start
[bundle]
[bundle] To publish:
[bundle]   cd ${OUT} && npm publish --access public`);

// ─── Helpers ────────────────────────────────────────────────────────────

function readHapCoreVersionPin(root) {
  // The thin workspace wrapper at packages/hap-core/ should re-export the
  // npm-published @humanagencyp/hap-core; that wrapper's package.json
  // pins the version we expect at runtime.
  const wrapperPkg = join(root, 'packages/hap-core/package.json');
  if (!existsSync(wrapperPkg)) return null;
  const w = JSON.parse(readFileSync(wrapperPkg, 'utf8'));
  return w.dependencies?.['@humanagencyp/hap-core'] ?? null;
}
