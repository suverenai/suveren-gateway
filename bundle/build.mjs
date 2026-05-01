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
 *   bundle/bin/hap-gateway.js
 *   package.json (root — for version)
 *
 * Writes:
 *   bundle/dist/
 *     ├── package.json
 *     ├── server.js
 *     ├── bin/hap-gateway.js
 *     ├── dist/ui/
 *     ├── dist/control-plane/
 *     └── dist/mcp-server/
 *
 * Usage:
 *   node bundle/build.mjs                   # assume apps already built
 *   node bundle/build.mjs --build-apps      # also run pnpm build for each app
 *
 * From there:
 *   cd bundle/dist && npm install && node bin/hap-gateway.js start
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

// Copy bundle scaffold (CLI + production entry).
cpSync(join(__dirname, 'server.js'),         join(OUT, 'server.js'));
cpSync(join(__dirname, 'bin', 'hap-gateway.js'), join(OUT, 'bin', 'hap-gateway.js'));
chmodSync(join(OUT, 'bin', 'hap-gateway.js'), 0o755);
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
// Also declare the canonical name so it's installed under its real name
// for any consumer that imports it directly.
aggregate['@humanagencyp/hap-core'] = corePin;

const tpl = JSON.parse(readFileSync(TPL, 'utf8'));
tpl.version = rootPkg.version ?? '0.0.0';
tpl.dependencies = aggregate;

writeFileSync(join(OUT, 'package.json'), JSON.stringify(tpl, null, 2) + '\n', 'utf8');

console.log(`[bundle] ✓ wrote ${OUT}`);
console.log(`[bundle]   version:       ${tpl.version}`);
console.log(`[bundle]   deps:          ${Object.keys(aggregate).join(', ')}`);
console.log(`[bundle]
[bundle] To smoke-test:
[bundle]   cd ${OUT} && npm install --omit=dev && node bin/hap-gateway.js start
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
