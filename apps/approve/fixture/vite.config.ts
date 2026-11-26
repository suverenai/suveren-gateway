import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CASES } from './cases';

// One page that draws the same mandate proposal on the gateway's approval card and in the phone app's give (real components, real CSS),
// for the parity test (e2e/card-parity.spec.ts). Profiles: $SUVEREN_PROFILES_DIR or the hap-profiles checkout next to this repository.
//   pnpm --filter @suveren/approve exec vite build --config fixture/vite.config.ts      (static files in fixture/dist)
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = [process.env.SUVEREN_PROFILES_DIR, join(root, '..', '..', '..', 'hap-profiles')].find((d) => d && existsSync(join(d, 'index.json')));
if (!dir) throw new Error('hap-profiles not found: set SUVEREN_PROFILES_DIR');
const profiles: Record<string, unknown> = {};
for (const c of CASES) profiles[`${c.folder}@${c.version}`] = JSON.parse(readFileSync(join(dir, c.folder, `${c.version}.profile.json`), 'utf8'));
profiles['delegation@0.6'] = JSON.parse(readFileSync(join(dir, 'delegation', '0.6.profile.json'), 'utf8'));

export default defineConfig({
  root,
  plugins: [react()],
  define: { __PROFILES__: JSON.stringify(profiles) },
  publicDir: join(root, 'public'),
  server: { port: 5198, open: false },
  build: { outDir: 'fixture/dist', emptyOutDir: true, rollupOptions: { input: join(root, 'fixture', 'index.html') } },
});
