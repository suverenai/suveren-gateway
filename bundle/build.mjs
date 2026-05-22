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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const buildApps = process.argv.includes('--build-apps');

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

// Ship integration manifests so the UI's Integrations page works
// out of the box (Docker copies these too via COPY content/integrations/).
const MANIFESTS_SRC = join(REPO_ROOT, 'content/integrations');
if (existsSync(MANIFESTS_SRC)) {
  cpSync(MANIFESTS_SRC, join(OUT, 'content', 'integrations'), { recursive: true });
}

// Ship the profile catalog. Docker `git clone`s hap-profiles into
// /hap-profiles; for the npm bundle we resolve it from a sibling
// checkout (HAP_PROFILES_DIR override always wins at runtime).
const PROFILES_SRC = join(REPO_ROOT, '..', 'hap-profiles');
if (existsSync(PROFILES_SRC)) {
  cpSync(PROFILES_SRC, join(OUT, 'profiles'), {
    recursive: true,
    filter: (src) => !src.includes('/.git') && !src.includes('/test-results'),
  });
}

// Copy bundle scaffold (CLI + production entry + scripts).
cpSync(join(__dirname, 'server.js'),         join(OUT, 'server.js'));
cpSync(join(__dirname, 'bin', 'suveren-gateway.js'), join(OUT, 'bin', 'suveren-gateway.js'));
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
