import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3002',
  },
  webServer: [
    {
      // 1. Start the SP (demo-sp) on port 4100
      command: 'npm run dev',
      cwd: '../demo-sp',
      url: 'http://localhost:4100',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      // 2. Start the control plane on port 3000, pointed at local SP
      command: 'pnpm dev:control',
      url: 'http://localhost:3000/health',
      reuseExistingServer: true,
      timeout: 30_000,
      env: {
        SUVEREN_AS_URL: 'http://localhost:4100',
      },
    },
    {
      // 3. Start the UI dev server on port 3002
      command: 'pnpm dev:ui',
      url: 'http://localhost:3002',
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
