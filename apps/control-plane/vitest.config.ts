import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Everything else stays at vitest's defaults (test file globs, environment,
// …) — this config exists solely to load vitest.setup.ts before every test
// file. See that file's doc comment for why.
export default defineConfig({
  // The tests run the helper client from its source, so they do not depend on a built dist.
  resolve: { alias: { '@suveren/unlock-helper': fileURLToPath(new URL('../../packages/unlock-helper/src/index.ts', import.meta.url)) } },
  test: {
    setupFiles: ['./vitest.setup.ts'],
  },
});
