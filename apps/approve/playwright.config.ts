import { defineConfig } from '@playwright/test';

// The card-parity test: the same mandate proposal on the gateway's card and in the phone app, real components and CSS, in Chromium.
//   npx playwright test -c apps/approve/playwright.config.ts          (from the repository root)
// Profiles: $SUVEREN_PROFILES_DIR or the hap-profiles checkout next to this repository. SHOTS_DIR=<dir> also writes screenshots.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.pw.ts',
  timeout: 60_000,
  retries: 0,
  use: { baseURL: 'http://localhost:5198' },
  webServer: {
    command: 'npx vite build --config fixture/vite.config.ts && npx vite preview --config fixture/vite.config.ts --port 5198 --strictPort',
    cwd: import.meta.dirname,
    url: 'http://localhost:5198/fixture/index.html',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
