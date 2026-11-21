import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Serves / builds the bare fixture page for the shared approval card.
//   pnpm --filter @suveren/approval-card fixture        (dev server)
//   pnpm --filter @suveren/approval-card fixture:build  (static files in fixture/dist)
// The dev port is not in any lane of the machine map; pick another if it is taken.
const root = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  // The gateway page's static files (fonts), so the fixture draws the same type.
  publicDir: fileURLToPath(new URL('../../../apps/ui/public', import.meta.url)),
  server: { port: 5199, open: false },
  build: { outDir: 'fixture/dist', emptyOutDir: true, rollupOptions: { input: fileURLToPath(new URL('./index.html', import.meta.url)) } },
});
